import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class CompletedPartDto {
  /** Part number, as signed by `part-urls`. */
  @IsInt()
  @Min(1)
  partNumber: number;

  /** `ETag` header returned by storage for the part PUT. */
  @IsString()
  @IsNotEmpty()
  etag: string;
}

export class CompleteUploadDto {
  /** Every part of the upload, in ascending `partNumber` order. */
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CompletedPartDto)
  parts: CompletedPartDto[];
}

export class CompleteUploadResponseDto {
  @ApiProperty({ example: 'aB3dE_fG9hK' })
  id: string;

  @ApiProperty({ example: 'processing' })
  status: string;
}
