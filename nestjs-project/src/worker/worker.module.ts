import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { configModuleOptions } from '../config/config-module.options';
import { typeOrmModuleAsyncOptions } from '../database/typeorm-options.factory';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { UsersModule } from '../users/users.module';
import { VideosModule } from '../videos/videos.module';

/**
 * Root module of the video worker process (`src/worker.ts`). Same codebase as
 * the API, but no HTTP server: it only consumes the queues. Processors are
 * registered here (SI-03.8 / SI-03.9).
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
})
export class WorkerModule {}
