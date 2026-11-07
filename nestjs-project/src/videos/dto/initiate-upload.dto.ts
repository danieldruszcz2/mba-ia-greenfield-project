import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsString, MaxLength, Min } from 'class-validator';

export class InitiateUploadDto {
  /** Video title, e.g. "Meu vídeo". */
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  title: string;

  /** Original file name, e.g. "clip.mp4". */
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  filename: string;

  /** MIME type: `video/mp4` or `video/webm` (checked by the service, `UNSUPPORTED_VIDEO_TYPE`). */
  @IsString()
  @IsNotEmpty()
  contentType: string;

  /** File size in bytes, at most 10737418240 (10 GiB, enforced by the service, `VIDEO_TOO_LARGE`). */
  @IsInt()
  @Min(1)
  sizeBytes: number;
}

export class InitiateUploadResponseDto {
  @ApiProperty({ example: 'aB3dE_fG9hK', description: 'Public ID (11 chars)' })
  id: string;

  @ApiProperty({ example: 'uploading' })
  status: string;

  @ApiProperty({ example: 67108864 })
  partSizeBytes: number;

  @ApiProperty({ example: 2 })
  partCount: number;
}
