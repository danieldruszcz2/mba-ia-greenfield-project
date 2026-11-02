---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-11-02T15:44:08-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-02T16:26:13-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-11-02T15:44:08-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-11-02T15:44:08-03:00"
  docs/phases/phase-02-auth/context.md: "2026-11-02T15:44:08-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-11-02T15:44:08-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-11-02T15:44:08-03:00"
  .claude/skills/testing-guide-next-frontend/SKILL.md: "2026-11-02T15:44:08-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified._
**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.
**Affected subprojects:** _None named explicitly in the Phase 03 section of project-plan.md._
**Deferred subprojects:** _None._
**Sequencing notes:** Depende de: Fase 01, Fase 02

**Neighbors (for boundary detection only):**

- **Phase 02:** Fluxo completo de criação de conta, confirmação por e-mail, login, logout e recuperação de senha. (Cadastro, Login e Gerenciamento de Conta)
- **Phase 04:** Edição das informações do vídeo, fluxo de rascunho e publicação, painel de administração do canal e página pública. (Gerenciamento de Vídeos e Canal; Depende de: Fase 02, Fase 03)

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Object Storage Server and S3 Client SDK | decided | A (MinIO + `@aws-sdk/client-s3` v3, Chainguard image pinned by digest) | — |
| phase-03-videos/TD-02 | phase | Cross-layer | Bucket Topology and Object Access Policy | decided | B (private `videos` + public-read `thumbnails`) | — |
| phase-03-videos/TD-03 | phase | Cross-layer | Client-Facing Storage Endpoint for Presigned URLs | decided | A (dual endpoint `S3_ENDPOINT` + `S3_PUBLIC_ENDPOINT`) | — |
| phase-03-videos/TD-04 | phase | Cross-layer | Large-File Upload Protocol (up to 10GB, resumable) | decided | A (S3 Multipart, per-part presigned URLs, API-orchestrated) | — |
| phase-03-videos/TD-05 | phase | Frontend | Browser Upload Client Implementation | decided | B (in-house uploader module) | — |
| phase-03-videos/TD-06 | phase | Cross-layer | Upload Limits, Part Size and Abandoned-Upload Cleanup | decided | A (server-dictated limits + queue cleanup job) | — |
| phase-03-videos/TD-07 | phase | Backend | Background Job Queue | decided | A (BullMQ + Redis via `@nestjs/bullmq`) | — |
| phase-03-videos/TD-08 | phase | Backend | Video Worker Deployment Topology | decided | A (separate container, same codebase, second entrypoint) | — |
| phase-03-videos/TD-09 | phase | Backend | Processing Trigger | decided | A (API enqueues on `complete`) | — |
| phase-03-videos/TD-10 | phase | Backend | Media Inspection Tooling and Input Access | decided | A (ffprobe/ffmpeg CLI via `child_process`, presigned HTTP input) | — |
| phase-03-videos/TD-11 | phase | Cross-layer | Streaming Format and Browser Playability | decided | A (progressive playback of original + ffprobe playability gate) | — |
| phase-03-videos/TD-12 | phase | Cross-layer | Streaming and Download Delivery Path | decided | C (stable BFF URL → 302 to fresh presigned URL) | — |
| phase-03-videos/TD-13 | phase | Cross-layer | Unique Public Video Identifier (URL ID) | decided | A (11-char CSPRNG ID via `node:crypto` + UNIQUE + retry) | — |
| phase-03-videos/TD-14 | phase | Cross-layer | Video Lifecycle State Model and Processing Failure Policy | decided | A (processing `status` enum, separate from Phase 04 publication) | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-01, phase-03-videos/TD-02, phase-03-videos/TD-03 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-07, phase-03-videos/TD-08 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-03, phase-03-videos/TD-04, phase-03-videos/TD-05, phase-03-videos/TD-06 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-06, phase-03-videos/TD-14 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-08, phase-03-videos/TD-09, phase-03-videos/TD-10, phase-03-videos/TD-14 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-02, phase-03-videos/TD-08, phase-03-videos/TD-10 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-13 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-03, phase-03-videos/TD-11, phase-03-videos/TD-12 |
| Download do vídeo pelo usuário | phase-03-videos/TD-03, phase-03-videos/TD-12 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** **Option A**, with the SDK fixed as `@aws-sdk/client-s3` v3. MinIO's behavior is the closest to AWS for the exact features this phase depends on (multipart, per-part presigning, Range GETs). Pin the image to an exact tag, never `latest`. Because all code talks plain S3 through the AWS SDK, switching to Garage, SeaweedFS or real S3 later is only a Compose and env change. Choose B if you would rather not depend on a frozen image at all.
**Libraries:** —

### phase-03-videos/TD-02

**Recommendation:** Thumbnails appear in every listing from Phase 04 to Phase 07, so stable, cacheable URLs matter more than having one bucket. Originals, which carry the real access-control needs, stay fully private. Object keys are built from the internal UUID primary key, not the public slug (TD-13), so public thumbnail URLs cannot be enumerated. Buckets are created by an idempotent init step in Compose (for example, an `mc`/CLI one-shot service). The exact mechanism is up to implementation.
**Libraries:** —

### phase-03-videos/TD-03

**Recommendation:** It is the only option that follows the CLAUDE.md networking rule and still produces browser-usable signed URLs. It also keeps bytes off both Node processes. The canonical new keys are `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET_VIDEOS` and `S3_BUCKET_THUMBNAILS`. Final names are settled in planning, but the internal/public split is the decision. CORS allowed origin = the Next.js origin (`http://localhost:3001` in dev), with `ETag` exposed.
**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** It is the only option where the 10GB payload bypasses both Node servers, and that is the literal requirement. It also gives resume (via `ListParts`) without a custom protocol server. The extra round-trips are small control-plane calls through the BFF. Depends on TD-03 (signing endpoint) and is detailed further by TD-05 (client) and TD-06 (limits/cleanup).
**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** It keeps one authoritative completion path (API `complete` → enqueue) and avoids a sign-then-verify round trip. It also matches the inherited BFF + MSW + OpenAPI-typed testing setup and the shadcn design system. The logic is small and well bounded. Uppy is a reasonable choice if a richer upload UI (drag-and-drop dashboard, multiple files) becomes a requirement later.
**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** It is the only option where cleanup behaves the same on MinIO and S3, and the only one that also cleans the draft row created by the capability. The cleanup job reuses the queue from TD-07 (repeatable job), so it adds no new infrastructure. Exact thresholds (part size, staleness window, allowlist) are policy parameters to fix during planning.
**Libraries:** —

### phase-03-videos/TD-07

**Recommendation:** It matches the diagram's separate queue container, has the only first-party Nest integration of the three, and provides out of the box what TD-14 (retry/backoff, idempotent `jobId`) and TD-06 (repeatable cleanup) need. Redis is a small, well-understood addition. pg-boss is the strongest alternative if avoiding new infrastructure becomes a priority.
**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** It gives the isolation the diagram and the NFR ask for without duplicating the domain model. A second entrypoint in the same NestJS project is the idiomatic way to run standalone workers (`createApplicationContext`).
**Libraries:** —

### phase-03-videos/TD-09

**Recommendation:** Under TD-04-A the API is already the party that completes the upload, so enqueueing there is the simplest correct trigger and does not couple to storage-specific notification setup.
**Libraries:** —

### phase-03-videos/TD-10

**Recommendation:** Probing and single-frame extraction never need the full file, so reading over HTTP Range from a presigned URL (signed with the **internal** endpoint client from TD-03, because the worker is inside the Docker network) avoids moving 10GB per job. Calling the CLI directly avoids a deprecated dependency. Thumbnail frame policy (for example, a frame at about 10% of duration, clamped for very short videos) is a parameter for planning.
**Libraries:** —

### phase-03-videos/TD-11

**Recommendation:** It meets "streaming without full download" with zero transcoding and stays inside the phase's processing scope (duration, metadata, thumbnail). The ffprobe codec gate turns "won't play" into an explicit failure instead of a broken player. B is the natural next step if input-format coverage becomes a product requirement. It extends the same worker without changing the delivery contract (TD-12).
**Libraries:** —

### phase-03-videos/TD-12

**Recommendation:** It keeps the diagram's "frontend streams from storage" property and the NFR (no bytes through Node), like A. It also gives the frontend stable, same-origin URLs for streaming and download, with an authorization check on every access. That is a better fit for the strict-BFF contract and for Phase 05's player and download button. The presigned URL is signed with the public endpoint client (TD-03).
**Libraries:** —

### phase-03-videos/TD-13

**Recommendation:** **Option A**, generated with `node:crypto` (no dependency, no ESM/Jest friction). It is the only option that is short, unguessable for Phase 04's unlisted videos, and guaranteed conflict-free by the DB `UNIQUE` constraint, which is the literal capability. Storage object keys use the internal UUID (TD-02), so the public ID can be rotated later without moving objects.
**Libraries:** —

### phase-03-videos/TD-14

**Recommendation:** It keeps the Phase 03 pipeline state separate from Phase 04's publication flow, so that phase extends the model instead of rewriting it. It also gives the worker's retry policy (BullMQ `attempts`/`backoff` + idempotent `jobId`, TD-07) a single, explicit terminal state. Default access rule to carry into planning: non-`ready` videos are visible only to their owner. Wider visibility rules are Phase 04.
**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.

**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.

**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.

**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.

**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.

**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.

**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.

**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Three reasons. (1) **Architectural fit.** The strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match, and Auth.js's framework adds layers between the BFF and the cookie that buy nothing because the backend is the auth authority — Auth.js's value (DB adapters, OAuth providers, magic-link, `getServerSession` helpers) is mostly unused in this configuration. (2) **Smaller blast radius.** A ~50-LOC session helper is grep-friendly, debuggable, and test-friendly via the existing MSW+BFF integration test pattern; a misconfigured Auth.js callback is a longer fault-isolation loop. (3) **Compatibility with Next.js 16 / React 19.** Built-in `next/headers` `cookies()` is the canonical primitive both runtimes already use; Auth.js v5 versions track Next.js majors with a lag, adding compatibility risk that Option A does not have. Option C is rejected as unsafe (`localStorage` for refresh tokens) and architecturally regressive (loses RSC personalization).
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** Three reasons. (1) **Defense in depth on the cookie content** — `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection; the marginal cost is one ~3KB dep. (2) **Single cookie to manage** simplifies logout (one `session.destroy()` call) and avoids the orphan-cookie failure mode of Option A. (3) **Room to carry minimal user metadata** (`userId`, `email`, `channelSlug`) lets `app/layout.tsx` RSC render the authenticated chrome (avatar, channel name) without a per-render `/auth/me` round-trip — Phase 04+ gains compound here. Option A is a viable downgrade if the team rejects `iron-session` for any reason; the migration A→B (or B→A) is a one-Route-Handler refactor with no test changes downstream because the BFF interface is unchanged. Option C is rejected: it solves a problem (server-side revocation) the project does not have at the cost of infrastructure the project does not own.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** The single-flight detail is non-trivial and goes in the helper from day one — tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion. Option B's client-driven pattern is rejected because it doesn't replace Option A (RSC still needs server-side refresh) — adopting B means doing both. Option C's pre-emptive timer is rejected because the failure modes (multiple tabs, sleep/wake) outweigh the latency saving and force a `"use client"` shell near the root.
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** Three reasons. (1) **Decoupled from TD-05** — works with Route Handlers OR Server Actions; the form code does not change if TD-05 is revisited later. (2) **Aligned with shadcn's canonical form primitive** — the project already commits to `radix-nova` shadcn (`components.json`); `npx shadcn@latest add form` produces react-hook-form wrappers; choosing react-hook-form means using the supported primitive instead of hand-rolling around it. (3) **Zod-first developer ergonomics match the rest of the FE foundation** — `next-frontend-config-base/TD-01` chose Zod 4 for env; the same schemas-as-source-of-truth pattern carries to forms with zero new validator paradigm. Option B is rejected for impedance with shadcn's primitive and for over-investing in progressive-enhancement that the strict-BFF model does not require. Option C is rejected for the per-field boilerplate and the loss of client-side feedback on a project that values quick, type-safe form iteration.
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Three reasons. (1) **Strict-BFF alignment.** `next-frontend-config-base/TD-03` named Route Handlers as the BFF surface; Option A keeps every mutation visible under `app/api/**`. (2) **Test scaffold already exists** — `next-frontend/CLAUDE.md` § Testing and `next-frontend-msw-foundation` were authored for Route-Handlers-as-functions; Option A reuses them with zero invention. (3) **Single mutation surface** — Phase 02 sets the precedent for Phases 03–07; uniformity beats per-mutation idiom-picking when the cost of inconsistency compounds (Option C). Option B has real ergonomic appeal for the simplest forms but fragments the BFF surface and forces test-pattern reinvention; if the team later wants progressive enhancement for specific forms, the migration A→B is per-form and doesn't require touching unrelated routes — A is the safer default and the cheaper baseline.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Two reinforcing reasons. (1) **No first-render flicker, no round-trip** — the session is delivered in the same response as the page HTML; the Client Provider hydrates with the correct initial state; users never see "Login" briefly turn into their avatar. (2) **No new BFF endpoint** — the cookie is the source of truth, RSC reads it, the Provider broadcasts it; the BFF surface stays minimal. The `router.refresh()` requirement after mid-session mutations is a small price (one line in the relevant mutation handler) for the structural benefits. Option B is rejected for the double-read-and-flicker; Option C is dominated by Option B and rejected.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** Three reasons. (1) **First-paint-correct** — the user sees the right outcome on the first paint, no skeleton, no flicker. (2) **Single integration pattern across both flows** — confirmation is RSC-only; reset is RSC + Client form (TD-04, TD-05 patterns reused) — both share the "RSC owns the token, Client Component owns the input" split. (3) **Email-prefetch behavior** is solved at the backend's idempotent-confirmation level (a small note for `/plan-build` to confirm; not a separate TD). Option B's Route-Handler-as-link-target adds redirects for no clean gain. Option C is dominated.
**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo. Nestia tem mérito técnico real mas o custo de migração do stack de validação inviabiliza-a sem uma decisão upstream de supersede de TD-06. Manual authoring é descartado.
**Libraries:** @nestjs/swagger
**Revisions:**

- 2026-05-12 — Esclarece que o CLI plugin (`classValidatorShim: true`) cobre apenas inferência de schemas de DTOs a partir de `class-validator`; documentação de operações, respostas tipadas por status code, contratos de erro (alinhados ao envelope de phase-02-auth/TD-07) e exemplos exigem decoradores explícitos (`@ApiOperation`, `@ApiResponse`, `@ApiBody`, `@ApiParam`, `@ApiQuery`, `@ApiExtraModels`). _Rationale:_ openapi.json gerado pelo bootstrap atual está genérico — sem detalhes de parâmetros, schemas de retorno por status, nem contratos de erro — porque a base instalada se apoiou só na introspecção automática. Esta revisão fixa que enriquecimento via decoradores explícitos faz parte da Option A escolhida, não é trabalho fora do escopo do TD.

### openapi-docs-nestjs/TD-02

**Recommendation:** o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam. Option B sozinho pune a experiência de desenvolvimento em dev/local; Option A sozinho compromete o pipeline de codegen futuro. Combinar é dominante.
**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI"). Re-abrir como Option A ou C é trivial no futuro se um caso de uso de API pública aparecer.
**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, ... _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain... _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and... _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning... _(from phase 01)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` (BFF route handler + `session.destroy()`) so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase delivers the screen via `/screen-inventory` extension run. Documented as a known gap. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | a tela de confirmação da conta não será implementada nesta fase corrente, será adiada — the umbrella bullet's full coverage requires the confirmação and reset-password destination screens; both are deferred per Non-UI rows above. The 3 ship-this-phase telas (signup, login, forgot-password) are inventoried and covered by their own verbs; the umbrella bullet itself is deferred to the phase that lands the missing screens. |

## UI Inventory

_Frontend-runtime only — no screen inventory needed for this phase.
Run /screen-inventory phase-03-videos if a UI surface is added in a future revision._

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, cache) | Unit: real lib with test config |
| Service with side-effect dep (email, storage) | Integration: real capture service (Mailpit) or local adapter |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (delegates to service for business logic) | E2E + Unit if complex internal logic |
| Guard (simple, delegates to Passport) | E2E only |
| Strategy (Passport) | E2E via guard |
| Pipe (custom transformation/validation) | Unit |
| Interceptor (response transform, logging) | Unit and/or E2E |
| Exception Filter | Unit + E2E |
| Middleware | E2E |

### next-frontend

| Artifact type | Required layers |
|---------------|-----------------|
| Page — sync RSC, static, no logic | None at component level; cover only if part of a critical flow → `*.e2e-spec.ts` |
| Page — sync RSC composing client children | Test client children directly; cover rendered page via `*.e2e-spec.ts` |
| Page — async RSC | `*.e2e-spec.ts` only — Vitest cannot render it |
| Layout (`layout.tsx`) | None unless it adds logic (auth gate, conditional render); else via E2E |
| Client component (`"use client"`) with state/handlers | `*.test.tsx` — RTL + `jsdom` docblock, mock `next/navigation`, MSW for fetch |
| Feature component (server, composes primitives) | Skip unit; cover via the page's E2E |
| shadcn UI primitive (`components/ui/*`) | None — trust the library; cover via consumers |
| Icon (`components/icons/*`) | None |
| `lib/` utility / boundary module with branching or shape assumptions | `*.test.ts` |
| Custom hook (`hooks/*`) | `*.test.ts(x)` with `renderHook`, `jsdom` docblock |
| Route handler (`app/api/**/route.ts`) — proxy or with branching | `*.integration.test.ts` with MSW (+ `*.test.ts` for extracted pure logic) |
| Server action / middleware / error-loading-not-found / metadata | See guide — depends on type |
