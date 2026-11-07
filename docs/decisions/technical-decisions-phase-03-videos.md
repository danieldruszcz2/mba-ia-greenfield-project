---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-11-03
scope_description: "Backend-only video upload and processing foundation: object storage, background job queue and worker, resumable 10GB uploads, draft pre-registration, metadata/thumbnail extraction, unique public video IDs, streaming and download delivery (API side of every contract)."
---

# Technical Decisions — Phase 03: Video Upload & Processing (Backend)

_Subprojects in scope:_

- `nestjs-project/` — the only subproject with work in this phase: new `videos` domain, storage and queue integration, a video worker entrypoint, new Compose services (object storage, Redis), and the env-key contract. Its e2e suite plays the client role (it PUTs parts directly to storage and consumes the stream/download URLs).
- `next-frontend/` — out of scope for the challenge (backend-only), no TD in this phase. Cross-layer TDs below describe **only the API side** of the contract that a future frontend phase will consume. They do not decide frontend implementation.

_Scope input:_ `docs/topics/phase-03-backend-scope.md`.

**Inherited constraints (not reopened):**

- `next-frontend-config-base/TD-03` — **Strict BFF**: in later phases the browser never calls NestJS directly. That TD already said video bytes need "a separate mechanism (presigned URLs from object storage, NOT the backend URL)". So browser ↔ object storage traffic is allowed, and every API endpoint decided here will later be called by a BFF Route Handler, not by the browser.
- `phase-01-configuracao-base/TD-01..04` — `@nestjs/config` + Joi validation + `registerAs` namespaces. New storage and Redis keys extend that schema.
- `phase-02-auth/TD-02, TD-07, TD-08` — custom JWT guards (global guard + `@Public`), the domain exception filter's error shape, and `@nestjs/throttler`.
- `openapi-docs-nestjs/TD-02` — every new endpoint is part of the exported `openapi.json`.
- Tests of storage and queue integrations follow the existing `testing-guide-nestjs-project` rule ("Service with side-effect dep → integration against a real capture service"), the same way Mailpit is used today (real MinIO and Redis from Compose). No TD is needed for this.

**Version note (flagged per CLAUDE.md):** the NestJS 11 queues docs still show Bull's `repeat` job option. In BullMQ, `repeat` was deprecated in 5.16 and **removed in v6** in favor of Job Schedulers (`upsertJobScheduler`). TD-05 and TD-06 assume the Job Scheduler API.

---

## TD-01: Object Storage Server and S3 Client SDK

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The architecture diagram says "S3 or MinIO". We need an S3-compatible service in `nestjs-project/compose.yaml` for dev and tests, and an SDK in both the API and the worker. **Since October 2025, MinIO no longer publishes official Community Edition images or binaries**, and the project is in maintenance mode. Free rebuilds exist (for example, Chainguard's `cgr.dev/chainguard/minio`). As of 2026-11-02, the official `minio/minio` and `quay.io/minio/minio` images could no longer be pulled anonymously. So `minio/minio:latest` is no longer a safe default. Whichever server we pick, the SDK decides whether we can move to AWS S3 later without code changes.

**Options:**

### Option A: MinIO (Chainguard rebuild, pinned) + `@aws-sdk/client-s3` v3
- MinIO runs in Compose, pinned by digest. The code talks to it only through AWS SDK v3 (`forcePathStyle: true`, custom `endpoint`) and `@aws-sdk/s3-request-presigner`. A one-shot `minio-client` service creates the buckets.
- **Pros:** The most widely used S3 emulator. Multipart, presign and Range GET behave like AWS. It has a web console for debugging. With the AWS SDK, moving to real S3 is only a config change. No external account is needed.
- **Cons:** We depend on a third-party rebuild of a frozen upstream. MinIO's CORS handling differs from AWS (it is global, not per-bucket). Lifecycle rules do not support `AbortIncompleteMultipartUpload` (see TD-05).

### Option B: Garage (or another maintained S3-compatible server) + `@aws-sdk/client-s3` v3
- Same SDK approach, with an actively maintained server.
- **Pros:** Maintained upstream with an official image. Still portable to AWS S3.
- **Cons:** Less complete S3 coverage. More initial setup (layout and key creation). Fewer examples for the multipart + presign + CORS combination.

### Option C: MinIO + `minio` JS SDK
- The `minio` npm client for presign, multipart and bucket admin.
- **Pros:** Slightly simpler API for MinIO-only operations.
- **Cons:** Ties the code to a vendor whose distribution has stalled. Weaker path to AWS S3. Per-part presigning is less direct than `UploadPartCommand` + `getSignedUrl`.

**Recommendation:** **Option A.** MinIO is the closest to AWS for exactly the features this phase relies on (multipart, per-part presign, Range GET), and the AWS SDK keeps every line of code plain S3. Switching servers later is then only a Compose and env change. Pin the image by digest, never `latest`. Pick B if depending on a frozen upstream is unacceptable.

**Decision:** A (MinIO + @aws-sdk/client-s3 v3)
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

---

## TD-02: Bucket Topology and Object Access Policy

**Scope:** Cross-layer

**Capability:** Transversal — covers: Serviço de armazenamento de arquivos (vídeos e thumbnails); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The API (presigning), the worker (reads originals, writes thumbnails) and, in later phases, the clients all touch the same objects. **API side of the contract:** the decision fixes what the API returns for a thumbnail in every video payload (a stable URL vs. a signed, expiring URL). Video listings from Phase 04 to Phase 07 inherit that shape. How a future frontend renders or caches it is not decided here.

**Options:**

### Option A: Single private bucket, every read presigned
- One bucket with prefixes (`videos/{videoId}/original`, `thumbnails/{videoId}.jpg`). Every read, thumbnails included, is a short-lived presigned GET.
- **Pros:** One bucket, one policy, nothing publicly readable.
- **Cons:** Every listing payload must sign one URL per item. URLs change on every response, so no consumer can cache them, and they expire inside long-lived pages.

### Option B: Two buckets — private `videos`, public-read `thumbnails`
- Originals are reachable only through presigned URLs (TD-11). Thumbnails live in a bucket with an anonymous-read policy. The API returns a stable `thumbnailUrl` = `{S3_PUBLIC_ENDPOINT}/{thumbnails-bucket}/{key}`.
- **Pros:** Stable, cacheable thumbnail URLs. Simple listing payloads. The access rule is visible at bucket level. Phase 04's custom thumbnail upload reuses the same bucket.
- **Cons:** Two buckets to create and configure. Anyone who knows a thumbnail key can read it, which is acceptable only if keys are not guessable (internal UUID).

### Option C: Single bucket with a public-read policy on the `thumbnails/` prefix
- Same as B, using a prefix-scoped anonymous-read policy.
- **Pros:** One bucket, same caching benefit.
- **Cons:** A policy mistake can expose originals. Prefix policies are more fragile and harder to review than a whole-bucket rule.

**Recommendation:** **Option B.** Thumbnails appear in every listing from Phase 04 onwards, so a stable URL in the API payload matters more than having a single bucket. Originals, which carry the real access rules, stay fully private. Object keys use the internal UUID, not the public ID (TD-12), so public thumbnail URLs cannot be enumerated. Buckets and policies are created by an idempotent init service in Compose.

**Decision:** B (bucket videos privado + thumbnails público)

---

## TD-03: Client-Facing Storage Endpoint for Presigned URLs

**Scope:** Cross-layer

**Capability:** Transversal — covers: Serviço de armazenamento de arquivos (vídeos e thumbnails); Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance; Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** The root CLAUDE.md requires Compose service names for traffic between containers, so the API and worker reach storage at `http://minio:9000`. But a SigV4 presigned URL **signs the host**. A URL signed for `minio:9000` cannot be opened from the host machine (e2e running on the host, a browser later), and rewriting the host afterwards breaks the signature. **API side of the contract:** the Joi schema, `.env.example`, `compose.yaml`, the S3 client factory, and every presigned URL the API returns all depend on this. The storage CORS configuration (allowed origin, `ExposeHeaders: ETag` so a browser client can read part ETags) is storage configuration owned by this subproject's Compose. A future frontend only consumes it.

**Options:**

### Option A: Dual endpoint — `S3_ENDPOINT` (internal) + `S3_PUBLIC_ENDPOINT` (client-facing)
- Two `S3Client` instances. One does I/O against `S3_ENDPOINT=http://minio:9000`. The other is used **only for presigning** against `S3_PUBLIC_ENDPOINT=http://localhost:9000` (dev). Presigning is a local computation, so the signing client never needs to reach that host from inside the container.
- **Pros:** Follows the service-name rule for container traffic and still produces URLs that clients outside Docker can open. Maps directly to production (internal VPC endpoint vs. public/CDN hostname). Explicit and testable.
- **Cons:** Two clients and two keys to keep consistent. Developers must understand why they differ.

### Option B: Single endpoint resolvable from both sides (`host.docker.internal:9000`)
- Containers resolve it via `extra_hosts: host-gateway`, and the host resolves it via a hosts-file entry.
- **Pros:** One client, one key.
- **Cons:** Breaks the CLAUDE.md service-name rule. Needs per-machine hosts-file setup. Container traffic loops through the host network.

### Option C: Reverse-proxy storage under the API origin
- Storage is exposed under a path of the API's public origin, and URLs are signed for that host.
- **Pros:** One public origin, no CORS.
- **Cons:** 10GB uploads and every stream would cross a proxy in front of the API, which defeats the "no performance impact" requirement. `Host` header rewriting breaks SigV4 unless signing targets the proxied host.

**Recommendation:** **Option A.** It is the only option that follows the CLAUDE.md networking rule and still returns usable signed URLs, and it keeps bytes off the Node processes. Proposed canonical keys: `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET_VIDEOS`, `S3_BUCKET_THUMBNAILS`, plus `REDIS_HOST`/`REDIS_PORT` for TD-06. Final names are fixed in planning. The internal/public split is the decision. The worker signs its ffprobe/ffmpeg input URLs with the **internal** client (TD-09), because it runs inside the Docker network.

**Decision:** A (S3_ENDPOINT interno + S3_PUBLIC_ENDPOINT público)

---

## TD-04: Large-File Upload Protocol (up to 10GB, resumable)

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** A 10GB file must upload "without impact on performance", and project-plan §4 asks for resuming after a connection failure. A single S3 `PutObject` is limited to **5GB**, so 10GB needs S3 multipart or a server-side chunking protocol. **API side of the contract:** the decision defines the upload endpoints, their request/response shapes, and who talks to storage. In this phase the e2e suite acts as the client. Any future client (behind the strict BFF) only orchestrates these endpoints.

**Options:**

### Option A: S3 Multipart Upload with per-part presigned URLs, orchestrated by the API
- `initiate`: validates limits (TD-05), creates the draft video (TD-13), calls `CreateMultipartUpload`, and returns `videoId`/`publicId`, `uploadId` and the part size. `sign-parts`: returns presigned `UploadPart` URLs for the requested part numbers. The client PUTs parts **directly to storage** and collects ETags. `complete`: the API calls `CompleteMultipartUpload` and enqueues processing (TD-08). `abort` cancels.
- **Pros:** The API never touches the bytes. Each part retries on its own. Resume uses `ListParts` on the same `uploadId`. Up to 10,000 parts / 5TB. Parallel uploads. Standard S3 semantics.
- **Cons:** Several control-plane round trips and more client logic (concurrency, ETag bookkeeping). Needs CORS (TD-03) and cleanup of abandoned uploads (TD-05).

### Option B: tus protocol in NestJS (`@tus/server` + `@tus/s3-store`)
- An open resumable-upload protocol. The API receives chunks and streams them into S3 multipart.
- **Pros:** Resume is part of the protocol. Mature clients exist.
- **Cons:** All 10GB flow through NestJS (and later through the BFF too), using CPU, memory and bandwidth in the API. That works against the core non-functional requirement. Adds a protocol server to the API.

### Option C: Streamed `multipart/form-data` into the API (`@aws-sdk/lib-storage` `Upload`)
- One HTTP request per file. The API streams the body into S3 multipart as it arrives.
- **Pros:** The simplest client.
- **Cons:** No resume: a dropped connection at 9.5GB restarts from zero. Same byte path through Node as B. Long requests hit proxy and body-size timeouts.

**Recommendation:** **Option A.** It is the only option where the 10GB payload never touches a Node process, which is the literal requirement, and it gives resume through `ListParts` without a custom protocol server. The extra calls are small JSON requests. Depends on TD-03 (signing endpoint) and is detailed by TD-05 (limits and cleanup).

**Decision:** A (S3 multipart com URL pré-assinada por parte)
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

---

## TD-05: Upload Limits, Part Size and Abandoned-Upload Cleanup

**Scope:** Cross-layer

**Capability:** Transversal — covers: Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance; Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** The draft is created at `initiate` (capability). Clients drop out, so some drafts never complete and leave a DB row plus an incomplete multipart upload holding storage. S3 constraints: parts of 5 MiB–5 GiB (except the last), at most 10,000 per upload. **MinIO lifecycle rules do not support `AbortIncompleteMultipartUpload`.** MinIO purges stale uploads on an internal schedule, and AWS needs a lifecycle rule. Neither cleans the DB draft. **API side of the contract:** the limits are enforced by the `initiate` DTO and returned to the client (part size), so any future client must follow what the API dictates.

**Options:**

### Option A: Server-dictated limits + application-level cleanup job
- `initiate` validates `size ≤ 10 GiB` and a MIME/extension allowlist (aligned with TD-10's playability gate), and returns a **server-chosen part size** (for example, 64 MiB → 160 parts at 10 GiB). A scheduled job on the TD-06 queue (BullMQ Job Scheduler, `upsertJobScheduler`) finds drafts still `uploading` past a threshold (for example, 24h), calls `AbortMultipartUpload`, and removes or fails the draft.
- **Pros:** Same behavior on MinIO and S3. Cleans storage **and** DB together. The client cannot pick an unsafe part size.
- **Cons:** One more scheduled job to write and test.

### Option B: Server-dictated limits + storage-native expiry only
- Same limits. Incomplete uploads are left to the storage engine, and orphan drafts are hidden by a staleness filter.
- **Pros:** No cleanup code.
- **Cons:** Behavior differs by backend (MinIO's purge is undocumented, and its lifecycle rule is unsupported). Orphan rows build up forever. Cleanup cannot be tested reliably.

### Option C: Client-chosen part size, explicit `abort` only
- The client picks the part size and calls `abort` on cancel. No background cleanup.
- **Pros:** Simplest.
- **Cons:** Crashes and closed tabs leak storage and drafts permanently. The server cannot defend the 10,000-part or minimum-size limits.

**Recommendation:** **Option A.** It is the only option where cleanup behaves the same on MinIO and S3, and the only one that also cleans the draft row the capability creates. The cleanup reuses the TD-06 queue through a Job Scheduler, so it adds no infrastructure. Thresholds are policy parameters. Suggested values for planning: 64 MiB parts, 10 GiB max, 24h staleness window, allowlist matching TD-10.

**Decision:** A (limites definidos pelo servidor + job de limpeza)

---

## TD-06: Background Job Queue

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture diagram still says "Message Queue — TBD". Processing (ffprobe and thumbnail for files up to 10GB) must run outside the request cycle, with retries and idempotency. The choice adds (or not) an infrastructure service to Compose, and it picks the Nest integration used by the API (producer) and the worker (consumer).

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq`)
- A Redis-backed queue. The official Nest module provides `BullModule.forRootAsync`/`registerQueue`, `@Processor` + `WorkerHost`, and default job options (`attempts`, `backoff`).
- **Pros:** First-party Nest integration. Exponential backoff retries, dedup by custom `jobId` (`jobId = videoId` makes enqueueing idempotent), Job Schedulers (TD-05 cleanup), concurrency control, stalled-job recovery.
- **Cons:** Adds Redis to Compose and to the test environment. Redis must be configured for queue durability (`maxmemory-policy noeviction`, persistence). A retained job with the same `jobId` blocks re-adding, so the retention options must allow reprocessing.

### Option B: pg-boss (PostgreSQL-backed)
- A job queue in Postgres tables using `SKIP LOCKED`.
- **Pros:** No new infrastructure. Jobs can be enqueued in the **same transaction** as the video row.
- **Cons:** No official Nest module. Queue load lands on the primary DB. The diagram models the queue as a separate container. Smaller ecosystem.

### Option C: RabbitMQ (`@nestjs/microservices` RMQ transport or `amqplib`)
- An AMQP broker with acks and dead-letter exchanges.
- **Pros:** A real broker with strong delivery semantics, and it suits consumers in other languages.
- **Cons:** Heavier to operate. Nest's RMQ transport targets RPC/events, not jobs. Retry/backoff and scheduled jobs need DLX/TTL plumbing.

**Recommendation:** **Option A.** It matches the diagram's separate queue container, has the only first-party Nest integration of the three, and gives TD-13 (retries, idempotent `jobId`) and TD-05 (scheduled cleanup) what they need out of the box. pg-boss is the strongest alternative if avoiding new infrastructure becomes a priority.

**Decision:** A (BullMQ + Redis)
**Libraries:** @nestjs/bullmq, bullmq

---

## TD-07: Video Worker Deployment Topology

**Scope:** Backend

**Capability:** Transversal — covers: Serviço de processamento em segundo plano (filas); Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The diagram has a separate "Video Worker (FFmpeg)" container. Processing is CPU- and IO-heavy and must not slow down the API. The worker needs FFmpeg plus access to DB, storage and queue, and it shares the `Video` entity and config with the API.

**Options:**

### Option A: Separate container, same codebase, second entrypoint
- `src/worker.ts` bootstraps `NestFactory.createApplicationContext(WorkerModule)` with no HTTP server. It runs as its own Compose service from the same project, with FFmpeg in its image. The API registers only the producer side.
- **Pros:** Matches the diagram. Isolates CPU load and scales on its own. Reuses entities, config namespaces and the TypeORM setup. One `package.json`, one test suite.
- **Cons:** Two processes in dev. Module wiring must keep the processor out of the API's module graph.

### Option B: In-process processor inside the API
- `@Processor` registered in the API application.
- **Pros:** Simplest setup.
- **Cons:** FFmpeg competes with HTTP handling, which goes against "without impact on performance". The API image needs FFmpeg. Contradicts the diagram.

### Option C: Separate subproject (`video-worker/`)
- An independent package with its own manifest and config.
- **Pros:** Maximum isolation.
- **Cons:** Duplicates entities, config validation and DB setup, or forces a monorepo/shared-package decision this phase does not need.

**Recommendation:** **Option A.** It gives the isolation the diagram and the requirement ask for without duplicating the domain model. `createApplicationContext` is the idiomatic NestJS way to run a standalone worker.

**Decision:** A (container separado, mesmo código, segundo entrypoint)

---

## TD-08: Processing Trigger

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** Depends on TD-04 and TD-06. Something must move a video from "uploaded" to "queued for processing". The trigger can be our API (it knows when `complete` succeeds) or the storage engine (object-created events).

**Options:**

### Option A: API enqueues on `complete`
- After `CompleteMultipartUpload` succeeds, the API updates the status (TD-13) and adds the job with `jobId = videoId`.
- **Pros:** One explicit, testable code path. Works the same on any S3-compatible backend. The ownership check and the status change happen in the same request. Idempotent through `jobId`.
- **Cons:** A crash between the DB update and the enqueue can leave the video stuck. This is mitigated by an idempotent re-enqueue on a retried `complete` and by a sweep of stuck videos in the TD-05 scheduled job.

### Option B: Storage bucket event notifications
- MinIO/S3 publishes `s3:ObjectCreated:CompleteMultipartUpload` to a target (webhook, Redis, SQS), and a consumer enqueues the job.
- **Pros:** Triggers even if no one calls `complete` (relevant only with client-side completion).
- **Cons:** Targets are configured differently on MinIO and AWS. Adds a webhook or a second consumer. Hard to test deterministically. Redundant under TD-04-A.

**Recommendation:** **Option A.** Under TD-04-A the API already completes the upload, so enqueueing there is the simplest correct trigger and does not couple the code to storage-specific notification setup.

**Decision:** A (API enfileira no complete)

---

## TD-09: Media Inspection Tooling and Input Access

**Scope:** Backend

**Capability:** Transversal — covers: Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The worker must extract duration and metadata (ffprobe) and grab one frame for the thumbnail (ffmpeg). Two linked sub-choices: **how** to call FFmpeg from Node, and **how** to read a file of up to 10GB. Note: `fluent-ffmpeg`, the historical wrapper, is **deprecated on npm and unmaintained**.

**Options:**

### Option A: Direct `ffprobe`/`ffmpeg` CLI via `child_process.spawn`, input over presigned HTTP URL
- The worker image installs FFmpeg from the distro. The worker runs `ffprobe -print_format json -show_format -show_streams <url>` and `ffmpeg -ss <t> -i <url> -frames:v 1 ...`, where `<url>` is presigned with the internal client (TD-03). FFmpeg uses HTTP Range and fetches only what it needs.
- **Pros:** No deprecated wrapper. The JSON output is parsed into typed DTOs. **No 10GB download**: probing and a single-frame seek read only headers and a small range. Worker disk stays near zero.
- **Cons:** We write a thin typed wrapper (arguments, exit codes, stderr). MP4s with `moov` at the end need an extra range read (FFmpeg handles it).

### Option B: Direct CLI on a local copy of the original
- Stream the object to a temp volume, then run FFmpeg on the file.
- **Pros:** Local file I/O is the most predictable for FFmpeg.
- **Cons:** Up to 10GB of disk and transfer per job, mostly wasted for a probe and one frame. Temp-volume sizing and cleanup. Slower, and limits concurrency.

### Option C: `fluent-ffmpeg` wrapper
- A fluent API over the CLI.
- **Pros:** Familiar, many examples.
- **Cons:** Deprecated and unmaintained, which adds dependency risk for two simple commands.

**Recommendation:** **Option A.** Probing and single-frame extraction never need the full file, so reading over HTTP Range avoids moving 10GB per job, and calling the CLI directly avoids a deprecated dependency. Frame policy is a planning parameter. Suggested: a frame at about 10% of the duration, clamped for very short videos.

**Decision:** A (ffprobe/ffmpeg CLI via URL pré-assinada)

---

## TD-10: Streaming Format and Playability

**Scope:** Cross-layer

**Capability:** Reprodução via streaming (sem necessidade de download completo)

**Context:** "Streaming without full download" can mean progressive HTTP playback (Range requests on one file) or adaptive streaming (HLS/DASH segments). This decides what the worker produces and what storage holds. **API side of the contract:** what the stream URL (TD-11) points to and which uploads the API accepts. The phase's processing capabilities are **metadata + thumbnail only**. Transcoding is not listed, but an MKV/HEVC original will not play in most browsers.

**Options:**

### Option A: Progressive playback of the original + playability gate
- The original is served as-is with HTTP Range (storage returns `206`). `initiate` restricts uploads to browser-oriented containers (for example, `video/mp4`, `video/webm`). The worker's ffprobe step checks the codecs (for example, H.264/VP9/AV1 video, AAC/Opus audio). Anything not playable ends as `failed` with a reason (TD-13).
- **Pros:** No transcoding, no extra storage. Fits the phase's processing scope exactly. Any future player is a plain `<video src>`.
- **Cons:** No adaptive bitrate (a 4K original streams at 4K). Users with other formats must convert before uploading.

### Option B: Normalize to a "faststart" H.264/AAC MP4
- The worker always produces a web-optimized MP4: a remux (`-c copy -movflags +faststart`) when the codecs fit, a transcode otherwise.
- **Pros:** Accepts almost any input. Fast start.
- **Cons:** Transcoding 10GB inputs is CPU-heavy (minutes to hours). Doubles storage unless the original is deleted. Goes beyond the phase's processing scope.

### Option C: HLS adaptive streaming (multi-rendition transcode)
- The worker produces an HLS ladder plus a playlist.
- **Pros:** YouTube-like adaptive quality.
- **Cons:** By far the heaviest compute and storage cost. Download (a separate capability) still needs the original. Clearly outside this phase.

**Recommendation:** **Option A.** It meets "streaming without full download" with zero transcoding and stays inside the phase's scope (duration, metadata, thumbnail). The codec gate turns "won't play" into an explicit `failed` state. B is the natural next step if format coverage becomes a requirement, and it would not change the delivery contract (TD-11).

**Decision:** A (playback progressivo do original + gate de codec)

---

## TD-11: Streaming and Download Delivery Endpoint Contract

**Scope:** Cross-layer

**Capability:** Transversal — covers: Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** The bytes must reach the client with Range support (streaming) and with `Content-Disposition: attachment` (download), and access must be checked first (TD-14). The diagram shows "Frontend → Object Storage: Streams". **API side of the contract:** this TD fixes how the NestJS API hands out playback/download access. Under the inherited strict BFF, a future frontend reaches these endpoints only through a Route Handler. How that handler exposes them to the browser (pass-through JSON, its own 302, etc.) belongs to the frontend phase and is not decided here.

**Options:**

### Option A: Presigned URLs embedded in the video detail payload
- `GET /videos/:publicId` includes `streamUrl` (and `downloadUrl`, signed with `ResponseContentDisposition=attachment; filename=...`) when the caller has access.
- **Pros:** No bytes through Node. Storage handles Range/206. One call.
- **Cons:** Every detail read signs URLs, even when nobody plays the video. Signed URLs become part of a general-purpose (and later cacheable) payload and expire inside it.

### Option B: API proxy endpoint (`Range` → `GetObject` → `206`)
- `GET /videos/:publicId/stream` streams bytes from storage through NestJS.
- **Pros:** Full control: per-request auth, analytics, no signed URLs exposed.
- **Cons:** Every byte of every view crosses NestJS (and later the BFF too). That is the worst case for performance and conflicts with the requirement and the diagram.

### Option C: Dedicated signing endpoints returning JSON
- `GET /videos/:publicId/stream-url` and `GET /videos/:publicId/download-url` check access and return `{ url, expiresAt }`, freshly presigned with the public client (TD-03). The download variant sets `ResponseContentDisposition=attachment`.
- **Pros:** No bytes through Node. Signing happens only on demand, with a short expiry. Explicit, typed OpenAPI responses. Fits the strict BFF: the BFF can relay the JSON or turn it into its own stable-URL 302 later, without API changes. Easy to e2e (get URL → Range GET to MinIO → `206`).
- **Cons:** One extra call before playback. The expiry must still cover a viewing session, because media elements reuse the URL for later Range requests.

### Option D: API endpoint that answers `302` to a freshly presigned URL
- `GET /videos/:publicId/stream` and `/download` check access and respond `302 Location: <presigned URL>`.
- **Pros:** No bytes through Node. A stable endpoint URL.
- **Cons:** The API needs a bearer token, which a `<video src>` cannot send, so a BFF must sit in front anyway and handle the redirect manually (`fetch` follows redirects by default). Redirects are less natural to describe in OpenAPI.

**Recommendation:** **Option C.** It keeps the bytes off Node like A and D, but signs only when playback or download is requested, and its typed JSON response is the easiest contract for a future BFF to build on, whether that BFF passes the URL through or issues its own stable 302. D is equivalent on performance. Pick it if you want the redirect contract fixed in the API now.

**Decision:** C (endpoints que devolvem { url, expiresAt })

---

## TD-12: Unique Public Video Identifier (URL ID)

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a short, unique, never-conflicting public ID for its URLs, used by API routes now and by frontend routes and shared links later. Phase 04 adds **unlisted** videos ("only via link"), so **unguessability** is a hard requirement: any scheme that can be enumerated or decoded leaks unlisted videos. **API side of the contract:** the `:publicId` route parameter and the `publicId` field in payloads. The internal primary key is a separate concern.

**Options:**

### Option A: Random short ID (11 chars, URL-safe) + `UNIQUE` constraint + retry on collision
- Generated at `initiate` from a CSPRNG (`node:crypto` → base64url/base62, or `nanoid`) and stored in a `public_id` column with a unique index. A collision triggers a retry. The internal PK stays a UUID.
- **Pros:** Short, YouTube-like URLs (64^11 ≈ 7×10^19). Not enumerable, so safe for unlisted videos. The DB constraint guarantees no conflicts regardless of probability.
- **Cons:** An extra indexed column and a retry loop. `nanoid` v5 is ESM-only, which clashes with the CommonJS + ts-jest setup. A ~10-line `node:crypto` generator avoids that.

### Option B: Encoded sequential ID (Sqids/Hashids)
- The integer PK is encoded into a short string.
- **Pros:** No collisions by construction. Very short.
- **Cons:** An encoding, not encryption. IDs can be decoded and enumerated, which **fails Phase 04's unlisted requirement**, and they expose upload volume.

### Option C: UUID in the URL
- The UUID PK is the public ID.
- **Pros:** No extra machinery. Unguessable (v4).
- **Cons:** 36-character URLs, far from the short-URL goal in project-plan §4. Ties public URLs to the internal PK forever.

**Recommendation:** **Option A** with `node:crypto` (no dependency, no ESM/Jest friction). It is the only option that is short, unguessable for unlisted videos, and guaranteed conflict-free by the DB `UNIQUE` constraint, which is the literal capability. Storage keys use the internal UUID (TD-02), so the public ID could be rotated without moving objects.

**Decision:** A (ID aleatório de 11 chars + UNIQUE + retry)

---

## TD-13: Video Lifecycle State Model and Processing Failure Policy

**Scope:** Cross-layer

**Capability:** Transversal — covers: Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** The row is created as a draft at `initiate` and moves through upload, processing, and success or failure. The DB enum, the worker and the API responses depend on the state names. **API side of the contract:** the `status` values and `failureReason` exposed in payloads, which future clients will render. **Phase 04 owns "rascunho → publicação" and visibility.** If Phase 03 mixes processing states with publication states in one field, Phase 04 will have to migrate it. The failure policy belongs here too, because TD-10's codec gate and FFmpeg errors must end in a visible state.

**Options:**

### Option A: Processing-lifecycle `status` enum, separate from publication
- `status`: `uploading → processing → ready | failed`, plus `failure_reason`. In Phase 03, "draft" means "not yet published". Phase 04 adds that as its own field(s) (for example, `published_at`/`visibility`). Jobs use `attempts: 3` with exponential backoff and `jobId = videoId`. Non-retryable errors (unsupported codec) fail immediately (BullMQ `UnrecoverableError`). When retries run out, the status becomes `failed` with a reason.
- **Pros:** One responsibility per field (technical pipeline vs. editorial state). Phase 04 extends without touching this enum. Clear terminal states for tests. Idempotent reprocessing.
- **Cons:** Two concepts to explain ("ready but unpublished"). Consumers combine both fields later.

### Option B: Single combined enum (`draft → uploading → processing → ready → published`, `failed`)
- One column covers pipeline and editorial state.
- **Pros:** One field to read.
- **Cons:** Mixes two independent concerns. Reprocessing or editing a published video does not fit a linear enum. Phase 04 would have to redesign it. Breaks the CLAUDE.md single-responsibility principle.

### Option C: Timestamp-derived state (`uploaded_at`, `processed_at`, `failed_at`)
- No enum. The state is computed from which timestamps are set.
- **Pros:** Keeps a history of the steps.
- **Cons:** The derived state must be recomputed the same way everywhere. Invalid combinations are possible. Harder to index and filter.

**Recommendation:** **Option A.** It keeps the Phase 03 pipeline separate from Phase 04's publication flow, so that phase extends the model instead of rewriting it. It also gives the worker's retry policy (TD-06) one explicit terminal state.

**Decision:** A (enum de processamento separado da publicação)

---

## TD-14: Access Policy for Streaming and Download by Video Status

**Scope:** Cross-layer

**Capability:** Transversal — covers: Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** Depends on TD-11 and TD-13. The signing endpoints need an access rule, and the global JWT guard (inherited) requires an explicit `@Public` for anonymous access. The project plan says anonymous users watch freely, but Phase 03 has no publication or visibility field yet (Phase 04), so **every Phase 03 video is effectively an unpublished draft**. **API side of the contract:** which callers get `200` vs. `401`/`403`/`404` on TD-11's endpoints. The anonymous viewing experience is Phase 05.

**Options:**

### Option A: `ready` → public (anonymous allowed); other statuses → owner only
- The endpoints are `@Public` with optional auth. Non-owners get `404` unless `status = ready`.
- **Pros:** Already matches the final product rule ("anonymous watch freely").
- **Cons:** Exposes videos that Phase 04 will consider unpublished drafts. Phase 04 must then **tighten** the rule (ready + unpublished → owner only), which changes a live contract. Optional-auth handling adds guard work.

### Option B: `ready` → any authenticated user; other statuses → owner only
- The endpoints use the default JWT guard. Non-owners get `404` unless `status = ready`.
- **Pros:** Simple with the existing guard. Lets a second user's e2e prove the "ready" rule.
- **Cons:** Still exposes not-yet-published drafts to every logged-in user, so Phase 04 must also tighten it. A rule that no final phase keeps.

### Option C: Owner only, any status
- Only the channel owner can sign stream/download URLs. Other callers get `404` (the video's existence is not revealed).
- **Pros:** Matches "pre-registered as draft" semantics and least privilege. Later phases only **widen** access (publication, visibility, anonymous in Phase 04/05), which is an additive change. No optional-auth plumbing now.
- **Cons:** Phase 03 cannot demonstrate non-owner playback. The rule becomes dependent on Phase 04's publication field.

**Recommendation:** **Option C.** In Phase 03 every video is a draft, so owner-only is the only rule that later phases extend instead of revoke. Note that the previous planning round (`validation.md` AMB-2, 2026-11-02) chose B as a temporary rule. Pick B again if you want a non-owner e2e scenario in this phase.

**Decision:** C (só o dono, qualquer status)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Object storage server and S3 client SDK | A — MinIO (Chainguard, digest-pinned) + `@aws-sdk/client-s3` v3 | A |
| TD-02 | Cross-layer | Bucket topology and object access policy | B — private `videos` + public-read `thumbnails` | B |
| TD-03 | Cross-layer | Client-facing storage endpoint for presigned URLs | A — `S3_ENDPOINT` (internal) + `S3_PUBLIC_ENDPOINT` (signing) | A |
| TD-04 | Cross-layer | Large-file upload protocol (10GB, resumable) | A — S3 multipart, per-part presigned URLs, API-orchestrated | A |
| TD-05 | Cross-layer | Upload limits, part size, abandoned-upload cleanup | A — server-dictated limits + Job Scheduler cleanup | A |
| TD-06 | Backend | Background job queue | A — BullMQ + Redis (`@nestjs/bullmq`) | A |
| TD-07 | Backend | Video worker deployment topology | A — separate container, same codebase, second entrypoint | A |
| TD-08 | Backend | Processing trigger | A — API enqueues on `complete` | A |
| TD-09 | Backend | Media inspection tooling and input access | A — direct ffprobe/ffmpeg CLI over presigned HTTP URL | A |
| TD-10 | Cross-layer | Streaming format and playability | A — progressive original + ffprobe codec gate | A |
| TD-11 | Cross-layer | Streaming and download delivery endpoint contract | C — dedicated signing endpoints returning `{ url, expiresAt }` | C |
| TD-12 | Cross-layer | Unique public video identifier (URL ID) | A — 11-char CSPRNG ID + `UNIQUE` + retry | A |
| TD-13 | Cross-layer | Video lifecycle state model and failure policy | A — processing `status` enum, separate from publication | A |
| TD-14 | Cross-layer | Access policy for streaming/download by status | C — owner only in Phase 03 | C |
