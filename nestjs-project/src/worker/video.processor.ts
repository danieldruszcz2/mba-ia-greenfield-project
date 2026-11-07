import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import {
  QUEUE_NAMES,
  type ProcessVideoJobData,
} from '../queue/queue.constants';
import { StorageService } from '../storage/storage.service';
import { VideoStatus } from '../videos/entities/video.entity';
import { VideosRepository } from '../videos/videos.repository';
import { MediaProbeService } from './media-probe.service';
import {
  THUMBNAIL,
  thumbnailKey,
  thumbnailPosition,
  WORKER_FAILURE_REASONS,
} from './worker.constants';

const UNRECOVERABLE_ERROR_NAME = 'UnrecoverableError';

/**
 * Consumes `process-video`: probes the uploaded file, applies the codec gate,
 * stores a thumbnail and moves the video to `ready`. Final failures (codec
 * rejected, or every retry exhausted) move it to `failed`.
 */
@Processor(QUEUE_NAMES.VIDEO_PROCESSING)
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    private readonly videosRepository: VideosRepository,
    private readonly storageService: StorageService,
    private readonly mediaProbe: MediaProbeService,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    const video = await this.videosRepository.findById(job.data.videoId);
    if (!video) {
      this.logger.warn(`Video ${job.data.videoId} no longer exists; skipping`);
      return;
    }
    if (video.status === VideoStatus.READY) {
      return; // idempotent re-delivery
    }

    // The worker runs inside the Docker network, so it signs with the internal client.
    const { url } = await this.storageService.presignGetObject(
      video.storage_key,
      { client: 'internal' },
    );
    const { durationSeconds, metadata } = await this.mediaProbe.probe(url);
    this.mediaProbe.assertPlayable(metadata);

    const frame = await this.mediaProbe.extractFrame(
      url,
      thumbnailPosition(durationSeconds),
    );
    const key = thumbnailKey(video.id);
    await this.storageService.putObject(
      this.storageService.thumbnailsBucket,
      key,
      frame,
      THUMBNAIL.CONTENT_TYPE,
    );

    await this.videosRepository.update(video.id, {
      duration_seconds: durationSeconds,
      metadata,
      thumbnail_key: key,
      status: VideoStatus.READY,
      failure_reason: null,
    });
  }

  /**
   * Fires on every failed attempt; only the final one (unrecoverable error or
   * attempts exhausted) marks the video as `failed`.
   */
  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<ProcessVideoJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) return;
    const unrecoverable = error.name === UNRECOVERABLE_ERROR_NAME;
    const attemptsExhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!unrecoverable && !attemptsExhausted) return;

    const reason = unrecoverable
      ? WORKER_FAILURE_REASONS.UNPLAYABLE_CODEC
      : WORKER_FAILURE_REASONS.PROCESSING_FAILED;
    try {
      await this.videosRepository.update(job.data.videoId, {
        status: VideoStatus.FAILED,
        failure_reason: reason,
      });
      this.logger.warn(
        `Video ${job.data.videoId} failed (${reason}): ${error.message}`,
      );
    } catch (updateError) {
      // Background event handler: rethrowing would only crash the worker.
      this.logger.error(
        `Could not mark video ${job.data.videoId} as failed`,
        (updateError as Error).stack,
      );
    }
  }
}
