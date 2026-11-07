import { ApiProperty } from '@nestjs/swagger';

export class SignedUrlDto {
  @ApiProperty({
    example: 'http://localhost:9000/videos/2f1c9a6e-.../original?X-Amz-...',
    description: 'Short-lived presigned URL served directly by storage',
  })
  url: string;

  @ApiProperty({ format: 'date-time' })
  expiresAt: Date;
}
