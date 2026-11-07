import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channel: Channel;
  let counter = 0;

  const buildVideo = (overrides: Partial<Video> = {}): Video =>
    videoRepository.create({
      public_id: `pid${String(++counter).padStart(8, '0')}`,
      channel_id: channel.id,
      title: 'Meu vídeo',
      original_filename: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: 104857600,
      part_size_bytes: 67108864,
      storage_key: 'some-id/original',
      ...overrides,
    });

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource
      .getRepository(User)
      .save({ email: `video_entity_${++counter}@example.com`, password: 'x' });
    channel = await dataSource.getRepository(Channel).save({
      name: 'Canal',
      nickname: `canal_${counter}`,
      user_id: user.id,
    });
  });

  it('should default status to uploading', async () => {
    const saved = await videoRepository.save(buildVideo());

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.status).toBe(VideoStatus.UPLOADING);
  });

  it('should round-trip bigint size_bytes as a number', async () => {
    const tenGiB = 10 * 1024 * 1024 * 1024;
    const saved = await videoRepository.save(
      buildVideo({ size_bytes: tenGiB }),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.size_bytes).toBe(tenGiB);
  });

  it('should reject two videos with the same public_id', async () => {
    await videoRepository.save(buildVideo({ public_id: 'dupPublicId' }));

    await expect(
      videoRepository.save(buildVideo({ public_id: 'dupPublicId' })),
    ).rejects.toBeInstanceOf(QueryFailedError);
  });

  it('should delete the videos of a channel when the channel is removed', async () => {
    const saved = await videoRepository.save(buildVideo());

    await dataSource.getRepository(Channel).delete({ id: channel.id });

    expect(await videoRepository.findOneBy({ id: saved.id })).toBeNull();
  });
});
