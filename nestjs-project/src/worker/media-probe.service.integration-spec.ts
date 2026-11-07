import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { MediaProbeService } from './media-probe.service';

const FIXTURES = join(__dirname, '..', '..', 'test', 'fixtures');
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

describe('MediaProbeService (integration: real ffprobe/ffmpeg over MinIO URLs)', () => {
  let module: TestingModule;
  let storage: StorageService;
  const probe = new MediaProbeService();

  const uploadFixture = async (name: string, contentType: string) => {
    const key = `test/${randomUUID()}/${name}`;
    await storage.putObject(
      storage.videosBucket,
      key,
      readFileSync(join(FIXTURES, name)),
      contentType,
    );
    const { url } = await storage.presignGetObject(key, { client: 'internal' });
    return url;
  };

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    storage = module.get(StorageService);
  });

  afterAll(async () => {
    await module.close();
  });

  it('should read duration and metadata of an h264/aac mp4 over HTTP', async () => {
    const url = await uploadFixture('sample.mp4', 'video/mp4');

    const result = await probe.probe(url);

    expect(result.durationSeconds).toBeCloseTo(5, 0);
    expect(result.metadata).toMatchObject({
      container: 'mp4',
      videoCodec: 'h264',
      audioCodec: 'aac',
      width: 320,
      height: 240,
    });
    expect(result.metadata.bitrate).toBeGreaterThan(0);
  }, 30000);

  it('should report the codecs of a file the gate must reject', async () => {
    const url = await uploadFixture('unplayable.avi', 'video/x-msvideo');

    const { metadata } = await probe.probe(url);

    expect(metadata.container).toBe('avi');
    expect(metadata.videoCodec).toBe('mpeg4');
    expect(() => probe.assertPlayable(metadata)).toThrow('UNPLAYABLE_CODEC');
  }, 30000);

  it('should extract a JPEG frame at the requested position', async () => {
    const url = await uploadFixture('sample.mp4', 'video/mp4');

    const frame = await probe.extractFrame(url, 0.5);

    expect(frame.length).toBeGreaterThan(1000);
    expect(frame.subarray(0, 3).equals(JPEG_MAGIC)).toBe(true);
  }, 30000);

  it('should reject when ffprobe cannot read the input', async () => {
    await expect(
      probe.probe(`${process.env.S3_ENDPOINT}/videos/does-not-exist`),
    ).rejects.toThrow(/ffprobe exited with code/);
  }, 30000);
});
