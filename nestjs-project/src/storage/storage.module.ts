import { S3Client } from '@aws-sdk/client-s3';
import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { STORAGE_CLIENTS } from './storage.constants';
import { StorageService } from './storage.service';

const createClient = (
  config: ConfigType<typeof storageConfig>,
  endpoint: string,
): S3Client =>
  new S3Client({
    endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
    },
  });

@Module({
  providers: [
    {
      provide: STORAGE_CLIENTS.INTERNAL,
      inject: [storageConfig.KEY],
      useFactory: (config: ConfigType<typeof storageConfig>) =>
        createClient(config, config.endpoint),
    },
    {
      provide: STORAGE_CLIENTS.PUBLIC,
      inject: [storageConfig.KEY],
      useFactory: (config: ConfigType<typeof storageConfig>) =>
        createClient(config, config.publicEndpoint),
    },
    StorageService,
  ],
  exports: [StorageService],
})
export class StorageModule {}
