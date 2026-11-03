import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { configModuleOptions } from '../config/config-module.options';
import { typeOrmModuleAsyncOptions } from '../database/typeorm-options.factory';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { UsersModule } from '../users/users.module';
import { VideosModule } from '../videos/videos.module';
import { MediaProbeService } from './media-probe.service';
import { VideoProcessor } from './video.processor';

/**
 * Root module of the video worker process (`src/worker.ts`). Same codebase as
 * the API, but no HTTP server: it only consumes the queues; the processors
 * are registered here.
 *
 * `UsersModule` is imported so the `User` entity metadata exists — `Video`
 * reaches it through `Channel`.
 */
@Module({
  imports: [
    ConfigModule.forRoot(configModuleOptions),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      ...typeOrmModuleAsyncOptions,
    }),
    UsersModule,
    VideosModule,
    StorageModule,
    QueueModule,
  ],
  providers: [MediaProbeService, VideoProcessor],
})
export class WorkerModule {}
