import { ListMultipartUploadsCommand, S3Client } from '@aws-sdk/client-s3';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import redisConfig from '../config/redis.config';
import storageConfig from '../config/storage.config';
import { JOB_NAMES, QUEUE_NAMES } from '../queue/queue.constants';
import { STORAGE_CLIENTS } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import {
  InvalidUploadPartsException,
  VideoNotFoundException,
} from './videos.exceptions';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
// Smallest valid multipart size for every part except the last.
const MIN_PART = 5 * 1024 * 1024;

describe('VideosService upload lifecycle (integration: DB + MinIO + Redis)', () => {
  let module: TestingModule;
  let service: VideosService;
  let dataSource: DataSource;
  let queue: Queue;
  let s3: S3Client;
  let storage: StorageService;
  let ownerId: string;
  let otherUserId: string;

  const createUserWithChannel = async (tag: string): Promise<string> => {
    const user = await dataSource
      .getRepository(User)
      .save({ email: `${tag}@example.com`, password: 'x' });
    await dataSource
      .getRepository(Channel)
      .save({ name: tag, nickname: tag, user_id: user.id });
    return user.id;
  };

  const putPart = async (url: string, size: number): Promise<string> => {
    const response = await fetch(url, {
      method: 'PUT',
      body: new Uint8Array(size),
    });
    expect(response.status).toBe(200);
    return response.headers.get('etag') as string;
  };

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, redisConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
      ],
    }).compile();
    await module.init();
    service = module.get(VideosService);
    dataSource = module.get(DataSource);
    queue = module.get(getQueueToken(QUEUE_NAMES.VIDEO_PROCESSING));
    s3 = module.get(STORAGE_CLIENTS.INTERNAL);
    storage = module.get(StorageService);
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
    ownerId = await createUserWithChannel('video_owner');
    otherUserId = await createUserWithChannel('video_other');
  });

  it('should pre-register an uploading draft in the owner channel', async () => {
    const result = await service.initiateUpload(ownerId, {
      title: 'Meu vídeo',
      filename: 'clip.mp4',
      contentType: 'video/mp4',
      sizeBytes: 1024 * 1024 * 1024,
    });

    const video = await dataSource.getRepository(Video).findOneOrFail({
      where: { public_id: result.id },
      relations: ['channel'],
    });
    expect(result.partCount).toBe(16);
    expect(video.status).toBe(VideoStatus.UPLOADING);
    expect(video.upload_id).toBeTruthy();
    expect(video.channel.user_id).toBe(ownerId);
  });

  it('should complete the upload, move to processing and enqueue the job', async () => {
    const { id } = await service.initiateUpload(ownerId, {
      title: 'Clip',
      filename: 'clip.mp4',
      contentType: 'video/mp4',
      sizeBytes: 1000,
    });
    const { parts } = await service.getPartUrls(id, ownerId, [1]);
    const etag = await putPart(parts[0].url, 1000);

    const result = await service.completeUpload(id, ownerId, [
      { partNumber: 1, etag },
    ]);

    const video = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: id });
    expect(result.status).toBe(VideoStatus.PROCESSING);
    expect(video.status).toBe(VideoStatus.PROCESSING);
    expect(video.upload_id).toBeNull();
    const job = await queue.getJob(video.id);
    expect(job?.name).toBe(JOB_NAMES.PROCESS_VIDEO);
    expect(job?.data).toEqual({ videoId: video.id });
  });

  it('should list the parts already uploaded for resume', async () => {
    const { id } = await service.initiateUpload(ownerId, {
      title: 'Clip',
      filename: 'clip.mp4',
      contentType: 'video/mp4',
      sizeBytes: MIN_PART + 10,
    });
    const { parts } = await service.getPartUrls(id, ownerId, [1]);
    const etag = await putPart(parts[0].url, MIN_PART);

    const uploaded = await service.listUploadedParts(id, ownerId);

    expect(uploaded).toEqual([{ partNumber: 1, etag, sizeBytes: MIN_PART }]);
  });

  it('should map a wrong ETag to INVALID_UPLOAD_PARTS and keep the video uploading', async () => {
    const { id } = await service.initiateUpload(ownerId, {
      title: 'Clip',
      filename: 'clip.mp4',
      contentType: 'video/mp4',
      sizeBytes: 1000,
    });
    const { parts } = await service.getPartUrls(id, ownerId, [1]);
    await putPart(parts[0].url, 1000);

    await expect(
      service.completeUpload(id, ownerId, [
        { partNumber: 1, etag: '"00000000000000000000000000000000"' },
      ]),
    ).rejects.toBeInstanceOf(InvalidUploadPartsException);
    const video = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: id });
    expect(video.status).toBe(VideoStatus.UPLOADING);
  });

  it('should abort the multipart upload and delete the draft', async () => {
    const { id } = await service.initiateUpload(ownerId, {
      title: 'Clip',
      filename: 'clip.mp4',
      contentType: 'video/mp4',
      sizeBytes: 1000,
    });
    const video = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: id });

    await service.abortUpload(id, ownerId);

    expect(
      await dataSource.getRepository(Video).findOneBy({ public_id: id }),
    ).toBeNull();
    const uploads = await s3.send(
      new ListMultipartUploadsCommand({
        Bucket: storage.videosBucket,
        Prefix: video.storage_key,
      }),
    );
    expect(uploads.Uploads ?? []).toHaveLength(0);
  });

  it('should hide videos of other users behind VIDEO_NOT_FOUND', async () => {
    const { id } = await service.initiateUpload(ownerId, {
      title: 'Clip',
      filename: 'clip.mp4',
      contentType: 'video/mp4',
      sizeBytes: 1000,
    });

    await expect(
      service.listUploadedParts(id, otherUserId),
    ).rejects.toBeInstanceOf(VideoNotFoundException);
  });
});
