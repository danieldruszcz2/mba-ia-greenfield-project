import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { StorageService } from '../storage/storage.service';
import { VideosRepository } from '../videos/videos.repository';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  it('should compile with DB, storage and queues available to processors', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(module.get(VideosRepository)).toBeInstanceOf(VideosRepository);
    expect(module.get(StorageService)).toBeInstanceOf(StorageService);
    expect(
      module.get<Queue>(getQueueToken(QUEUE_NAMES.VIDEO_PROCESSING)).name,
    ).toBe(QUEUE_NAMES.VIDEO_PROCESSING);
    await module.close();
  }, 30000);
});
