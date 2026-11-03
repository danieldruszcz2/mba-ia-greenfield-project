---
libs:
  "@aws-sdk/client-s3":
    version: "^3.x"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-03T09:39:53-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.x"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-03T09:39:53-03:00"
  "@nestjs/bullmq":
    version: "^11.x"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-11-03T09:39:53-03:00"
  "bullmq":
    version: "^6.x"
    context7_id: "/taskforcesh/bullmq/v6.5.3"
    fetched_at: "2026-11-03T09:39:53-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-03T09:39:15.880306000-03:00"
---

# Library References — phase-03-videos

None of these libraries are installed in `nestjs-project/package.json` yet. Versions are the target majors. Pin them at install time and check them against these notes.

### @aws-sdk/client-s3

Used by TD-01, TD-03, TD-04 and TD-05.

- MinIO client: `new S3Client({ endpoint, forcePathStyle: true, region, credentials: { accessKeyId, secretAccessKey } })`. `forcePathStyle: true` is required for MinIO (the URL becomes `host/bucket/key`).
- Two clients, per TD-03:
  - Internal client on `S3_ENDPOINT` (`http://minio:9000`), used for server calls and for the worker's ffprobe URLs.
  - Public client on `S3_PUBLIC_ENDPOINT`, used only to sign URLs returned to callers.
- Multipart commands (TD-04 and TD-05):
  - `CreateMultipartUploadCommand` → `UploadId`.
  - `UploadPartCommand`, presigned per part.
  - `ListPartsCommand`, to resume.
  - `CompleteMultipartUploadCommand` with `{ Parts: [{ ETag, PartNumber }] }`.
  - `AbortMultipartUploadCommand`, used by the cleanup job.
- `GetObjectCommand` is the command presigned for stream and download (TD-11). Add `ResponseContentDisposition: 'attachment; filename=...'` for download.

### @aws-sdk/s3-request-presigner

- `getSignedUrl(client, command, { expiresIn })`. `expiresIn` defaults to `900` seconds.
- Works for any command, including `UploadPartCommand`, `GetObjectCommand` and `PutObjectCommand`.
- To sign `x-amz-*` headers, pass them in `unhoistableHeaders` so the client must send them.
- Sign with the **public** client so the URL host can be reached by the caller. The signature includes the host, so a URL signed with the internal endpoint cannot be rewritten.

### @nestjs/bullmq

Used by TD-06, TD-07 and TD-05.

- `BullModule.forRootAsync({ imports, inject: [redisConfig.KEY], useFactory: (cfg) => ({ connection: { host, port } }) })`. This is global and follows the `registerAs` + `inject` convention.
- `BullModule.registerQueue({ name: 'video-processing', defaultJobOptions: { attempts, backoff } })` goes in the feature module.
- Producer: `@InjectQueue('video-processing') queue: Queue`.
- Consumer: `@Processor('video-processing') class X extends WorkerHost { async process(job) {} }`.
  - A rejection marks the job failed, and it retries per `attempts`/`backoff`.
  - Use `this.worker.on('failed', ...)` only from `onApplicationBootstrap` or later.
- Worker (TD-07): register the processor only in the module loaded by the worker entrypoint (`createApplicationContext`), so the API only produces jobs.
- On shutdown the module closes the workers and the queue (`onApplicationShutdown`). Call `app.enableShutdownHooks()` in the worker.

### bullmq

- Retry with backoff: `queue.add(name, data, { attempts: 3, backoff: { type: 'exponential', delay: 1000 } })`. `jitter` is optional. This is the TD-13 retry-then-`failed` policy.
- Idempotency:
  - A fixed `jobId` (for example the video ID) prevents a second job for the same video.
  - Alternatively, `deduplication: { id }` ignores new jobs while the previous one has not finished.
- **v6:** the `repeat` option was removed. Use Job Schedulers: `queue.upsertJobScheduler('upload-cleanup', { pattern | every }, { name, data, opts })`. This is the TD-05 cleanup job, and it is idempotent at boot.
