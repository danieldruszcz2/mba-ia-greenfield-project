import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.S3_ENDPOINT ?? '',
  publicEndpoint: process.env.S3_PUBLIC_ENDPOINT ?? '',
  region: process.env.S3_REGION ?? '',
  accessKey: process.env.S3_ACCESS_KEY ?? '',
  secretKey: process.env.S3_SECRET_KEY ?? '',
  buckets: {
    videos: process.env.S3_BUCKET_VIDEOS ?? '',
    thumbnails: process.env.S3_BUCKET_THUMBNAILS ?? '',
  },
}));
