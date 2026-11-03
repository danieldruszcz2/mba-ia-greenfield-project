import { DataSource, QueryFailedError } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { type NewVideo, VideosRepository } from './videos.repository';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosRepository (integration)', () => {
  let dataSource: DataSource;
  let repository: VideosRepository;
  let newVideo: NewVideo;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    repository = new VideosRepository(dataSource);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'video_repo@example.com', password: 'x' });
    const channel = await dataSource
      .getRepository(Channel)
      .save({ name: 'Canal', nickname: 'canal_repo', user_id: user.id });
    newVideo = {
      channel_id: channel.id,
      title: 'Meu vídeo',
      original_filename: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: 104857600,
      part_size_bytes: 67108864,
      storage_key: 'placeholder/original',
    };
  });

  it('should persist the video with an 11-character public_id', async () => {
    const saved = await repository.insertWithUniquePublicId(newVideo);

    expect(saved.public_id).toMatch(/^[A-Za-z0-9_-]{11}$/);
  });

  it('should retry with another public_id when the first one collides', async () => {
    const taken = await repository.insertWithUniquePublicId(newVideo);
    const generate = jest
      .fn<string, []>()
      .mockReturnValueOnce(taken.public_id)
      .mockReturnValueOnce('freshId_001');

    const saved = await repository.insertWithUniquePublicId(newVideo, generate);

    expect(generate).toHaveBeenCalledTimes(2);
    expect(saved.public_id).toBe('freshId_001');
    expect(await dataSource.getRepository(Video).count()).toBe(2);
  });

  it('should give up after the maximum attempts when every ID collides', async () => {
    const taken = await repository.insertWithUniquePublicId(newVideo);
    const generate = jest.fn<string, []>().mockReturnValue(taken.public_id);

    await expect(
      repository.insertWithUniquePublicId(newVideo, generate),
    ).rejects.toBeInstanceOf(QueryFailedError);
    expect(generate).toHaveBeenCalledTimes(3);
  });
});
