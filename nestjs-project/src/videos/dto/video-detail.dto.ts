import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';

export class VideoMetadataDto {
  @ApiProperty({ nullable: true, example: 'mp4' })
  container: string | null;

  @ApiProperty({ nullable: true, example: 'h264' })
  videoCodec: string | null;

  @ApiProperty({ nullable: true, example: 'aac' })
  audioCodec: string | null;

  @ApiProperty({ nullable: true, example: 1920 })
  width: number | null;

  @ApiProperty({ nullable: true, example: 1080 })
  height: number | null;

  @ApiProperty({ nullable: true, example: 4500000 })
  bitrate: number | null;
}

export class VideoDetailDto {
  @ApiProperty({ example: 'aB3dE_fG9hK', description: 'Public ID (11 chars)' })
  id: string;

  @ApiProperty({ example: 'Meu vídeo' })
  title: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.READY })
  status: VideoStatus;

  @ApiProperty({ example: 104857600 })
  sizeBytes: number;

  @ApiProperty({ example: 'video/mp4' })
  contentType: string;

  @ApiProperty({ nullable: true, example: 5.005 })
  durationSeconds: number | null;

  @ApiProperty({ type: VideoMetadataDto, nullable: true })
  metadata: VideoMetadataDto | null;

  @ApiProperty({
    nullable: true,
    example: 'http://localhost:9000/thumbnails/2f1c9a6e-....jpg',
    description: 'Stable public URL of the thumbnail',
  })
  thumbnailUrl: string | null;

  @ApiProperty({ nullable: true, example: null })
  failureReason: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;
}
