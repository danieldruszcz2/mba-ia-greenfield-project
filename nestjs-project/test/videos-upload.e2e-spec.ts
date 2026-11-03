import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ListMultipartUploadsCommand, S3Client } from '@aws-sdk/client-s3';
import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { QUEUE_NAMES } from '../src/queue/queue.constants';
import { STORAGE_CLIENTS } from '../src/storage/storage.constants';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import {
  clearThrottler,
  createE2eApp,
  MIN_PART_BYTES,
  putPartToStorage,
  registerConfirmAndLogin,
} from './helpers/videos-e2e.helpers';

interface VideosResponseBody {
  id: string;
  status: string;
  partSizeBytes: number;
  partCount: number;
  parts: {
    partNumber: number;
    url?: string;
    etag?: string;
    sizeBytes?: number;
  }[];
  expiresAt: string;
  error: string;
}

const body = (res: { body: unknown }): VideosResponseBody =>
  res.body as VideosResponseBody;

const PART_SIZE = 64 * 1024 * 1024;
/** Declared size that yields exactly 2 parts (64 MiB + 1 byte). */
const TWO_PART_SIZE = PART_SIZE + 1;

describe('videos-upload', () => {
  let app: INestApplication<App>;
  let moduleFixture: TestingModule;
  let dataSource: DataSource;
  let processingQueue: Queue;
  let ownerToken: string;
  let otherToken: string;

  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  const initiate = (
    overrides: Record<string, unknown> = {},
    token = ownerToken,
  ) =>
    request(server())
      .post('/videos')
      .set(auth(token))
      .send({
        title: 'Meu vídeo',
        filename: 'clip.mp4',
        contentType: 'video/mp4',
        sizeBytes: TWO_PART_SIZE,
        ...overrides,
      });

  const signParts = (id: string, partNumbers: number[]) =>
    request(server())
      .post(`/videos/${id}/upload/part-urls`)
      .set(auth(ownerToken))
      .send({ partNumbers });

  beforeAll(async () => {
    ({ app, moduleFixture } = await createE2eApp());
    dataSource = moduleFixture.get(DataSource);
    processingQueue = moduleFixture.get(
      getQueueToken(QUEUE_NAMES.VIDEO_PROCESSING),
    );
  });

  afterAll(async () => {
    await processingQueue.obliterate({ force: true });
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await processingQueue.obliterate({ force: true });
    clearThrottler(moduleFixture);
    ownerToken = await registerConfirmAndLogin(app, 'owner@example.com');
    otherToken = await registerConfirmAndLogin(app, 'other@example.com');
  });

  // 1. Upload lifecycle — POST /videos, part-urls, parts, complete, abort

  test('initiate-upload-creates-draft', async () => {
    const res = await initiate({ sizeBytes: 104857600 });

    expect(res.status).toBe(201);
    expect(body(res).id).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(body(res)).toEqual({
      id: body(res).id,
      status: 'uploading',
      partSizeBytes: PART_SIZE,
      partCount: 2,
    });
    const video = await dataSource.getRepository(Video).findOneOrFail({
      where: { public_id: body(res).id },
      relations: ['channel', 'channel.user'],
    });
    expect(video.status).toBe(VideoStatus.UPLOADING);
    expect(video.upload_id).toBeTruthy();
    expect(video.channel.user.email).toBe('owner@example.com');
  });

  test('part-urls-accept-direct-put', async () => {
    const { id } = body(await initiate());

    const res = await signParts(id, [1, 2]);

    expect(res.status).toBe(200);
    expect(body(res).parts).toHaveLength(2);
    expect(new Date(body(res).expiresAt).getTime()).toBeGreaterThan(Date.now());
    for (const part of body(res).parts) {
      const put = await putPartToStorage(
        part.url as string,
        new Uint8Array(16),
      );
      expect(put.status).toBe(200);
      expect(put.etag).toBeTruthy();
    }
  });

  test('list-parts-for-resume', async () => {
    const { id } = body(await initiate());
    const [part1] = body(await signParts(id, [1])).parts;
    const put = await putPartToStorage(part1.url as string, new Uint8Array(16));
    expect(put.status).toBe(200);

    const res = await request(server())
      .get(`/videos/${id}/upload/parts`)
      .set(auth(ownerToken));

    expect(res.status).toBe(200);
    expect(body(res).parts).toHaveLength(1);
    expect(body(res).parts[0]).toMatchObject({ partNumber: 1, etag: put.etag });
    expect(body(res).parts[0].sizeBytes).toBeGreaterThan(0);
  });

  test('complete-upload-moves-to-processing', async () => {
    const { id } = body(await initiate());
    const urls = body(await signParts(id, [1, 2])).parts;
    const put1 = await putPartToStorage(
      urls[0].url as string,
      new Uint8Array(MIN_PART_BYTES),
    );
    const put2 = await putPartToStorage(
      urls[1].url as string,
      new Uint8Array(1),
    );
    expect([put1.status, put2.status]).toEqual([200, 200]);

    const res = await request(server())
      .post(`/videos/${id}/upload/complete`)
      .set(auth(ownerToken))
      .send({
        parts: [
          { partNumber: 1, etag: put1.etag },
          { partNumber: 2, etag: put2.etag },
        ],
      });

    expect(res.status).toBe(202);
    expect(body(res)).toEqual({ id, status: 'processing' });
    const video = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: id });
    expect(video.status).toBe(VideoStatus.PROCESSING);
    expect(video.upload_id).toBeNull();
    const job = await processingQueue.getJob(video.id);
    expect(job?.name).toBe('process-video');
  });

  test('abort-upload-removes-draft', async () => {
    const { id } = body(await initiate());
    const video = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: id });

    const res = await request(server())
      .delete(`/videos/${id}/upload`)
      .set(auth(ownerToken));

    expect(res.status).toBe(204);
    const detail = await request(server())
      .get(`/videos/${id}`)
      .set(auth(ownerToken));
    expect(detail.status).toBe(404);
    expect(
      await dataSource.getRepository(Video).findOneBy({ public_id: id }),
    ).toBeNull();
    const s3 = moduleFixture.get<S3Client>(STORAGE_CLIENTS.INTERNAL);
    const uploads = await s3.send(
      new ListMultipartUploadsCommand({
        Bucket: moduleFixture.get(StorageService).videosBucket,
        Prefix: video.storage_key,
      }),
    );
    expect(uploads.Uploads ?? []).toHaveLength(0);
  });

  test('auth-and-ownership-enforced', async () => {
    const noToken = await request(server()).post('/videos').send({});
    expect(noToken.status).toBe(401);

    const { id } = body(await initiate());
    const responses = await Promise.all([
      request(server())
        .post(`/videos/${id}/upload/part-urls`)
        .set(auth(otherToken))
        .send({ partNumbers: [1] }),
      request(server()).get(`/videos/${id}/upload/parts`).set(auth(otherToken)),
      request(server())
        .post(`/videos/${id}/upload/complete`)
        .set(auth(otherToken))
        .send({ parts: [{ partNumber: 1, etag: '"x"' }] }),
      request(server()).delete(`/videos/${id}/upload`).set(auth(otherToken)),
    ]);

    for (const res of responses) {
      expect(res.status).toBe(404);
      expect(body(res).error).toBe('VIDEO_NOT_FOUND');
    }
    const video = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: id });
    expect(video.status).toBe(VideoStatus.UPLOADING);
  });

  test('initiate-upload-rejects-invalid-input', async () => {
    const tooLarge = await initiate({ sizeBytes: 10737418241 });
    expect(tooLarge.status).toBe(400);
    expect(body(tooLarge).error).toBe('VIDEO_TOO_LARGE');

    const badType = await initiate({ contentType: 'video/avi' });
    expect(badType.status).toBe(400);
    expect(body(badType).error).toBe('UNSUPPORTED_VIDEO_TYPE');

    const noTitle = await request(server())
      .post('/videos')
      .set(auth(ownerToken))
      .send({ filename: 'clip.mp4', contentType: 'video/mp4', sizeBytes: 10 });
    expect(noTitle.status).toBe(400);

    expect(await dataSource.getRepository(Video).count()).toBe(0);
  });

  test('upload-routes-in-openapi', () => {
    const spec = JSON.parse(
      readFileSync(join(__dirname, '..', 'openapi.json'), 'utf-8'),
    ) as { paths: Record<string, Record<string, unknown>> };

    expect(spec.paths['/videos']).toHaveProperty('post');
    expect(spec.paths['/videos/{id}/upload/part-urls']).toHaveProperty('post');
    expect(spec.paths['/videos/{id}/upload/parts']).toHaveProperty('get');
    expect(spec.paths['/videos/{id}/upload/complete']).toHaveProperty('post');
    expect(spec.paths['/videos/{id}/upload']).toHaveProperty('delete');
  });
});
