import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import redisConfig from '../config/redis.config';
import { QUEUE_NAMES, VIDEO_PROCESSING_JOB_OPTIONS } from './queue.constants';
import { VideoProcessingProducer } from './video-processing.producer';

/**
 * Queue infrastructure shared by the API (producer only) and the video worker.
 * No processor is registered here — consumers live in the worker entrypoint.
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [redisConfig.KEY],
      useFactory: (redis: ConfigType<typeof redisConfig>) => ({
        connection: { host: redis.host, port: redis.port },
        prefix: redis.queuePrefix,
      }),
    }),
    BullModule.registerQueue(
      {
        name: QUEUE_NAMES.VIDEO_PROCESSING,
        defaultJobOptions: VIDEO_PROCESSING_JOB_OPTIONS,
      },
      { name: QUEUE_NAMES.VIDEO_MAINTENANCE },
    ),
  ],
  providers: [VideoProcessingProducer],
  exports: [BullModule, VideoProcessingProducer],
})
export class QueueModule {}
