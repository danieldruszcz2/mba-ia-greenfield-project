---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-11-02
scope_description: "Video upload and processing foundation: object storage, background job queue and worker, resumable 10GB uploads, draft pre-registration, metadata/thumbnail extraction, unique public video IDs, streaming and download delivery."
---

# Technical Decisions — Phase 03: Video Upload & Processing

_Subprojects in scope:_

- `nestjs-project/` — main subject: new `videos` domain, storage and queue integration, video worker entrypoint, new Compose services (object storage, Redis), env-key contract.
- `next-frontend/` — upload client (browser → object storage via presigned URLs, orchestrated through BFF Route Handlers) and the consumer side of the streaming/download, URL-ID and thumbnail contracts. The watch page and player UI belong to Phase 05; only the contracts they depend on are decided here.

**Inherited constraints (not reopened):**

- `next-frontend-config-base/TD-03` — **Strict BFF**: the browser never calls NestJS directly. That TD already said that video bytes would need "a separate mechanism (presigned URLs from object storage, NOT the backend URL)". Browser ↔ object storage traffic therefore does **not** violate the BFF rule. Browser ↔ NestJS traffic still goes through `app/api/**`.
- `phase-01-configuracao-base/TD-01..04` — `@nestjs/config` + Joi validation + `registerAs` namespaces. New keys (storage, Redis) extend that schema.
- `phase-02-auth/TD-02, TD-07, TD-08` — custom JWT guards, domain exception filter error shape, `@nestjs/throttler`.
- `openapi-docs-nestjs/TD-02` + `next-frontend-openapi-typing/*` — every new endpoint is in the exported `openapi.json`. The FE consumes its types through `openapi-typescript`.
- Testing of storage/queue integrations follows the existing `testing-guide-nestjs-project` rule ("Service with side-effect dep → integration against a real capture service"), the same way Mailpit is used today. No TD is needed for this.

---

## TD-01: Object Storage Server and S3 Client SDK

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The architecture diagram says "S3 or MinIO". We need an S3-compatible service in `nestjs-project/compose.yaml` for dev and test, and an SDK in the API and the worker. **Since 2025-10-23, MinIO no longer publishes official Community Edition Docker images or binaries.** The project is in maintenance mode. Free rebuilds exist (for example, Chainguard's `cgr.dev/chainguard/minio`), and the last community tag is still on quay.io. So "just use `minio/minio:latest`" is no longer a safe default. Whichever server we pick, the SDK choice decides whether we can move to AWS S3 later without code changes.

**Options:**

### Option A: MinIO (pinned community release or Chainguard rebuild) + `@aws-sdk/client-s3` v3
- MinIO runs in Compose with the image pinned to an exact tag. The code talks to it only through the AWS SDK v3 (`forcePathStyle: true`, custom `endpoint`) and `@aws-sdk/s3-request-presigner`.
- **Pros:** MinIO is the most widely used S3 emulator: multipart, presign and Range all behave like AWS. It has a web console for debugging. Using the AWS SDK means production can be real S3 with only a config change.
- **Cons:** The upstream image is frozen with no new security fixes, so we depend on a pinned tag or a third-party rebuild. MinIO's CORS handling differs from AWS (it is global rather than per-bucket `PutBucketCors`) and must be verified for browser uploads. MinIO's lifecycle rules do not support `AbortIncompleteMultipartUpload`.

### Option B: Garage (or another maintained S3-compatible server) + `@aws-sdk/client-s3` v3
- Same SDK approach as A, but the Compose service is an actively maintained S3-compatible server such as Garage.
- **Pros:** Maintained upstream with an official image. Same S3 API surface through the AWS SDK, so it stays portable to AWS S3.
- **Cons:** Less complete S3 coverage than MinIO (some advanced APIs are missing). It needs more initial setup (layout/key creation commands). Fewer examples and community answers for the multipart + presign + CORS combination.

### Option C: MinIO + `minio` JS SDK
- The `minio` npm client provides `presignedUrl`, multipart helpers and bucket admin calls.
- **Pros:** The API is a bit simpler for MinIO-specific operations such as bucket policy and notifications.
- **Cons:** It ties the code to a vendor whose server distribution has stalled. Docs and examples for moving to real AWS S3 are weaker. Its multipart presign support for per-part browser uploads is less direct than `UploadPartCommand` + `getSignedUrl`.

**Recommendation:** **Option A**, with the SDK fixed as `@aws-sdk/client-s3` v3. MinIO's behavior is the closest to AWS for the exact features this phase depends on (multipart, per-part presigning, Range GETs). Pin the image to an exact tag, never `latest`. Because all code talks plain S3 through the AWS SDK, switching to Garage, SeaweedFS or real S3 later is only a Compose and env change. Choose B if you would rather not depend on a frozen image at all.

**Decision:** A (MinIO + `@aws-sdk/client-s3` v3) — image `cgr.dev/chainguard/minio` (Chainguard rebuild, pulls without any account; official `minio/minio` and `quay.io/minio/minio` are no longer pullable anonymously, verified 2026-11-02), pinned by digest (`sha256:6adcdf68245544a8545bd9b4d2f0053ccf9fc41a74fc1437b6894b823350df64` at decision time); bucket init via `cgr.dev/chainguard/minio-client`. Constraint from the user: simple local setup, no external accounts.

---

## TD-02: Bucket Topology and Object Access Policy

**Scope:** Cross-layer

**Capability:** Transversal — covers: Serviço de armazenamento de arquivos (vídeos e thumbnails); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** Three components read or write the same objects: the API (presigning), the worker (reads originals, writes thumbnails), and the frontend (renders thumbnails, plays videos). Whether thumbnails get a stable public URL or a presigned, expiring one changes the frontend a lot. Expiring URLs break `next/image` caching and HTML caching, and they change what the API returns in every video-listing payload in Phases 04–07.

**Options:**

### Option A: Single private bucket, every read presigned
- One bucket (`streamtube`) with prefixes (`videos/{videoId}/original`, `thumbnails/{videoId}.jpg`). Every read, thumbnails included, is a short-lived presigned GET issued by the API.
- **Pros:** One bucket, one policy, and nothing is publicly readable.
- **Cons:** Every listing payload must embed freshly signed thumbnail URLs, which is costly for grids. URLs change on every response, which defeats browser, CDN and `next/image` caching. URLs can expire inside long-lived pages.

### Option B: Two buckets — private `videos`, public-read `thumbnails`
- Originals live in a private bucket and are reached only through presigned URLs (see TD-12). Thumbnails live in a separate bucket with an anonymous-read policy. The API returns a stable URL, `{S3_PUBLIC_ENDPOINT}/thumbnails/{key}`.
- **Pros:** Thumbnails can be cached and are compatible with `next/image` (`remotePatterns` for one host). Listing payloads stay simple. The access policy is obvious at the bucket level. Phase 04's custom thumbnail upload reuses the same bucket.
- **Cons:** Two buckets to create and configure. Thumbnails of unlisted or not-yet-published videos are readable by anyone who knows the key, which is acceptable only if keys are not guessable (UUID-based).

### Option C: Single bucket with a public-read policy on the `thumbnails/` prefix
- Same idea as B, but with a prefix-scoped anonymous-read policy inside one bucket.
- **Pros:** One bucket, with the same caching benefits as B.
- **Cons:** A mistake in the policy can expose originals. Prefix-scoped policies are more fragile and are reviewed less clearly than a whole-bucket rule.

**Recommendation:** **Option B.** Thumbnails appear in every listing from Phase 04 to Phase 07, so stable, cacheable URLs matter more than having one bucket. Originals, which carry the real access-control needs, stay fully private. Object keys are built from the internal UUID primary key, not the public slug (TD-13), so public thumbnail URLs cannot be enumerated. Buckets are created by an idempotent init step in Compose (for example, an `mc`/CLI one-shot service). The exact mechanism is up to implementation.

**Decision:** B (private `videos` bucket + public-read `thumbnails` bucket)

---

## TD-03: Client-Facing Storage Endpoint for Presigned URLs

**Scope:** Cross-layer

**Capability:** Transversal — covers: Serviço de armazenamento de arquivos (vídeos e thumbnails); Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance; Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** The root CLAUDE.md requires Compose service names for traffic between containers. The API and worker therefore reach storage at `http://minio:9000`. But a SigV4 presigned URL **signs the host**. A URL signed for `minio:9000` cannot be opened by the browser, and rewriting the host afterwards invalidates the signature. This is a cross-component contract: the Joi schema, `.env.example`, `compose.yaml`, the S3 client factory, and the browser all depend on it. The bucket CORS config (allowed origin = the Next.js origin; `ExposeHeaders: ETag` is required so the browser can read part ETags) belongs to the same contract.

**Options:**

### Option A: Dual endpoint — `S3_ENDPOINT` (internal) + `S3_PUBLIC_ENDPOINT` (client-facing)
- Two `S3Client` instances. One does I/O against `S3_ENDPOINT=http://minio:9000`. The other is used **only for presigning** against `S3_PUBLIC_ENDPOINT=http://localhost:9000` (dev). Presigning is a local computation, so the signing client never needs to reach that host from inside the container.
- **Pros:** Follows the service-name rule for container traffic and produces URLs the browser can open. Maps cleanly to production (internal VPC endpoint vs. public/CDN hostname). Explicit and testable.
- **Cons:** Two clients and two keys to keep consistent. Developers must understand why they differ.

### Option B: Single endpoint resolvable from both sides (`host.docker.internal:9000` everywhere)
- Containers and the browser use the same hostname. Containers resolve it through `extra_hosts: host-gateway`. The browser resolves it only through a manual hosts-file entry on each developer machine.
- **Pros:** One client, one key.
- **Cons:** Breaks the "always use service names" rule in CLAUDE.md. Needs per-machine hosts-file setup. Container traffic loops through the host network.

### Option C: Proxy storage under the app origin (Next.js rewrite `/storage/* → minio`)
- The browser only sees the Next.js origin, and storage is reverse-proxied behind it.
- **Pros:** No CORS, and one public origin.
- **Cons:** 10GB uploads and every video stream flow through the Next.js server, which defeats the "no performance impact" requirement. The `Host` header changes break SigV4 unless signing is done for the proxied host. It also adds a hop to all playback.

**Recommendation:** **Option A.** It is the only option that follows the CLAUDE.md networking rule and still produces browser-usable signed URLs. It also keeps bytes off both Node processes. The canonical new keys are `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET_VIDEOS` and `S3_BUCKET_THUMBNAILS`. Final names are settled in planning, but the internal/public split is the decision. CORS allowed origin = the Next.js origin (`http://localhost:3001` in dev), with `ETag` exposed.

**Decision:** A (dual endpoint — `S3_ENDPOINT` internal + `S3_PUBLIC_ENDPOINT` for signing)

---

## TD-04: Large-File Upload Protocol (up to 10GB, resumable)

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** A 10GB file must upload "without impact on performance", and project-plan §4 asks for the ability to **resume after a connection failure**. A single S3 `PutObject` is limited to **5GB**, so 10GB requires either S3 multipart or a server-side chunking protocol. Strict BFF (inherited) means anything that goes to NestJS also passes through a Next.js Route Handler. A protocol that sends bytes through NestJS would therefore send 10GB through **two** Node hops. The decision shapes both the API endpoints and the browser client.

**Options:**

### Option A: S3 Multipart Upload with per-part presigned URLs, orchestrated by the API
- `initiate` (BFF → API): validates limits, creates the draft video, calls `CreateMultipartUpload`, and returns `uploadId` + part size. `sign-parts`: returns presigned `UploadPart` URLs. The browser PUTs parts **directly to storage** and collects ETags. `complete`: the API calls `CompleteMultipartUpload` and enqueues processing (TD-09). `abort` handles cancellation.
- **Pros:** The API and BFF never touch the bytes. Each part retries independently. Resume uses `ListParts` with the same `uploadId`. Supports up to 10,000 parts and 5TB. Uploads run in parallel. Standard S3 semantics that are portable to AWS.
- **Cons:** Several round-trips and more client logic (concurrency, ETag bookkeeping). Needs bucket CORS (TD-03) and cleanup of abandoned multipart uploads (TD-06).

### Option B: tus protocol (`@tus/server` + `@tus/s3-store` in NestJS, `tus-js-client` in the browser)
- An open resumable-upload protocol. The server receives chunks and streams them into S3 multipart.
- **Pros:** Resume is built into the protocol. Mature clients exist.
- **Cons:** Bytes flow browser → Next BFF → NestJS → storage. That is two Node hops for 10GB, which uses CPU, memory and bandwidth in the API and works against the core non-functional requirement. Proxying tus `PATCH`/`HEAD` semantics through a Route Handler is non-trivial. It also adds a protocol server to the API.

### Option C: Streamed `multipart/form-data` through BFF → API → storage (`@aws-sdk/lib-storage` `Upload`)
- One HTTP request per file. The API streams the body into an S3 multipart upload as it arrives.
- **Pros:** The simplest client (`fetch` with `FormData`).
- **Cons:** No resume. A dropped connection at 9.5GB restarts from zero. Same two-hop byte path as B. Long-lived requests hit proxy and body-size timeouts.

**Recommendation:** **Option A.** It is the only option where the 10GB payload bypasses both Node servers, and that is the literal requirement. It also gives resume (via `ListParts`) without a custom protocol server. The extra round-trips are small control-plane calls through the BFF. Depends on TD-03 (signing endpoint) and is detailed further by TD-05 (client) and TD-06 (limits/cleanup).

**Decision:** A (S3 Multipart Upload with per-part presigned URLs, API-orchestrated)

---

## TD-05: Browser Upload Client Implementation

**Scope:** Frontend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** Depends on TD-04. The browser must slice the file, upload parts concurrently with progress, retry failed parts, and resume. Uppy 6's `@uppy/aws-s3` changed its model: the backend implements a single `signRequest`, and **Uppy itself performs `CreateMultipartUpload` and `CompleteMultipartUpload`** with presigned URLs. In that model the API does not observe completion unless the client also calls a separate "finalize" endpoint. With TD-04-A, the API instead performs `complete` server-side.

**Options:**

### Option A: Uppy (`@uppy/core` + `@uppy/aws-s3`, headless or with Dashboard UI)
- `signRequest` calls a BFF route that asks the API to sign each S3 operation. An explicit `finalize` BFF call after `upload-success` lets the API verify (`HeadObject`) and enqueue processing.
- **Pros:** Mature concurrency, retries, progress and pause/resume. The Golden Retriever plugin can resume across page reloads. Optional ready-made UI.
- **Cons:** The client becomes authoritative for Create/Complete, so the API must sign those operations and then re-verify the result. That adds a `finalize` step and two sources of truth for completion. It also adds a heavy dependency and a UI that differs from the shadcn/Radix design system. MSW tests must cover the whole Uppy flow.

### Option B: Small in-house uploader module (`fetch`/`XMLHttpRequest`, concurrency pool)
- Roughly 200 lines of client code. It calls the BFF for `initiate`, `sign-parts` and `complete`, PUTs parts with XHR (for upload-progress events) through a fixed-size concurrency pool, retries parts with backoff, and keeps `{videoId, uploadId, completed parts}` in memory or `localStorage` for resume.
- **Pros:** Keeps the API as the single authority for Create/Complete (matches TD-04-A exactly). No new dependency. The UI is built from existing design-system primitives. Every network call is a BFF route that MSW can stub through the generated `paths` types.
- **Cons:** We own retry, abort and resume edge cases. Resuming across a page reload means re-selecting the file (browsers do not keep `File` handles), which Uppy also only partly solves.

**Recommendation:** **Option B.** It keeps one authoritative completion path (API `complete` → enqueue) and avoids a sign-then-verify round trip. It also matches the inherited BFF + MSW + OpenAPI-typed testing setup and the shadcn design system. The logic is small and well bounded. Uppy is a reasonable choice if a richer upload UI (drag-and-drop dashboard, multiple files) becomes a requirement later.

**Decision:** B (in-house uploader module)

---

## TD-06: Upload Limits, Part Size and Abandoned-Upload Cleanup

**Scope:** Cross-layer

**Capability:** Transversal — covers: Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance; Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** The draft is created at `initiate` (capability). Users close tabs, so some drafts never complete, and they leave both a DB row and an incomplete multipart upload holding storage. Limits must be enforced consistently by the API (`initiate` DTO), the client (file picker, part slicing) and storage. S3 constraints: parts must be 5 MiB–5 GiB (except the last) and at most 10,000 per upload. **MinIO lifecycle rules do not support `AbortIncompleteMultipartUpload`.** MinIO purges stale multipart uploads on its own internal schedule (reported as about 24h), while AWS S3 needs a lifecycle rule. Neither cleans the DB draft.

**Options:**

### Option A: Server-dictated limits + application-level cleanup job
- `initiate` validates `size ≤ 10 GiB` and the MIME/extension allowlist (aligned with TD-11), and returns a **server-chosen part size** (for example, 64–100 MiB, giving about 100–160 parts at 10GB). A repeatable job on the TD-07 queue runs periodically. It finds drafts still in `uploading` older than a threshold (for example, 24h), calls `AbortMultipartUpload`, and deletes or marks the draft.
- **Pros:** Portable across MinIO and S3. Cleans **both** storage and DB together. The client cannot pick an unsafe part size.
- **Cons:** One more scheduled job to write and test.

### Option B: Server-dictated limits + storage-native expiry only
- Same limits as A. Incomplete uploads are left to the storage engine (MinIO's internal stale-upload purge, or an S3 lifecycle rule in production). Orphan drafts are hidden from owner listings by a staleness filter.
- **Pros:** No cleanup code.
- **Cons:** Behavior differs by backend (MinIO's purge is undocumented, and its lifecycle rule is unsupported). Orphan DB rows build up forever. Tests cannot reliably check the cleanup.

### Option C: Client-chosen part size, user-triggered cancel only
- The client picks the part size and calls `abort` on cancel. There is no background cleanup.
- **Pros:** Simplest.
- **Cons:** Tab closes and crashes leak storage and drafts permanently. The server cannot defend the 10,000-part or minimum-size limits.

**Recommendation:** **Option A.** It is the only option where cleanup behaves the same on MinIO and S3, and the only one that also cleans the draft row created by the capability. The cleanup job reuses the queue from TD-07 (repeatable job), so it adds no new infrastructure. Exact thresholds (part size, staleness window, allowlist) are policy parameters to fix during planning.

**Decision:** A (server-dictated limits + application-level cleanup job on the queue)

---

## TD-07: Background Job Queue

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture diagram leaves "Message Queue — TBD". Processing (ffprobe and thumbnail generation for files up to 10GB) must run outside the request cycle with retries and idempotency. The decision adds (or does not add) a new infrastructure service to Compose, and it picks the NestJS integration that both the API (producer) and worker (consumer) use.

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq`)
- Redis-backed queue. The official Nest module provides `BullModule.forRootAsync` / `registerQueue`, `@Processor` + `WorkerHost`, and `defaultJobOptions` (`attempts`, `backoff`).
- **Pros:** First-party Nest integration. Retries with exponential backoff, deduplication by custom `jobId` (`jobId = videoId` makes enqueue idempotent), repeatable jobs (used by TD-06 cleanup), concurrency control, stalled-job recovery. Very widely used.
- **Cons:** Adds Redis to Compose and to the test environment. Redis must be configured for queue durability (`maxmemory-policy noeviction`, persistence).

### Option B: pg-boss (PostgreSQL-backed)
- Job queue stored in Postgres tables, using `SKIP LOCKED`.
- **Pros:** No new infrastructure, because Postgres already exists. Jobs can be enqueued in the **same transaction** as the video row (transactional outbox for free).
- **Cons:** No official Nest module (community wrappers or a hand-written provider). Queue load lands on the primary database. The architecture diagram models the queue as a separate container. Smaller ecosystem.

### Option C: RabbitMQ (`@nestjs/microservices` RMQ transport or `amqplib`)
- AMQP broker with acks and dead-letter exchanges.
- **Pros:** A real message broker with strong delivery semantics. Suits multi-language consumers.
- **Cons:** Heavier to operate. Nest's RMQ transport is built for RPC/event patterns, not job semantics. Retry/backoff and scheduled jobs need DLX/TTL plumbing. It is more than this phase needs.

**Recommendation:** **Option A.** It matches the diagram's separate queue container, has the only first-party Nest integration of the three, and provides out of the box what TD-14 (retry/backoff, idempotent `jobId`) and TD-06 (repeatable cleanup) need. Redis is a small, well-understood addition. pg-boss is the strongest alternative if avoiding new infrastructure becomes a priority.

**Decision:** A (BullMQ + Redis via `@nestjs/bullmq`)

---

## TD-08: Video Worker Deployment Topology

**Scope:** Backend

**Capability:** Transversal — covers: Serviço de processamento em segundo plano (filas); Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The architecture diagram has a separate "Video Worker (FFmpeg)" container. Processing is CPU- and IO-heavy and must not degrade API latency. The worker needs FFmpeg installed and access to DB, storage and queue. It shares the `Video` entity and config with the API.

**Options:**

### Option A: Separate container, same codebase, second entrypoint
- A `src/worker.ts` bootstraps `NestFactory.createApplicationContext(WorkerModule)` (no HTTP server). It runs in its own Compose service from the same project, with FFmpeg added to its image. The API registers only the producer side.
- **Pros:** Matches the diagram. Isolates CPU load and scales independently. Reuses entities, config (TD-01 namespaces) and TypeORM setup with no duplication. One `package.json` and one test suite.
- **Cons:** Two processes to start in dev. Module wiring must keep the processor out of the API's module graph.

### Option B: In-process processor inside the API
- `@Processor` registered in the API application itself.
- **Pros:** Simplest setup, one process.
- **Cons:** FFmpeg work competes with HTTP handling, which goes against "without impact on performance". The API image needs FFmpeg. Contradicts the architecture diagram.

### Option C: Separate subproject (`video-worker/`)
- An independent package with its own manifest, Dockerfile and config.
- **Pros:** Maximum isolation, and a different runtime is possible.
- **Cons:** Duplicates entity definitions, config validation and DB setup, or forces a shared-package/monorepo-tooling decision this phase does not need.

**Recommendation:** **Option A.** It gives the isolation the diagram and the NFR ask for without duplicating the domain model. A second entrypoint in the same NestJS project is the idiomatic way to run standalone workers (`createApplicationContext`).

**Decision:** A (separate container, same codebase, second entrypoint)

---

## TD-09: Processing Trigger

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** Depends on TD-04 and TD-07. Something must move a video from "uploaded" to "queued for processing". The trigger can come from our API (it knows when `complete` succeeds) or from the storage engine (object-created events).

**Options:**

### Option A: API enqueues on `complete`
- After `CompleteMultipartUpload` succeeds, the API updates the status (TD-14) and adds the job with `jobId = videoId`.
- **Pros:** One explicit, easy-to-test code path. Works the same on any S3-compatible backend. The ownership check and status transition happen in the same request. Idempotent through `jobId`.
- **Cons:** If the process crashes between the DB update and the enqueue, the video can stay in a non-processing state. This is mitigated by the idempotent re-enqueue on retried `complete` and by TD-06's sweeper.

### Option B: Storage bucket event notifications
- MinIO or S3 publishes `s3:ObjectCreated:CompleteMultipartUpload` to a target (webhook into the API, a Redis list, or SQS in AWS), and a consumer enqueues the job.
- **Pros:** Triggers even if the client never calls `complete` (only relevant with client-side completion).
- **Cons:** Notification targets are configured differently on MinIO and AWS. Adds a webhook endpoint or a second consumer. Hard to test deterministically. Redundant under TD-04-A, where the API already performs completion.

**Recommendation:** **Option A.** Under TD-04-A the API is already the party that completes the upload, so enqueueing there is the simplest correct trigger and does not couple to storage-specific notification setup.

**Decision:** A (API enqueues on `complete`)

---

## TD-10: Media Inspection Tooling and Input Access

**Scope:** Backend

**Capability:** Transversal — covers: Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The worker must extract duration and metadata (ffprobe) and grab one frame for the thumbnail (ffmpeg). Two sub-choices are linked: **how** we call FFmpeg from Node, and **how** the worker reads a file of up to 10GB. Note: `fluent-ffmpeg`, the historical default wrapper, is **deprecated on npm and unmaintained**.

**Options:**

### Option A: Direct `ffprobe`/`ffmpeg` CLI via `child_process.spawn`, input over presigned HTTP URL
- The worker image installs FFmpeg from the distro. The worker runs `ffprobe -print_format json -show_format -show_streams <presigned-url>` and `ffmpeg -ss <t> -i <presigned-url> -frames:v 1 ...`. FFmpeg reads over HTTP with Range requests, fetching only the bytes it needs.
- **Pros:** No deprecated wrapper, and the JSON output is parsed into typed DTOs. **No 10GB download**: probing and single-frame seeks read only headers plus a small range. Worker disk usage stays near zero.
- **Cons:** We write a thin typed wrapper (argument building, exit-code and stderr handling). MP4s with the `moov` atom at the end need an extra Range request (handled by FFmpeg).

### Option B: Direct CLI, but download the original to a temp volume first
- The object is streamed to local disk, then FFmpeg runs on the file.
- **Pros:** Local file I/O is the most predictable for FFmpeg. Easy to reproduce locally.
- **Cons:** Up to 10GB of disk and transfer per job, mostly wasted for probe + one frame. Needs temp-volume sizing and cleanup. Slower, and limits worker concurrency.

### Option C: `fluent-ffmpeg` wrapper (with either input mode)
- A fluent API over the FFmpeg CLI.
- **Pros:** Familiar API and many examples.
- **Cons:** Deprecated and unmaintained, so it adds dependency risk for no real gain on two simple commands.

**Recommendation:** **Option A.** Probing and single-frame extraction never need the full file, so reading over HTTP Range from a presigned URL (signed with the **internal** endpoint client from TD-03, because the worker is inside the Docker network) avoids moving 10GB per job. Calling the CLI directly avoids a deprecated dependency. Thumbnail frame policy (for example, a frame at about 10% of duration, clamped for very short videos) is a parameter for planning.

**Decision:** A (direct ffprobe/ffmpeg CLI via `child_process`, input over presigned HTTP URL)

---

## TD-11: Streaming Format and Browser Playability

**Scope:** Cross-layer

**Capability:** Reprodução via streaming (sem necessidade de download completo)

**Context:** "Streaming without full download" can mean progressive HTTP playback (Range requests on one file) or adaptive streaming (HLS/DASH segments). This decides what the worker produces, what storage holds, and what the Phase 05 player must support. This phase's capabilities define processing as **metadata extraction + thumbnail**. Transcoding is not listed. But an uploaded MKV or HEVC file will not play in most browsers.

**Options:**

### Option A: Progressive playback of the original + playability gate
- The original is served as-is with HTTP Range (native `<video>` support). `initiate` restricts uploads to browser-oriented containers (for example, `video/mp4`, `video/webm`). The worker's ffprobe step checks the codecs (H.264/VP9/AV1 video, AAC/Opus audio). Anything not browser-playable ends as `failed` with a clear reason (TD-14).
- **Pros:** No transcoding cost and no extra storage. Fits the phase's stated processing scope exactly. The player is a plain `<video src>`.
- **Cons:** No adaptive bitrate, so a 4K original is streamed at 4K. Users with other formats must convert before uploading.

### Option B: Normalize to a "faststart" H.264/AAC MP4
- The worker always produces a web-optimized MP4. It remuxes with `-c copy -movflags +faststart` when the codecs are already compatible, and transcodes otherwise.
- **Pros:** Accepts nearly any input. Instant start (moov atom at the front). Still a plain `<video>` player.
- **Cons:** Full transcoding of 10GB inputs is CPU-heavy (minutes to hours). Doubles storage unless the original is deleted. Goes beyond this phase's stated processing capabilities.

### Option C: HLS adaptive streaming (multi-rendition transcode)
- The worker produces an HLS ladder (for example, 360p/720p/1080p) plus a playlist.
- **Pros:** YouTube-like adaptive quality and the best bandwidth behavior.
- **Cons:** Heaviest compute and storage cost by far. The player needs `hls.js` (Phase 05). Download (a separate capability) still needs the original. Clearly beyond the phase's scope.

**Recommendation:** **Option A.** It meets "streaming without full download" with zero transcoding and stays inside the phase's processing scope (duration, metadata, thumbnail). The ffprobe codec gate turns "won't play" into an explicit failure instead of a broken player. B is the natural next step if input-format coverage becomes a product requirement. It extends the same worker without changing the delivery contract (TD-12).

**Decision:** A (progressive playback of the original + ffprobe playability gate)

---

## TD-12: Streaming and Download Delivery Path

**Scope:** Cross-layer

**Capability:** Transversal — covers: Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** The video bytes must reach the browser with Range support (streaming) and with `Content-Disposition: attachment` (download). Authorization still applies: non-`ready` videos are visible only to their owner (unlisted/visibility is Phase 04). Strict BFF means any URL served by the app goes through a Route Handler. The architecture diagram already shows "Frontend → Object Storage: Streams".

**Options:**

### Option A: API returns a presigned GET URL in the video payload
- The BFF fetches video details. The API checks access and includes a presigned `streamUrl` (and, on demand, a `downloadUrl` signed with `ResponseContentDisposition=attachment; filename=...`). `<video src>` points straight at storage.
- **Pros:** No bytes through Node. Storage handles Range/206 natively. Simple.
- **Cons:** Signed URLs leak into RSC payloads and HTML, and they expire. A long-open page, or playback longer than the expiry, starts failing new Range requests. The FE must re-fetch to refresh them.

### Option B: API proxy endpoint that forwards `Range` → `GetObject` → `206`
- `GET /videos/:id/stream` streams bytes from storage through NestJS. Under strict BFF it is also proxied by a Next Route Handler.
- **Pros:** Full control: per-request auth, analytics, no signed URLs exposed.
- **Cons:** Every byte of every view crosses **two** Node processes, which is the worst case for performance and directly conflicts with the NFR and the diagram.

### Option C: Stable BFF URL that issues a 302 redirect to a freshly presigned URL
- `next-frontend` exposes `/api/videos/{publicId}/stream` and `/api/videos/{publicId}/download`. Each Route Handler asks the API, which checks access and signs, then responds `302 Location: <presigned URL>` (the download variant uses `ResponseContentDisposition=attachment`). The browser then streams directly from storage.
- **Pros:** Stable, cacheable-in-HTML URLs (`<video src="/api/videos/abc/stream">`, `<a href=".../download">`). Access is checked on every load, and a fresh signature is issued each time, so expiry can be short. Bytes never touch Node. Keeps the strict-BFF contract (the browser only knows same-origin URLs plus wherever storage redirects).
- **Cons:** One extra redirect hop per load. Media elements keep the redirected URL for subsequent Range requests, so the expiry must still cover a viewing session (for example, a few hours).

**Recommendation:** **Option C.** It keeps the diagram's "frontend streams from storage" property and the NFR (no bytes through Node), like A. It also gives the frontend stable, same-origin URLs for streaming and download, with an authorization check on every access. That is a better fit for the strict-BFF contract and for Phase 05's player and download button. The presigned URL is signed with the public endpoint client (TD-03).

**Decision:** C (stable BFF URL → 302 to freshly presigned URL)

---

## TD-13: Unique Public Video Identifier (URL ID)

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a short, unique, never-conflicting public identifier for URLs (`/watch/{id}`), used by API routes, BFF routes, FE pages, and links shared outside the app. Phase 04 adds **unlisted** videos ("accessible only via direct link"). This makes **unguessability** a hard requirement, because any scheme that can be enumerated or decoded leaks unlisted videos. The internal primary key is a separate concern.

**Options:**

### Option A: Random short ID (11 chars, URL-safe alphabet) + `UNIQUE` constraint + retry on collision
- The ID is generated at `initiate` from a CSPRNG (`node:crypto` `randomBytes` → base62/base64url, or the `nanoid` library) and stored in a `public_id` column with a unique index. On the very unlikely collision, insert is retried. The internal PK stays a UUID.
- **Pros:** Short, YouTube-like URLs (64^11 ≈ 7×10^19 space). Not enumerable, so it is safe for unlisted videos. The DB constraint guarantees no conflicts regardless of probability.
- **Cons:** One extra indexed column and a retry loop. Note: `nanoid` v5 is ESM-only, which causes friction with the project's CommonJS + ts-jest setup. A ~10-line `node:crypto` generator avoids that dependency.

### Option B: Encoded sequential ID (Sqids/Hashids over a serial column)
- The integer PK is encoded into a short string.
- **Pros:** Collisions are impossible by construction. Very short IDs.
- **Cons:** It is an encoding, not encryption. IDs can be decoded and enumerated, so it **fails the unlisted-video requirement** of Phase 04. It also exposes upload volume.

### Option C: UUID in the URL
- Reuse the UUID PK directly as the public ID.
- **Pros:** Zero extra machinery. Unguessable (v4).
- **Cons:** 36-character URLs, far from the "short URL" goal in project-plan §4. Couples the public URL to the internal PK forever.

**Recommendation:** **Option A**, generated with `node:crypto` (no dependency, no ESM/Jest friction). It is the only option that is short, unguessable for Phase 04's unlisted videos, and guaranteed conflict-free by the DB `UNIQUE` constraint, which is the literal capability. Storage object keys use the internal UUID (TD-02), so the public ID can be rotated later without moving objects.

**Decision:** A (11-char CSPRNG ID via `node:crypto` + `UNIQUE` + retry)

---

## TD-14: Video Lifecycle State Model and Processing Failure Policy

**Scope:** Cross-layer

**Capability:** Transversal — covers: Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** The video row is created as a draft at `initiate` and moves through upload, processing, and success or failure. The DB enum, API, worker, BFF responses and FE UI all depend on the state names, so this is a cross-component contract. **Phase 04 owns "rascunho → publicação" (draft → publish) and visibility (public/unlisted).** If Phase 03 mixes processing states with publication states in one field, Phase 04 will have to migrate it. The failure policy (retries, terminal state) also belongs here, because TD-11's codec gate and FFmpeg errors must end somewhere visible.

**Options:**

### Option A: Processing-lifecycle `status` enum, separate from publication (Phase 04)
- `status`: `uploading → processing → ready | failed`, plus `failure_reason`. The "draft" nature of a pre-registered video means "not yet published", which Phase 04 adds as its own field(s) (for example, `published_at` / `visibility`). Jobs use `attempts: 3` with exponential backoff and `jobId = videoId`. Non-retryable errors (unsupported codec) fail immediately. When retries run out, the status becomes `failed` with a reason.
- **Pros:** Each field has one responsibility (technical pipeline vs. editorial state). Phase 04 adds publication without touching this enum. Clear terminal states for UI and tests. Idempotent reprocessing.
- **Cons:** Two concepts to explain ("ready but unpublished"). The FE must combine both fields when rendering badges (Phase 04 panel).

### Option B: Single combined lifecycle enum (`draft → uploading → processing → ready → published`, `failed`)
- One column covers both the pipeline and editorial state.
- **Pros:** One field to read.
- **Cons:** Mixes two independent concerns. Re-processing or editing a published video does not fit a linear enum. Phase 04 would have to redesign it (migration and contract change). Breaks the single-responsibility principle in CLAUDE.md.

### Option C: Timestamp-derived state (`uploaded_at`, `processed_at`, `failed_at`)
- No enum. The state is computed from which timestamps are set.
- **Pros:** Keeps a history of when each step happened.
- **Cons:** Derived state must be recomputed consistently in SQL, the API and the FE. Invalid combinations are possible. Harder to index and filter ("all processing videos").

**Recommendation:** **Option A.** It keeps the Phase 03 pipeline state separate from Phase 04's publication flow, so that phase extends the model instead of rewriting it. It also gives the worker's retry policy (BullMQ `attempts`/`backoff` + idempotent `jobId`, TD-07) a single, explicit terminal state. Default access rule to carry into planning: non-`ready` videos are visible only to their owner. Wider visibility rules are Phase 04.

**Decision:** A (processing-lifecycle `status` enum, separate from Phase 04 publication)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Object storage server and S3 client SDK | A — MinIO (pinned image) + `@aws-sdk/client-s3` v3 | A — MinIO (Chainguard image, digest-pinned) + AWS SDK v3 |
| TD-02 | Cross-layer | Bucket topology and object access policy | B — private `videos` + public-read `thumbnails` | B |
| TD-03 | Cross-layer | Client-facing storage endpoint for presigned URLs | A — `S3_ENDPOINT` (internal) + `S3_PUBLIC_ENDPOINT` (signing) | A |
| TD-04 | Cross-layer | Large-file upload protocol (10GB, resumable) | A — S3 multipart, per-part presigned URLs, API-orchestrated | A |
| TD-05 | Frontend | Browser upload client implementation | B — in-house uploader module | B |
| TD-06 | Cross-layer | Upload limits, part size, abandoned-upload cleanup | A — server-dictated limits + cleanup job on the queue | A |
| TD-07 | Backend | Background job queue | A — BullMQ + Redis (`@nestjs/bullmq`) | A |
| TD-08 | Backend | Video worker deployment topology | A — separate container, same codebase, second entrypoint | A |
| TD-09 | Backend | Processing trigger | A — API enqueues on `complete` | A |
| TD-10 | Backend | Media inspection tooling and input access | A — direct ffprobe/ffmpeg CLI over presigned HTTP URL | A |
| TD-11 | Cross-layer | Streaming format and browser playability | A — progressive original + ffprobe codec gate | A |
| TD-12 | Cross-layer | Streaming and download delivery path | C — stable BFF URL → 302 to fresh presigned URL | C |
| TD-13 | Cross-layer | Unique public video identifier (URL ID) | A — 11-char CSPRNG ID + `UNIQUE` + retry | A |
| TD-14 | Cross-layer | Video lifecycle state model and failure policy | A — processing `status` enum, separate from publication | A |
