import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  Min,
} from 'class-validator';
import { VIDEO_UPLOAD_LIMITS } from '../videos.constants';

export class PartUrlsDto {
  /** Part numbers to sign (1..100 items, each within `1..partCount` of the video). */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(VIDEO_UPLOAD_LIMITS.MAX_PART_URLS_PER_REQUEST)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  partNumbers: number[];
}

export class PresignedPartUrlDto {
  @ApiProperty({ example: 1 })
  partNumber: number;

  @ApiProperty({ example: 'http://localhost:9000/videos/...' })
  url: string;
}

export class PartUrlsResponseDto {
  @ApiProperty({ type: [PresignedPartUrlDto] })
  parts: PresignedPartUrlDto[];

  @ApiProperty({ format: 'date-time' })
  expiresAt: Date;
}

export class UploadedPartDto {
  @ApiProperty({ example: 1 })
  partNumber: number;

  @ApiProperty({ example: '"9b2cf535f27731c974343645a3985328"' })
  etag: string;

  @ApiProperty({ example: 67108864 })
  sizeBytes: number;
}

export class UploadedPartsResponseDto {
  @ApiProperty({ type: [UploadedPartDto] })
  parts: UploadedPartDto[];
}
