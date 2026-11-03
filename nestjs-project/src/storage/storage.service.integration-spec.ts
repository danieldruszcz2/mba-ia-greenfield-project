import { randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { STORAGE_CLIENTS } from './storage.constants';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

// S3 multipart requires every part except the last to be at least 5 MiB.
const MIN_PART_SIZE = 5 * 1024 * 1024;

const putPart = async (url: string, body: Buffer): Promise<string> => {
  const response = await fetch(url, {
    method: 'PUT',
    body: new Uint8Array(body),
  });
  expect(response.status).toBe(200);
  const etag = response.headers.get('etag');
  expect(etag).toBeTruthy();
  return etag as string;
};

describe('StorageService (integration, real MinIO)', () => {
  let module: TestingModule;
  let service: StorageService;
  let internalClient: S3Client;
  const createdKeys: string[] = [];

  const newKey = (): string => {
    const key = `test/${randomUUID()}/original`;
    createdKeys.push(key);
    return key;
  };

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    service = module.get(StorageService);
    internalClient = module.get(STORAGE_CLIENTS.INTERNAL);
  });

  afterAll(async () => {
    await Promise.all(
      createdKeys.map((key) =>
        internalClient.send(
          new DeleteObjectCommand({ Bucket: service.videosBucket, Key: key }),
        ),
      ),
    );
    await module.close();
  });

  it('should assemble an object from two presigned parts', async () => {
    const key = newKey();
    const part1 = Buffer.alloc(MIN_PART_SIZE, 'a');
    const part2 = Buffer.from('tail-bytes');
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');

    const { parts, expiresAt } = await service.presignUploadParts(
      key,
      uploadId,
      [1, 2],
    );
    const etag1 = await putPart(parts[0].url, part1);
    const etag2 = await putPart(parts[1].url, part2);
    await service.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag: etag1 },
      { partNumber: 2, etag: etag2 },
    ]);

    const head = await internalClient.send(
      new HeadObjectCommand({ Bucket: service.videosBucket, Key: key }),
    );
    expect(head.ContentLength).toBe(part1.length + part2.length);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('should list only the parts already uploaded', async () => {
    const key = newKey();
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');
    const {
      parts: [part1],
    } = await service.presignUploadParts(key, uploadId, [1]);
    const etag = await putPart(part1.url, Buffer.alloc(MIN_PART_SIZE, 'b'));

    const uploaded = await service.listParts(key, uploadId);

    expect(uploaded).toEqual([
      { partNumber: 1, etag, sizeBytes: MIN_PART_SIZE },
    ]);
    await service.abortMultipartUpload(key, uploadId);
  });

  it('should abort a multipart upload idempotently', async () => {
    const key = newKey();
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');

    await service.abortMultipartUpload(key, uploadId);
    await expect(
      service.abortMultipartUpload(key, uploadId),
    ).resolves.toBeUndefined();

    const uploads = await internalClient.send(
      new ListMultipartUploadsCommand({
        Bucket: service.videosBucket,
        Prefix: key,
      }),
    );
    expect(uploads.Uploads ?? []).toHaveLength(0);
  });

  it('should serve a Range request on a presigned GET with 206', async () => {
    const key = newKey();
    await service.putObject(
      service.videosBucket,
      key,
      Buffer.alloc(1000, 'c'),
      'video/mp4',
    );

    const { url } = await service.presignGetObject(key, { client: 'public' });
    const response = await fetch(url, { headers: { Range: 'bytes=0-99' } });

    expect(response.status).toBe(206);
    expect((await response.arrayBuffer()).byteLength).toBe(100);
  });

  it('should force attachment disposition when a download filename is given', async () => {
    const key = newKey();
    await service.putObject(
      service.videosBucket,
      key,
      Buffer.from('x'),
      'video/mp4',
    );

    const { url } = await service.presignGetObject(key, {
      client: 'public',
      downloadFilename: 'clip.mp4',
    });
    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain(
      'attachment; filename="clip.mp4"',
    );
  });

  it('should sign public URLs with S3_PUBLIC_ENDPOINT and internal URLs with S3_ENDPOINT', async () => {
    const key = newKey();
    const publicUrl = new URL(
      (await service.presignGetObject(key, { client: 'public' })).url,
    );
    const internalUrl = new URL(
      (await service.presignGetObject(key, { client: 'internal' })).url,
    );

    expect(publicUrl.host).toBe(
      new URL(process.env.S3_PUBLIC_ENDPOINT as string).host,
    );
    expect(internalUrl.host).toBe(
      new URL(process.env.S3_ENDPOINT as string).host,
    );
  });

  it('should build a stable public thumbnail URL', () => {
    expect(service.buildPublicThumbnailUrl('abc.jpg')).toBe(
      `${process.env.S3_PUBLIC_ENDPOINT}/${service.thumbnailsBucket}/abc.jpg`,
    );
  });
});
