import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getQueueToken } from '@nestjs/bullmq';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { VideoProcessingProducer } from '../queue/video-processing.producer';
import { STORAGE_CLIENTS } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { WorkerModule } from './worker.module';

const FIXTURES = join(__dirname, '..', '..', 'test', 'fixtures');
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

describe('VideoProcessor (integration: DB + MinIO + Redis + ffmpeg)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let storage: StorageService;
  let producer: VideoProcessingProducer;
  let queue: Queue;
  let channelId: string;

  /** Stores a fixture as the original and creates the `processing` row. */
  const createProcessingVideo = async (fixture: string): Promise<Video> => {
    const id = randomUUID();
    const storageKey = `${id}/original`;
    const bytes = readFileSync(join(FIXTURES, fixture));
    await storage.putObject(
      storage.videosBucket,
      storageKey,
      bytes,
      'video/mp4',
    );
    return dataSource.getRepository(Video).save({
      id,
      public_id: id.replace(/-/g, '').slice(0, 11),
      channel_id: channelId,
      title: fixture,
      original_filename: fixture,
      content_type: 'video/mp4',
      size_bytes: bytes.length,
      part_size_bytes: 64 * 1024 * 1024,
      storage_key: storageKey,
      status: VideoStatus.PROCESSING,
    });
  };

  const waitForStatus = async (
    id: string,
    statuses: VideoStatus[],
    timeoutMs = 20000,
  ): Promise<Video> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const video = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ id });
      if (statuses.includes(video.status)) return video;
      if (Date.now() > deadline) {
        throw new Error(
          `Video ${id} still ${video.status} after ${timeoutMs}ms`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    await module.init(); // starts the BullMQ worker (prefix `bull-test`)
    dataSource = module.get(DataSource);
    storage = module.get(StorageService);
    producer = module.get(VideoProcessingProducer);
    queue = module.get(getQueueToken(QUEUE_NAMES.VIDEO_PROCESSING));
  }, 60000);

  afterAll(async () => {
    await queue?.obliterate({ force: true });
    await module?.close();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await queue.obliterate({ force: true });
    await cleanAllTables(dataSource);
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'processor@example.com', password: 'x' });
    const channel = await dataSource
      .getRepository(Channel)
      .save({ name: 'proc', nickname: 'proc', user_id: user.id });
    channelId = channel.id;
  });

  it('should process an mp4 end to end until ready with a stored thumbnail', async () => {
    const video = await createProcessingVideo('sample.mp4');

    await producer.enqueue(video.id);
    const done = await waitForStatus(video.id, [
      VideoStatus.READY,
      VideoStatus.FAILED,
    ]);

    expect(done.status).toBe(VideoStatus.READY);
    expect(done.duration_seconds).toBeCloseTo(5, 0);
    expect(done.metadata?.videoCodec).toBe('h264');
    expect(done.thumbnail_key).toBe(`${video.id}.jpg`);
    const s3 = module.get<S3Client>(STORAGE_CLIENTS.INTERNAL);
    const thumbnail = await s3.send(
      new GetObjectCommand({
        Bucket: storage.thumbnailsBucket,
        Key: `${video.id}.jpg`,
      }),
    );
    const bytes = Buffer.from(await thumbnail.Body!.transformToByteArray());
    expect(thumbnail.ContentType).toBe('image/jpeg');
    expect(bytes.subarray(0, 3).equals(JPEG_MAGIC)).toBe(true);
  }, 30000);

  it('should fail an unplayable codec once, without retrying', async () => {
    const video = await createProcessingVideo('unplayable.avi');

    await producer.enqueue(video.id);
    const done = await waitForStatus(video.id, [
      VideoStatus.READY,
      VideoStatus.FAILED,
    ]);

    expect(done.status).toBe(VideoStatus.FAILED);
    expect(done.failure_reason).toBe('UNPLAYABLE_CODEC');
    const job = await queue.getJob(video.id);
    expect(job?.attemptsMade).toBe(1);
  }, 30000);

  it('should retry a transient storage failure and still reach ready', async () => {
    const video = await createProcessingVideo('sample.mp4');
    const realPutObject = storage.putObject.bind(
      storage,
    ) as StorageService['putObject'];
    jest
      .spyOn(storage, 'putObject')
      .mockRejectedValueOnce(new Error('transient storage error'))
      .mockImplementation(realPutObject);

    await producer.enqueue(video.id);
    const done = await waitForStatus(video.id, [
      VideoStatus.READY,
      VideoStatus.FAILED,
    ]);

    expect(done.status).toBe(VideoStatus.READY);
    const job = await queue.getJob(video.id);
    expect(job?.attemptsMade).toBe(2);
  }, 30000);

  it('should mark PROCESSING_FAILED when every attempt fails', async () => {
    const video = await createProcessingVideo('sample.mp4');
    jest
      .spyOn(storage, 'putObject')
      .mockRejectedValue(new Error('storage down'));

    await producer.enqueue(video.id);
    const done = await waitForStatus(
      video.id,
      [VideoStatus.READY, VideoStatus.FAILED],
      25000,
    );

    expect(done.status).toBe(VideoStatus.FAILED);
    expect(done.failure_reason).toBe('PROCESSING_FAILED');
    const job = await queue.getJob(video.id);
    expect(job?.attemptsMade).toBe(3);
  }, 30000);

  it('should leave an already-ready video untouched when re-processed', async () => {
    const video = await createProcessingVideo('sample.mp4');
    await dataSource.getRepository(Video).update(video.id, {
      status: VideoStatus.READY,
      thumbnail_key: 'existing.jpg',
    });
    const putSpy = jest.spyOn(storage, 'putObject');

    await producer.enqueue(video.id);
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const after = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: video.id });
    expect(after.thumbnail_key).toBe('existing.jpg');
    expect(putSpy).not.toHaveBeenCalled();
  }, 30000);
});
