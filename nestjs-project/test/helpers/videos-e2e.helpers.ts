import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { AuthService } from '../../src/auth/auth.service';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../../src/common/filters/validation-exception.filter';
import { MailService } from '../../src/mail/mail.service';

/**
 * Booting AppModule (and the first ts-jest compile after an image rebuild)
 * takes well over Jest's default 5 s hook timeout.
 */
export const E2E_SETUP_TIMEOUT_MS = 60_000;

/** Smallest size S3 accepts for every multipart part except the last. */
export const MIN_PART_BYTES = 5 * 1024 * 1024;

export interface E2eApp {
  app: INestApplication<App>;
  moduleFixture: TestingModule;
}

/** Boots AppModule with the same global pipes and filters as `main.ts`. */
export async function createE2eApp(): Promise<E2eApp> {
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new ValidationExceptionFilter(),
  );
  await app.init();
  return { app, moduleFixture };
}

export function clearThrottler(moduleFixture: TestingModule): void {
  moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage).storage.clear();
}

/** Registers, confirms (capturing the e-mailed token) and logs in a user. */
export async function registerConfirmAndLogin(
  app: INestApplication<App>,
  email: string,
  password = 'password123',
): Promise<string> {
  const authService: unknown = app.get(AuthService);
  const { mailService } = authService as { mailService: MailService };
  let confirmationToken = '';
  jest
    .spyOn(mailService, 'sendConfirmationEmail')
    .mockImplementationOnce((_email: string, _name: string, token: string) => {
      confirmationToken = token;
      return Promise.resolve();
    });

  const server = app.getHttpServer();
  await request(server).post('/auth/register').send({ email, password });
  await request(server)
    .get('/auth/confirm-email')
    .query({ token: confirmationToken });
  const login = await request(server)
    .post('/auth/login')
    .send({ email, password });
  return (login.body as { access_token: string }).access_token;
}

/** PUTs bytes straight to a presigned storage URL (outside the API) and returns the ETag. */
export async function putPartToStorage(
  url: string,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<{ status: number; etag: string | null }> {
  const response = await fetch(url, { method: 'PUT', body: bytes });
  return { status: response.status, etag: response.headers.get('etag') };
}
