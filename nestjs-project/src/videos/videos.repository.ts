import { Injectable } from '@nestjs/common';
import { DataSource, QueryFailedError, type Repository } from 'typeorm';
import { Video } from './entities/video.entity';
import { generatePublicId } from './public-id.util';
import { PUBLIC_ID_MAX_ATTEMPTS } from './videos.constants';

const PG_UNIQUE_VIOLATION = '23505';
const PUBLIC_ID_COLUMN = 'public_id';

function isPublicIdCollision(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const driverError = err.driverError as { code?: string; detail?: string };
  return (
    driverError.code === PG_UNIQUE_VIOLATION &&
    typeof driverError.detail === 'string' &&
    driverError.detail.includes(PUBLIC_ID_COLUMN)
  );
}

export type NewVideo = Omit<
  Partial<Video>,
  'id' | 'public_id' | 'created_at' | 'updated_at' | 'channel'
> &
  Pick<
    Video,
    | 'channel_id'
    | 'title'
    | 'original_filename'
    | 'content_type'
    | 'size_bytes'
    | 'part_size_bytes'
  >;

@Injectable()
export class VideosRepository {
  private readonly repository: Repository<Video>;

  constructor(dataSource: DataSource) {
    this.repository = dataSource.getRepository(Video);
  }

  /**
   * Inserts the video with a fresh random `public_id`, regenerating it when the
   * UNIQUE constraint rejects a collision. Not wrapped in a transaction, so a
   * failed insert does not abort subsequent attempts.
   */
  async insertWithUniquePublicId(
    data: NewVideo & { id?: string },
    generate: () => string = generatePublicId,
  ): Promise<Video> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.repository.save(
          this.repository.create({ ...data, public_id: generate() }),
        );
      } catch (err) {
        if (!isPublicIdCollision(err) || attempt >= PUBLIC_ID_MAX_ATTEMPTS) {
          throw err;
        }
      }
    }
  }
}
