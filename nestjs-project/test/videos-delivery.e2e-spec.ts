import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { QUEUE_NAMES } from '../src/queue/queue.constants';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { VideoProcessor } from '../src/worker/video.processor';
import { WorkerModule } from '../src/worker/worker.module';
import {
  clearThrottler,
  createE2eApp,
  E2E_SETUP_TIMEOUT_MS,
  putPartToStorage,
  registerConfirmAndLogin,
} from './helpers/videos-e2e.helpers';

interface DeliveryResponseBody {
  id: string;
  status: string;
  durationSeconds: number | null;
  metadata: { videoCodec: string | null } | null;
  thumbnailUrl: string | null;
  parts: { partNumber: number; url: string }[];
  url: string;
  expiresAt: string;
  error: string;
}

const body = (res: { body: unknown }): DeliveryResponseBody =>
  res.body as DeliveryResponseBody;

const SAMPLE = readFileSync(join(__dirname, 'fixtures', 'sample.mp4'));
const PROCESSING_TIMEOUT_MS = 30_000;

describe('videos-delivery', () => {
  let app: INestApplication<App>;
  let moduleFixture: TestingModule;
  let workerContext: INestApplicationContext;
  let dataSource: DataSource;
  let processingQueue: Queue;
  let ownerToken: string;
  let otherToken: string;

  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** Full upload flow of the fixture; returns the public id once `complete` answers 202. */
  const uploadSample = async (token: string): Promise<string> => {
    const initiated = await request(server())
      .post('/videos')
      .set(auth(token))
      .send({
        title: 'Sample',
        filename: 'sample.mp4',
        contentType: 'video/mp4',
        sizeBytes: SAMPLE.length,
      });
    expect(initiated.status).toBe(201);
    const { id } = body(initiated);
    const signed = await request(server())
      .post(`/videos/${id}/upload/part-urls`)
      .set(auth(token))
      .send({ partNumbers: [1] });
    const put = await putPartToStorage(
      body(signed).parts[0].url,
      new Uint8Array(SAMPLE),
    );
    expect(put.status).toBe(200);
    const completed = await request(server())
      .post(`/videos/${id}/upload/complete`)
      .set(auth(token))
      .send({ parts: [{ partNumber: 1, etag: put.etag }] });
    expect(completed.status).toBe(202);
    return id;
  };

  /**
   * Waits for the worker by reading the row directly. Polling the HTTP detail
   * endpoint would trip the global throttler (10 req/min) and get 429s.
   */
  const waitUntilSettled = async (publicId: string): Promise<VideoStatus> => {
    const deadline = Date.now() + PROCESSING_TIMEOUT_MS;
    for (;;) {
      const { status } = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ public_id: publicId });
      if (status === VideoStatus.READY || status === VideoStatus.FAILED) {
        return status;
      }
      if (Date.now() > deadline) {
        throw new Error(`Video ${publicId} still ${status}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  };

  const uploadAndProcess = async (token: string): Promise<string> => {
    const id = await uploadSample(token);
    expect(await waitUntilSettled(id)).toBe(VideoStatus.READY);
    return id;
  };

  beforeAll(async () => {
    ({ app, moduleFixture } = await createE2eApp());
    // The video worker runs in the same process so `process-video` jobs
    // (queue prefix `bull-test`) are consumed during the test.
    workerContext = await NestFactory.createApplicationContext(WorkerModule, {
      logger: false,
    });
    dataSource = moduleFixture.get(DataSource);
    processingQueue = moduleFixture.get(
      getQueueToken(QUEUE_NAMES.VIDEO_PROCESSING),
    );
  }, E2E_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await processingQueue?.obliterate({ force: true });
    await workerContext?.close();
    await app?.close();
  });

  beforeEach(async () => {
    await processingQueue.obliterate({ force: true });
    await cleanAllTables(dataSource);
    clearThrottler(moduleFixture);
    ownerToken = await registerConfirmAndLogin(app, 'owner@example.com');
    otherToken = await registerConfirmAndLogin(app, 'other@example.com');
  }, E2E_SETUP_TIMEOUT_MS);

  // 1. Detail and delivery — GET /videos/:id, /stream, /download

  test(
    'detail-of-processed-video',
    async () => {
      const id = await uploadAndProcess(ownerToken);

      const res = await request(server())
        .get(`/videos/${id}`)
        .set(auth(ownerToken));

      expect(res.status).toBe(200);
      expect(body(res).status).toBe('ready');
      expect(body(res).durationSeconds).toBeGreaterThan(0);
      expect(body(res).metadata?.videoCodec).toBe('h264');
      expect(body(res).thumbnailUrl).toBeTruthy();
      const thumbnail = await fetch(body(res).thumbnailUrl as string);
      expect(thumbnail.status).toBe(200);
      expect(thumbnail.headers.get('content-type')).toBe('image/jpeg');
    },
    PROCESSING_TIMEOUT_MS + 10_000,
  );

  test(
    'stream-url-serves-partial-content',
    async () => {
      const id = await uploadAndProcess(ownerToken);

      const res = await request(server())
        .get(`/videos/${id}/stream`)
        .set(auth(ownerToken));

      expect(res.status).toBe(200);
      expect(new Date(body(res).expiresAt).getTime()).toBeGreaterThan(
        Date.now(),
      );
      const partial = await fetch(body(res).url, {
        headers: { Range: 'bytes=0-1023' },
      });
      expect(partial.status).toBe(206);
      expect((await partial.arrayBuffer()).byteLength).toBe(1024);
      expect(partial.headers.get('content-range')).toMatch(
        /^bytes 0-1023\/\d+$/,
      );
    },
    PROCESSING_TIMEOUT_MS + 10_000,
  );

  test(
    'download-url-is-attachment',
    async () => {
      const id = await uploadAndProcess(ownerToken);

      const res = await request(server())
        .get(`/videos/${id}/download`)
        .set(auth(ownerToken));

      expect(res.status).toBe(200);
      const file = await fetch(body(res).url);
      expect(file.status).toBe(200);
      const disposition = file.headers.get('content-disposition') ?? '';
      expect(disposition).toContain('attachment');
      expect(disposition).toContain('filename="sample.mp4"');
    },
    PROCESSING_TIMEOUT_MS + 10_000,
  );

  test('stream-of-processing-video-not-ready', async () => {
    const worker = workerContext.get(VideoProcessor).worker;
    await worker.pause();
    try {
      const id = await uploadSample(ownerToken);
      const detail = await request(server())
        .get(`/videos/${id}`)
        .set(auth(ownerToken));
      expect(body(detail).status).toBe('processing');

      const res = await request(server())
        .get(`/videos/${id}/stream`)
        .set(auth(ownerToken));

      expect(res.status).toBe(409);
      expect(body(res).error).toBe('VIDEO_NOT_READY');
    } finally {
      await worker.resume();
    }
  }, 20_000);

  test(
    'delivery-auth-and-ownership',
    async () => {
      const id = await uploadAndProcess(ownerToken);
      const paths = [
        `/videos/${id}`,
        `/videos/${id}/stream`,
        `/videos/${id}/download`,
      ];

      for (const path of paths) {
        const anonymous = await request(server()).get(path);
        expect(anonymous.status).toBe(401);

        const other = await request(server()).get(path).set(auth(otherToken));
        expect(other.status).toBe(404);
        expect(body(other).error).toBe('VIDEO_NOT_FOUND');
      }
    },
    PROCESSING_TIMEOUT_MS + 10_000,
  );

  test('delivery-routes-in-openapi', () => {
    const spec = JSON.parse(
      readFileSync(join(__dirname, '..', 'openapi.json'), 'utf-8'),
    ) as {
      paths: Record<string, Record<string, { responses: object }>>;
    };

    for (const path of [
      '/videos/{id}',
      '/videos/{id}/stream',
      '/videos/{id}/download',
    ]) {
      expect(spec.paths[path].get.responses).toHaveProperty('200');
    }
  });
});
