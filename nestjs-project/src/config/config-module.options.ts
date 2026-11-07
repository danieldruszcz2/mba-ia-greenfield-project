import type { ConfigModuleOptions } from '@nestjs/config';
import appConfig from './app.config';
import authConfig from './auth.config';
import databaseConfig from './database.config';
import { envValidationSchema } from './env.validation';
import mailConfig from './mail.config';
import redisConfig from './redis.config';
import storageConfig from './storage.config';
import swaggerConfig from './swagger.config';

/** Shared by the API (`AppModule`) and the video worker (`WorkerModule`). */
export const configModuleOptions: ConfigModuleOptions = {
  isGlobal: true,
  load: [
    appConfig,
    authConfig,
    databaseConfig,
    mailConfig,
    swaggerConfig,
    storageConfig,
    redisConfig,
  ],
  validationSchema: envValidationSchema,
  validationOptions: { allowUnknown: true, abortEarly: false },
};
