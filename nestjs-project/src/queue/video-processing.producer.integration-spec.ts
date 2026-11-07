import { randomUUID } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import redisConfig from '../config/redis.config';
import {
  JOB_NAMES,
  QUEUE_NAMES,
  type ProcessVideoJobData,
} from './queue.constants';
import { QueueModule } from './queue.module';
import { VideoProcessingProducer } from './video-processing.producer';

describe('VideoProcessingProducer (integration, real Redis)', () => {
  let module: TestingModule;
  let producer: VideoProcessingProducer;
  let queue: Queue<ProcessVideoJobData>;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [redisConfig] }),
        QueueModule,
      ],
    }).compile();
    await module.init();
    producer = module.get(VideoProcessingProducer);
    queue = module.get(getQueueToken(QUEUE_NAMES.VIDEO_PROCESSING));
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await module.close();
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
  });

  it('should add a process-video job keyed by the video id', async () => {
    const videoId = randomUUID();

    await producer.enqueue(videoId);

    const job = await queue.getJob(videoId);
    expect(job).toBeDefined();
    expect(job!.name).toBe(JOB_NAMES.PROCESS_VIDEO);
    expect(job!.data).toEqual({ videoId });
  });

  it('should apply 3 attempts with exponential backoff of 1000 ms', async () => {
    const videoId = randomUUID();

    await producer.enqueue(videoId);

    const job = await queue.getJob(videoId);
    expect(job!.opts.attempts).toBe(3);
    expect(job!.opts.backoff).toEqual({ type: 'exponential', delay: 1000 });
  });

  it('should not create a second job when the same video is enqueued twice', async () => {
    const videoId = randomUUID();

    await producer.enqueue(videoId);
    await producer.enqueue(videoId);

    expect(await queue.getJobCountByTypes('waiting', 'delayed')).toBe(1);
  });

  it('should not register any worker on the queue (the API only produces)', async () => {
    expect(await queue.getWorkersCount()).toBe(0);
  });
});
