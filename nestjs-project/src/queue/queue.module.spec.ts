import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import redisConfig from '../config/redis.config';
import { QUEUE_NAMES } from './queue.constants';
import { QueueModule } from './queue.module';
import { VideoProcessingProducer } from './video-processing.producer';

describe('QueueModule', () => {
  it('should compile with redisConfig and expose both queues and the producer', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [redisConfig] }),
        QueueModule,
      ],
    }).compile();

    expect(module.get(VideoProcessingProducer)).toBeInstanceOf(
      VideoProcessingProducer,
    );
    expect(
      module.get<Queue>(getQueueToken(QUEUE_NAMES.VIDEO_PROCESSING)).name,
    ).toBe(QUEUE_NAMES.VIDEO_PROCESSING);
    expect(
      module.get<Queue>(getQueueToken(QUEUE_NAMES.VIDEO_MAINTENANCE)).name,
    ).toBe(QUEUE_NAMES.VIDEO_MAINTENANCE);
    await module.close();
  });
});
