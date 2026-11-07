import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';
import {
  ABANDONED_UPLOAD_CLEANUP_EVERY_MS,
  JOB_NAMES,
  QUEUE_NAMES,
} from '../queue/queue.constants';

/**
 * Registers the hourly cleanup at worker boot. `upsertJobScheduler` is
 * idempotent, so restarts never create duplicates (BullMQ v6 Job Schedulers —
 * the old `repeat` option was removed in v6).
 */
@Injectable()
export class UploadCleanupScheduler implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(QUEUE_NAMES.VIDEO_MAINTENANCE)
    private readonly queue: Queue,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      JOB_NAMES.ABANDONED_UPLOAD_CLEANUP,
      { every: ABANDONED_UPLOAD_CLEANUP_EVERY_MS },
      { name: JOB_NAMES.ABANDONED_UPLOAD_CLEANUP },
    );
  }
}
