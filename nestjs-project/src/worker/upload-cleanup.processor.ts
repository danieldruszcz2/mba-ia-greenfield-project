import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { StorageService } from '../storage/storage.service';
import { ABANDONED_UPLOAD_TTL_MS } from '../videos/videos.constants';
import { VideosRepository } from '../videos/videos.repository';

export interface UploadCleanupResult {
  removed: number;
}

/**
 * Consumes the hourly `abandoned-upload-cleanup` job: aborts the multipart
 * upload of every `uploading` draft idle for more than 24h and deletes the row.
 * Idempotent — an already-aborted `UploadId` counts as success.
 */
@Processor(QUEUE_NAMES.VIDEO_MAINTENANCE)
export class UploadCleanupProcessor extends WorkerHost {
  private readonly logger = new Logger(UploadCleanupProcessor.name);

  constructor(
    private readonly videosRepository: VideosRepository,
    private readonly storageService: StorageService,
  ) {
    super();
  }

  async process(): Promise<UploadCleanupResult> {
    const before = new Date(Date.now() - ABANDONED_UPLOAD_TTL_MS);
    const abandoned = await this.videosRepository.findAbandonedUploads(before);

    for (const video of abandoned) {
      if (video.upload_id) {
        await this.storageService.abortMultipartUpload(
          video.storage_key,
          video.upload_id,
        );
      }
      await this.videosRepository.deleteById(video.id);
    }

    if (abandoned.length > 0) {
      this.logger.log(`Removed ${abandoned.length} abandoned upload(s)`);
    }
    return { removed: abandoned.length };
  }
}
