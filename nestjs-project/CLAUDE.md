# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **Redis:** `docker compose exec redis redis-cli ping` — expect `PONG`
- **MinIO:** `docker compose ps -a minio-init` — expect `Exited (0)` (it only exits after MinIO is ready and the buckets exist)
- **Video worker:** `docker compose logs video-worker` — expect `Video worker started`

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — SMTP `1025`, web UI `8025`
- `minio` — S3-compatible object storage, API `9000`, console `9001`
- `minio-init` — one-shot job that creates the `videos` (private) and `thumbnails` (public-read) buckets, then exits
- `redis` — BullMQ backend, port `6379`
- `video-worker` — same image and codebase as the API, entrypoint `src/worker.ts` (no HTTP port); starts with `docker compose up -d` and reloads on changes in `src/`

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm test                                 # Unit + integration tests (*.spec.ts and *.integration-spec.ts)
npm run test:integration                 # Integration tests only (--runInBand)
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npm run migration:run                    # Apply pending TypeORM migrations
npm run openapi:export                   # Regenerate the versioned openapi.json

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config", ".../test/setup-test-env.ts"]` — `setup-test-env.ts` sets the test-only signing endpoint and queue prefix (see "Tests against real infra"). Without `dotenv/config`, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.

## Videos (Phase 03)

Upload, processing and delivery of videos. Plan and decisions: `docs/phases/phase-03-videos/phase-03-videos.md`, `docs/decisions/technical-decisions-phase-03-videos.md`.

### Modules

- `src/storage/` — `StorageModule` / `StorageService`: S3 client (multipart, presigned URLs, ranged GET). Two clients: `STORAGE_CLIENTS.INTERNAL` (talks to `S3_ENDPOINT`) and `STORAGE_CLIENTS.PUBLIC` (only signs client-facing URLs with `S3_PUBLIC_ENDPOINT`).
- `src/queue/` — `QueueModule` (BullMQ on Redis) and `VideoProcessingProducer`. Queues `video-processing` and `video-maintenance` (`src/queue/queue.constants.ts`).
- `src/videos/` — `Video` entity (`src/videos/entities/video.entity.ts`), `VideosRepository`, `VideosService` (upload lifecycle, reads, signed delivery), `VideosController`.
- `src/worker/` — `WorkerModule`, loaded by `src/worker.ts` with `NestFactory.createApplicationContext` (no HTTP):
  - `VideoProcessor` probes metadata with ffprobe, extracts the thumbnail with ffmpeg and moves the status to `ready` or `failed`.
  - `MediaProbeService` wraps ffprobe/ffmpeg.
  - `UploadCleanupScheduler` and `UploadCleanupProcessor` remove `uploading` drafts left untouched for more than 24h, every hour.

### Data and storage

- Table `videos` (migration `src/database/migrations/1793714179427-CreateVideos.ts`), FK `channel_id → channels`. Enum `video_status`: `uploading → processing → ready | failed`. On failure, the reason is stored on the row.
- Each video gets a random, `UNIQUE` `public_id`, retried on collision (`src/videos/public-id.util.ts`). Routes and response bodies use it as `id`; the internal UUID only names storage objects.
- Storage keys: `{videoId}/original` in `S3_BUCKET_VIDEOS` (private) and `{videoId}.jpg` in `S3_BUCKET_THUMBNAILS` (public-read).
- Limits (`src/videos/videos.constants.ts`): max 10 GiB, 64 MiB parts, up to 100 part URLs per request, `video/mp4` and `video/webm` only.

### Endpoints

All routes need a JWT. Every `:id` route is owner-only: a non-owner gets `404 VIDEO_NOT_FOUND`.

| Method & path | Status | Purpose |
|---|---|---|
| `POST /videos` | 201 | Creates the `uploading` draft and opens the multipart upload |
| `POST /videos/:id/upload/part-urls` | 200 | Signs `UploadPart` URLs; the client PUTs the parts directly to storage |
| `GET /videos/:id/upload/parts` | 200 | Lists uploaded parts, to resume an upload |
| `POST /videos/:id/upload/complete` | 202 | Completes the multipart upload and enqueues processing |
| `DELETE /videos/:id/upload` | 204 | Aborts the upload and deletes the draft |
| `GET /videos/:id` | 200 | Detail: status, duration, metadata, thumbnail URL |
| `GET /videos/:id/stream` | 200 | Presigned URL; storage answers `Range` with `206` |
| `GET /videos/:id/download` | 200 | Presigned URL with `Content-Disposition: attachment` |

Error codes (`src/videos/videos.exceptions.ts`):

- `VIDEO_NOT_FOUND`
- `VIDEO_TOO_LARGE`
- `UNSUPPORTED_VIDEO_TYPE`
- `VIDEO_UPLOAD_NOT_IN_PROGRESS`
- `INVALID_UPLOAD_PARTS`
- `VIDEO_NOT_READY`

### Environment

`S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET_VIDEOS`, `S3_BUCKET_THUMBNAILS`, `REDIS_HOST` and `REDIS_PORT` are all required and validated with Joi (`src/config/env.validation.ts`). See `.env.example`.

### Tests against real infra

- Integration and e2e suites use the real MinIO and Redis from Compose.
- `test/setup-test-env.ts` signs URLs with an endpoint reachable inside the network (`S3_TEST_PUBLIC_ENDPOINT`, falling back to `S3_ENDPOINT`). It also sets the queue prefix to `bull-test`, so the running `video-worker` does not consume test jobs.
- Media fixtures live in `test/fixtures/`: `sample.mp4` (h264/aac, playable) and `unplayable.avi` (mpeg4, rejected).
