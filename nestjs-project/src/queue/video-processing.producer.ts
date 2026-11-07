import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import {
  JOB_NAMES,
  QUEUE_NAMES,
  type ProcessVideoJobData,
} from './queue.constants';

@Injectable()
export class VideoProcessingProducer {
  constructor(
    @InjectQueue(QUEUE_NAMES.VIDEO_PROCESSING)
    private readonly queue: Queue<ProcessVideoJobData>,
  ) {}

  /**
   * Idempotent: `jobId = videoId`, so enqueueing the same video twice while
   * the first job is still stored in Redis does not create a second job.
   */
  async enqueue(videoId: string): Promise<void> {
    await this.queue.add(
      JOB_NAMES.PROCESS_VIDEO,
      { videoId },
      { jobId: videoId },
    );
  }
}
