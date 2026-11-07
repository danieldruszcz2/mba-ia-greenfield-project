import { randomUUID } from 'node:crypto';
import { ListMultipartUploadsCommand, S3Client } from '@aws-sdk/client-s3';
import { getQueueToken } from '@nestjs/bullmq';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { JOB_NAMES, QUEUE_NAMES } from '../queue/queue.constants';
import { STORAGE_CLIENTS } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { UploadCleanupProcessor } from './upload-cleanup.processor';
import { UploadCleanupScheduler } from './upload-cleanup.scheduler';
import { WorkerModule } from './worker.module';

describe('UploadCleanupProcessor (integration: DB + MinIO + Redis)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let storage: StorageService;
  let s3: S3Client;
  let processor: UploadCleanupProcessor;
  let maintenanceQueue: Queue;
  let channelId: string;

  /** Creates a video row; `uploading` ones get a real multipart upload. */
  const createVideo = async (
    status: VideoStatus,
    idleHours: number,
  ): Promise<Video> => {
    const id = randomUUID();
    const storageKey = `${id}/original`;
    const uploadId =
      status === VideoStatus.UPLOADING
        ? await storage.createMultipartUpload(storageKey, 'video/mp4')
        : null;
    await dataSource.getRepository(Video).insert({
      id,
      public_id: id.replace(/-/g, '').slice(0, 11),
      channel_id: channelId,
      title: 'clip',
      original_filename: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: 1000,
      part_size_bytes: 64 * 1024 * 1024,
      storage_key: storageKey,
      upload_id: uploadId,
      status,
    });
    // `@UpdateDateColumn` would reset the timestamp, so age the row with raw SQL.
    await dataSource.query(
      `UPDATE "videos" SET "updated_at" = now() - make_interval(hours => $1) WHERE "id" = $2`,
      [idleHours, id],
    );
    return dataSource.getRepository(Video).findOneByOrFail({ id });
  };

  const exists = async (id: string): Promise<boolean> =>
    (await dataSource.getRepository(Video).countBy({ id })) > 0;

  const openUploads = async (storageKey: string): Promise<number> => {
    const result = await s3.send(
      new ListMultipartUploadsCommand({
        Bucket: storage.videosBucket,
        Prefix: storageKey,
      }),
    );
    return (result.Uploads ?? []).length;
  };

  beforeAll(async () => {
    // compile() without init(): the BullMQ workers stay stopped, so the test
    // drives the processor and the scheduler directly.
    module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    dataSource = module.get(DataSource);
    storage = module.get(StorageService);
    s3 = module.get(STORAGE_CLIENTS.INTERNAL);
    processor = module.get(UploadCleanupProcessor);
    maintenanceQueue = module.get(getQueueToken(QUEUE_NAMES.VIDEO_MAINTENANCE));
  }, 60000);

  afterAll(async () => {
    await maintenanceQueue?.obliterate({ force: true });
    await module?.close();
  });

  beforeEach(async () => {
    await maintenanceQueue.obliterate({ force: true });
    await cleanAllTables(dataSource);
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'cleanup@example.com', password: 'x' });
    const channel = await dataSource
      .getRepository(Channel)
      .save({ name: 'cleanup', nickname: 'cleanup', user_id: user.id });
    channelId = channel.id;
  });

  it('should remove an uploading draft idle for more than 24h and abort its multipart upload', async () => {
    const stale = await createVideo(VideoStatus.UPLOADING, 25);

    const result = await processor.process();

    expect(result.removed).toBe(1);
    expect(await exists(stale.id)).toBe(false);
    expect(await openUploads(stale.storage_key)).toBe(0);
  });

  it('should keep an uploading draft active within the last 24h', async () => {
    const recent = await createVideo(VideoStatus.UPLOADING, 1);

    await processor.process();

    expect(await exists(recent.id)).toBe(true);
    expect(await openUploads(recent.storage_key)).toBe(1);
    await storage.abortMultipartUpload(
      recent.storage_key,
      recent.upload_id as string,
    );
  });

  it.each([VideoStatus.PROCESSING, VideoStatus.READY, VideoStatus.FAILED])(
    'should never remove a %s video, however old',
    async (status) => {
      const old = await createVideo(status, 24 * 30);

      await processor.process();

      expect(await exists(old.id)).toBe(true);
    },
  );

  it('should treat an already-aborted UploadId as success', async () => {
    const stale = await createVideo(VideoStatus.UPLOADING, 25);
    await storage.abortMultipartUpload(
      stale.storage_key,
      stale.upload_id as string,
    );

    await expect(processor.process()).resolves.toEqual({ removed: 1 });
    expect(await exists(stale.id)).toBe(false);
  });

  it('should keep a single job scheduler across repeated worker boots', async () => {
    const scheduler = module.get(UploadCleanupScheduler);

    await scheduler.onApplicationBootstrap();
    await scheduler.onApplicationBootstrap();

    const schedulers = await maintenanceQueue.getJobSchedulers();
    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]).toMatchObject({
      key: JOB_NAMES.ABANDONED_UPLOAD_CLEANUP,
      every: 3600000,
    });
  });
});
