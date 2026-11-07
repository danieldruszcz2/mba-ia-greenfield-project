---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-03T09:40:42.535268200-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-03T09:40:11.011019400-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-03T09:39:15.880306000-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-11-02T15:44:08.923761000-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar no `nestjs-project/` o upload de vídeos de até 10GB sem impacto na performance (direto ao object storage via multipart pré-assinado), o pré-cadastro automático do vídeo como rascunho ao iniciar o upload, o processamento automático em segundo plano por fila e worker (extração de duração e metadados e geração de thumbnail a partir de um frame), a URL única por vídeo sem conflito, a reprodução via streaming sem download completo e o download do vídeo pelo usuário.

---

## Step Implementations

### SI-03.1 — Infra: object storage, Redis e contrato de env

**Description:** Sobe MinIO e Redis no Compose, cria os buckets e fecha o contrato de variáveis de ambiente de storage e fila. Toda SI seguinte depende disso.

**Technical actions:**

1. Em `nestjs-project/compose.yaml`, adicionar:
   - `minio`: imagem Chainguard pinada por digest, nunca `latest`, porta `9000`, com healthcheck (per `phase-03-videos/TD-01`).
   - `minio-init`: one-shot com `mc`, idempotente. Cria os buckets `videos` (privado) e `thumbnails`, e aplica `anonymous download` só em `thumbnails` (per `phase-03-videos/TD-02`).
   - `redis`: porta `6379`, com healthcheck (per `phase-03-videos/TD-06`).
   - `nestjs-api` passa a declarar `depends_on` em `minio` e `redis`.
2. Instalar `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `@nestjs/bullmq` e `bullmq` dentro do container (versões conforme `library-refs.md`).
3. Estender o schema Joi em `src/config/env.validation.ts` com `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET_VIDEOS`, `S3_BUCKET_THUMBNAILS`, `REDIS_HOST` e `REDIS_PORT`, todas obrigatórias (per `phase-03-videos/TD-03`; convenção Joi de `phase-01-configuracao-base/TD-02`).
4. Criar `src/config/storage.config.ts` e `src/config/redis.config.ts` com `registerAs`, um arquivo por domínio (per `phase-01-configuracao-base/TD-03`).
5. Atualizar `.env` e `.env.example` com os hosts do Compose (`S3_ENDPOINT=http://minio:9000`, `REDIS_HOST=redis`) e `S3_PUBLIC_ENDPOINT=http://localhost:9000` para quem chama de fora da rede Docker. No ambiente de testes, que roda dentro do container, `S3_PUBLIC_ENDPOINT` aponta para `http://minio:9000` (per `phase-03-videos/TD-03`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `env.validation` | Integration: falha no boot quando falta qualquer chave `S3_*` ou `REDIS_*` | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` deixa `minio` e `redis` com status `healthy`, e `minio-init` termina com exit code 0.
- Os buckets `videos` e `thumbnails` existem depois de subir o ambiente. Rodar `minio-init` de novo não falha.
- Um objeto em `thumbnails` responde `200` a um GET anônimo, e um objeto em `videos` responde `403`.
- A API não sobe quando falta `S3_PUBLIC_ENDPOINT` ou `REDIS_HOST`, e o erro cita a chave ausente.

---

### SI-03.2 — Criar StorageModule (clientes S3 interno e público)

**Description:** Encapsula todo acesso ao object storage num `StorageService`, com a separação entre endpoint interno e público. Assim nenhum outro módulo fala com o SDK S3 direto.

**Technical actions:**

1. Criar `src/storage/storage.module.ts`, exportando `StorageService` e injetando `storageConfig.KEY` (convenção `ConfigType` de `phase-01-configuracao-base/TD-03`).
2. Criar `src/storage/storage.service.ts` com dois `S3Client`, ambos com `forcePathStyle: true` (per `phase-03-videos/TD-01`, `TD-03`; library-refs `@aws-sdk/client-s3`):
   - **interno** (`S3_ENDPOINT`): chamadas servidor-a-servidor.
   - **público** (`S3_PUBLIC_ENDPOINT`): usado só para assinar URLs devolvidas ao cliente.
3. Expor os métodos de multipart:
   - `createMultipartUpload(key, contentType)`
   - `presignUploadParts(key, uploadId, partNumbers, expiresIn)`, assinado com o cliente público
   - `listParts(key, uploadId)`
   - `completeMultipartUpload(key, uploadId, parts)`
   - `abortMultipartUpload(key, uploadId)`, que trata `NoSuchUpload` como sucesso

   (per `phase-03-videos/TD-04`, `TD-05`; library-refs `@aws-sdk/s3-request-presigner`)
4. Expor os métodos de leitura e escrita:
   - `presignGetObject(key, { client: 'internal' | 'public', expiresIn, downloadFilename? })`. Com `downloadFilename`, define `ResponseContentDisposition: attachment` (per `phase-03-videos/TD-09`, `TD-11`).
   - `putObject(bucket, key, body, contentType)`
   - `buildPublicThumbnailUrl(key)`, que devolve `{S3_PUBLIC_ENDPOINT}/{S3_BUCKET_THUMBNAILS}/{key}` (per `phase-03-videos/TD-02`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageModule` | Unit: compilation test | `src/storage/storage.module.spec.ts` |
| `StorageService` | Integration: MinIO real do Compose — multipart completo, `ListParts`, abort idempotente, GET assinado com `Range` → `206` | `src/storage/storage.service.integration-spec.ts` |

**Dependencies:** SI-03.1 — MinIO, buckets e chaves de env precisam existir.

**Acceptance criteria:**

- Um upload multipart em 2 partes, com PUT em cada URL assinada e depois `completeMultipartUpload`, gera um objeto no bucket `videos` com o tamanho somado das partes.
- `listParts` depois de enviar só a parte 1 devolve exatamente `[{ partNumber: 1, etag, sizeBytes }]`.
- `abortMultipartUpload` chamado duas vezes no mesmo `UploadId` não lança erro.
- Uma URL de `presignGetObject` respondida com `Range: bytes=0-99` retorna `206` e 100 bytes.
- As URLs assinadas com o cliente público têm o host de `S3_PUBLIC_ENDPOINT`, e as do cliente interno têm o host de `S3_ENDPOINT`.

---

### SI-03.3 — Criar entidade Video, migration e gerador de public_id

**Description:** Cria a tabela `videos` ligada ao canal, com o ciclo de status da fase, e o gerador do ID público curto que garante URL única.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` com os campos, tipos e constraints do Data Model (`### Data Model → Video`):
   - enum `VideoStatus` (`uploading`, `processing`, `ready`, `failed`), com default `uploading` (per `phase-03-videos/TD-13`).
   - `ManyToOne` com `Channel` via `channel_id`, com `onDelete: 'CASCADE'`.
2. Gerar a migration em `src/database/migrations/` com:
   - o tipo `video_status`;
   - o índice unique em `public_id`;
   - os índices em `channel_id` e em `(status, updated_at)`.
3. Criar `src/videos/public-id.util.ts` — `generatePublicId()`. Gera 11 caracteres URL-safe (`[A-Za-z0-9_-]`) a partir de `crypto.randomBytes` do `node:crypto`, sem dependência nova (per `phase-03-videos/TD-12`).
4. Criar `src/videos/videos.repository.ts` (ou um método no service da SI-03.5) — `insertWithUniquePublicId(data)`. Tenta o insert e, em violação de unique de `public_id` (`23505`), gera outro ID e tenta de novo, até 3 vezes (per `phase-03-videos/TD-12`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: `public_id` unique, `status` default `uploading`, cascade ao remover o canal | `src/videos/entities/video.entity.integration-spec.ts` |
| `generatePublicId` | Unit: tamanho 11, alfabeto URL-safe, sem repetição em 10k chamadas | `src/videos/public-id.util.spec.ts` |
| `insertWithUniquePublicId` | Integration: colisão forçada no 1º ID faz retry e grava com outro `public_id` | `src/videos/videos.repository.integration-spec.ts` |

**Dependencies:** none — só depende do `Channel` da fase 02.

**Acceptance criteria:**

- Inserir um vídeo sem `status` grava `status = 'uploading'`.
- Inserir dois vídeos com o mesmo `public_id` falha na constraint unique.
- Remover o canal remove os vídeos dele.
- `npm run migration:run` num banco limpo cria `videos` e `video_status`, e `migration:revert` desfaz sem erro.
- Quando o primeiro `public_id` gerado colide, o vídeo é gravado com um segundo ID diferente.

---

### SI-03.4 — Configurar fila BullMQ e producer de processamento

**Description:** Liga o Nest ao Redis via BullMQ, registra as filas `video-processing` e `video-maintenance` e cria o producer idempotente usado pela API.

**Technical actions:**

1. Criar `src/queue/queue.module.ts` com `BullModule.forRootAsync({ imports: [ConfigModule], inject: [redisConfig.KEY], useFactory: (cfg) => ({ connection: { host, port } }) })` (per `phase-03-videos/TD-06`; library-refs `@nestjs/bullmq`; convenção `forRootAsync` + `inject` de `phase-01-configuracao-base/TD-03`).
2. Registrar as filas:
   - `video-processing`, com `defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 1000 } }` (per `phase-03-videos/TD-13`).
   - `video-maintenance`.

   Nenhum processor é registrado neste módulo, porque a API só produz (per `phase-03-videos/TD-07`).
3. Criar `src/queue/video-processing.producer.ts`, com `enqueue(videoId)` → `queue.add('process-video', { videoId }, { jobId: videoId })`. Ver `### Events/Messages → video-processing → process-video` (per `phase-03-videos/TD-06`, `TD-08`).
4. Importar `QueueModule` em `AppModule`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `QueueModule` | Unit: compilation test com `redisConfig` | `src/queue/queue.module.spec.ts` |
| `VideoProcessingProducer` | Integration: Redis real — job criado com `jobId = videoId`, opções de retry aplicadas, 2º `enqueue` não duplica | `src/queue/video-processing.producer.integration-spec.ts` |

**Dependencies:** SI-03.1 — Redis e `redisConfig`.

**Acceptance criteria:**

- `enqueue(videoId)` cria na fila `video-processing` um job `process-video` com payload `{ videoId }` e `id = videoId`.
- O job criado tem `attempts = 3` e backoff exponencial com `delay = 1000`.
- Chamar `enqueue` duas vezes com o mesmo `videoId` deixa um único job na fila.
- A API sobe sem registrar worker: nenhum job é consumido pelo processo da API.

---

### SI-03.5 — Implementar ciclo de upload no VideosService

**Description:** Regras de negócio do upload: pré-cadastro do rascunho, URLs de parte, retomada, conclusão com enfileiramento e abort. Tudo com checagem de dono.

**Technical actions:**

1. Criar as exceções de domínio em `src/videos/videos.exceptions.ts`, todas estendendo o `DomainException` existente com os `errorCode` do `### Error Catalog`: `VIDEO_NOT_FOUND`, `VIDEO_TOO_LARGE`, `UNSUPPORTED_VIDEO_TYPE`, `VIDEO_UPLOAD_NOT_IN_PROGRESS` e `INVALID_UPLOAD_PARTS` (per `phase-02-auth/TD-07`).
2. Criar `src/videos/videos.service.ts` — `initiateUpload(userId, dto)`:
   - resolve o canal do usuário;
   - valida `sizeBytes ≤ 10737418240` e o allowlist `video/mp4` / `video/webm` (per `phase-03-videos/TD-05`, `TD-10`);
   - fixa `part_size_bytes = 67108864`;
   - grava o rascunho via `insertWithUniquePublicId`, com `storage_key = {id}/original`;
   - chama `createMultipartUpload` e salva o `upload_id`;
   - devolve `{ id, status, partSizeBytes, partCount }` (per `phase-03-videos/TD-04`, `TD-13`).
3. Criar `findOwnedOrFail(publicId, userId)`, que lança `VIDEO_NOT_FOUND` quando o vídeo não existe ou é de outro usuário (per `phase-03-videos/TD-14`). Criar também `assertUploading(video)`, que lança `VIDEO_UPLOAD_NOT_IN_PROGRESS`.
4. Implementar:
   - `getPartUrls(publicId, userId, partNumbers)`, que valida `1..partCount` e devolve `{ parts, expiresAt }`;
   - `listUploadedParts(publicId, userId)`.

   Ambos tocam `updated_at`, para o vídeo não ser considerado abandonado (per `phase-03-videos/TD-05`).
5. Implementar `completeUpload(publicId, userId, parts)` e `abortUpload(publicId, userId)`:
   - **`completeUpload`**: chama `completeMultipartUpload`, mapeia `InvalidPart` / `InvalidPartOrder` / contagem errada para `INVALID_UPLOAD_PARTS`, faz `status = processing`, `upload_id = null` e chama `VideoProcessingProducer.enqueue(video.id)` (per `phase-03-videos/TD-08`).
   - **`abortUpload`**: chama `abortMultipartUpload` e remove a linha (per `phase-03-videos/TD-05`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` (upload) | Unit: ramos de validação, dono, status e mapeamento de erro do storage (mocks de `StorageService`, `VideoProcessingProducer`, repositório) | `src/videos/videos.service.spec.ts` |
| `VideosService` (upload) | Integration: banco real + MinIO real + Redis real — pré-cadastro, complete enfileira, abort remove linha e multipart | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.2 (StorageService), SI-03.3 (entidade + public_id), SI-03.4 (producer).

**Acceptance criteria:**

- `initiateUpload` com 1 GiB `video/mp4` grava um vídeo `uploading` no canal do usuário, com `upload_id` preenchido e `partCount = 16`.
- `initiateUpload` com 11 GiB lança `VIDEO_TOO_LARGE`, e com `video/x-msvideo` lança `UNSUPPORTED_VIDEO_TYPE`. Nenhuma linha é gravada.
- Qualquer operação com o `public_id` de um vídeo de outro usuário lança `VIDEO_NOT_FOUND`.
- `completeUpload` com as partes corretas deixa o vídeo `processing`, com `upload_id = null`, e um job `process-video` com `jobId = video.id` na fila.
- `completeUpload` com ETag errado lança `INVALID_UPLOAD_PARTS`, e o vídeo continua `uploading`.
- `abortUpload` remove a linha e o multipart some do `ListMultipartUploads` do bucket.
- Operações de upload num vídeo `processing` lançam `VIDEO_UPLOAD_NOT_IN_PROGRESS`.

---

### SI-03.6 — Endpoints de upload (VideosController)

**Route:** POST /videos, POST /videos/:id/upload/part-urls, GET /videos/:id/upload/parts, POST /videos/:id/upload/complete, DELETE /videos/:id/upload
**Test Specs:** see `nestjs-project/specs/videos-upload.plan.md`
**Authorization:** Authenticated; dono do vídeo nas rotas com `:id` (ver `### Authorization Matrix`)

**Description:** Expõe o ciclo de upload por HTTP. O controller fica fino: o arquivo de 10GB nunca passa por aqui, só JSON pequeno.

**Technical actions:**

1. Criar os DTOs em `src/videos/dto/` com `class-validator`, usando os campos exatos de `### API Contracts` (per `phase-02-auth/TD-06`):
   - `InitiateUploadDto`: `title`, `filename`, `contentType`, `sizeBytes`
   - `PartUrlsDto`: `partNumbers`
   - `CompleteUploadDto`: `parts[{ partNumber, etag }]`
2. Criar `src/videos/videos.controller.ts` com as 5 rotas de upload, delegando para o `VideosService` (SI-03.5) com os status do `### API Contracts`: `201`, `200`, `200`, `202`, `204`. As rotas ficam protegidas pelo guard JWT global, sem `@Public` (per `phase-02-auth/TD-02`).
3. Anotar as rotas e os DTOs com `@nestjs/swagger`, incluindo os envelopes de erro, e regenerar o `openapi.json` exportado (per `openapi-docs-nestjs/TD-01`, `TD-02`).
4. Criar `src/videos/videos.module.ts`, importando `TypeOrmModule.forFeature([Video, Channel])`, `StorageModule` e `QueueModule`, e registrar `VideosModule` em `AppModule`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosModule` | Unit: compilation test | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.5 (regras de upload).

**Acceptance criteria:**

- `POST /videos` com `{ title, filename, contentType: "video/mp4", sizeBytes: 104857600 }` retorna `201` com `{ id, status: "uploading", partSizeBytes: 67108864, partCount: 2 }`, e `id` tem 11 caracteres.
- `POST /videos/:id/upload/part-urls` com `{ partNumbers: [1, 2] }` retorna `200` com 2 URLs e `expiresAt`. Um PUT direto em cada URL é aceito pelo storage.
- `GET /videos/:id/upload/parts` depois de enviar a parte 1 retorna `200` com `parts` contendo só `partNumber: 1`.
- `POST /videos/:id/upload/complete` com as partes e ETags corretas retorna `202` com `{ id, status: "processing" }`.
- `DELETE /videos/:id/upload` num vídeo `uploading` retorna `204`, e o `GET /videos/:id` seguinte retorna `404 VIDEO_NOT_FOUND`.
- Qualquer rota sem token retorna `401`. Com token de outro usuário, as rotas com `:id` retornam `404 VIDEO_NOT_FOUND`.
- `POST /videos` com `sizeBytes` acima de 10 GiB retorna `400 VIDEO_TOO_LARGE`. Com `contentType: "video/avi"`, retorna `400 UNSUPPORTED_VIDEO_TYPE`. Com body sem `title`, retorna `400` de validação.
- As 5 rotas aparecem no `openapi.json` exportado.

---

### SI-03.7 — Infra: entrypoint e container do video worker

**Description:** Cria o processo separado que consome a fila, com o mesmo código da API e um segundo entrypoint. Também coloca o `ffmpeg`/`ffprobe` na imagem.

**Technical actions:**

1. Criar `src/worker/worker.module.ts`, que importa `ConfigModule`, `TypeOrmModule.forRootAsync` (mesma factory de `databaseConfig`), `StorageModule` e `QueueModule`. Os processors entram nas SI-03.8 e SI-03.9 (per `phase-03-videos/TD-07`; convenções de `phase-01-configuracao-base`).
2. Criar `src/worker.ts`, que faz `NestFactory.createApplicationContext(WorkerModule)` + `app.enableShutdownHooks()`, sem servidor HTTP (per `phase-03-videos/TD-07`; library-refs `@nestjs/bullmq`).
3. Adicionar os scripts `start:worker:dev` (watch) e `start:worker` (a partir do `dist/worker.js`) no `package.json`.
4. Instalar `ffmpeg` (que inclui `ffprobe`) no `Dockerfile.dev` (per `phase-03-videos/TD-09`). Adicionar o serviço `video-worker` em `compose.yaml`, com o mesmo build do `nestjs-api`, comando `npm run start:worker:dev`, `depends_on` em `db`, `minio` e `redis`, e sem portas publicadas.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `WorkerModule` | Unit: compilation test | `src/worker/worker.module.spec.ts` |

**Dependencies:** SI-03.1 (Compose + env), SI-03.2 (StorageModule), SI-03.4 (QueueModule).

**Acceptance criteria:**

- `docker compose up -d` deixa `video-worker` com status `running`, e os logs mostram o contexto Nest inicializado sem erro.
- `docker compose exec video-worker ffprobe -version` e `ffmpeg -version` respondem com exit code 0.
- O `video-worker` não escuta nenhuma porta HTTP.
- `docker compose stop video-worker` encerra o processo de forma limpa: nenhum job fica travado como `active` na fila.

---

### SI-03.8 — Implementar VideoProcessor (metadados, thumbnail e status)

**Description:** Consome `process-video`, extrai duração e metadados, gera a thumbnail a partir de um frame e fecha o ciclo em `ready` ou `failed`.

**Technical actions:**

1. Criar `src/worker/media-probe.service.ts` com dois métodos, ambos via `child_process.spawn` e sem `fluent-ffmpeg` (per `phase-03-videos/TD-09`):
   - `probe(url)`: roda `ffprobe -v error -print_format json -show_format -show_streams <url>` e devolve `durationSeconds` e `metadata` (`container`, `videoCodec`, `audioCodec`, `width`, `height`, `bitrate`).
   - `extractFrame(url, atSeconds)`: roda `ffmpeg -ss <t> -i <url> -frames:v 1 -f image2 pipe:1` e devolve um `Buffer` JPEG.
2. Implementar o codec gate em `media-probe.service.ts` — `assertPlayable(metadata)`. Aceita `mp4` com `h264`/`aac` e `webm` com `vp8`/`vp9`/`av1` + `opus`/`vorbis`. Fora disso, lança `UnrecoverableError` com `UNPLAYABLE_CODEC` (per `phase-03-videos/TD-10`; library-refs `bullmq`).
3. Criar `src/worker/video.processor.ts` — `@Processor('video-processing') extends WorkerHost`. O `process(job)` segue estes passos:
   - Carrega o vídeo e não faz nada se já estiver `ready`, para ser idempotente.
   - Gera uma URL assinada pelo cliente **interno** e roda `probe` (per `phase-03-videos/TD-03`).
   - Roda `assertPlayable`.
   - Chama `extractFrame` em ~10% da duração, limitado a `[0, duration − 0.1]`.
   - Faz `putObject` no bucket `thumbnails` com a chave `{id}.jpg`.
   - Grava `duration_seconds`, `metadata`, `thumbnail_key` e `status = ready`.
4. No `onApplicationBootstrap`, registrar `worker.on('failed')`. Quando as tentativas acabam ou o erro é unrecoverable, grava `status = failed` e `failure_reason` = `UNPLAYABLE_CODEC` ou `PROCESSING_FAILED` (per `phase-03-videos/TD-13`; ver `### Error Catalog → failure_reason`). Registrar `VideoProcessor` e `MediaProbeService` no `WorkerModule`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `MediaProbeService` | Integration: `ffprobe`/`ffmpeg` reais sobre fixtures pequenas (`test/fixtures/sample.mp4` h264/aac e `test/fixtures/unplayable.avi`) servidas pelo MinIO | `src/worker/media-probe.service.integration-spec.ts` |
| `MediaProbeService.assertPlayable` | Unit: matriz container × codec aceitos e rejeitados | `src/worker/media-probe.service.spec.ts` |
| `VideoProcessor` | Integration: banco + MinIO + Redis reais — job ponta a ponta até `ready`, codec rejeitado vira `failed` sem retry, erro transitório faz retry | `src/worker/video.processor.integration-spec.ts` |

**Dependencies:** SI-03.3 (entidade Video), SI-03.7 (worker + ffmpeg na imagem).

**Acceptance criteria:**

- Um job `process-video` para um `sample.mp4` de 5s deixa o vídeo `ready`, com `duration_seconds ≈ 5`, `metadata.videoCodec = "h264"` e `thumbnail_key = "{id}.jpg"`.
- A thumbnail gerada existe no bucket `thumbnails` e é um JPEG válido, que abre como imagem.
- Um vídeo com codec fora do allowlist termina `failed` com `failure_reason = "UNPLAYABLE_CODEC"`, depois de uma única tentativa.
- Uma falha de storage em todas as 3 tentativas termina `failed` com `failure_reason = "PROCESSING_FAILED"`.
- Reprocessar o job de um vídeo já `ready` não altera a linha nem a thumbnail.
- O worker lê o vídeo por HTTP Range e não baixa o arquivo inteiro para disco.

---

### SI-03.9 — Limpeza agendada de uploads abandonados

**Description:** Job agendado no worker que aborta multiparts e apaga rascunhos `uploading` parados há mais de 24h, para que o storage e o banco não acumulem lixo.

**Technical actions:**

1. Criar `src/worker/upload-cleanup.processor.ts` — `@Processor('video-maintenance') extends WorkerHost`. Para cada vídeo `status = uploading` com `updated_at < now() - 24h` (que usa o índice `(status, updated_at)`), chama `abortMultipartUpload` e remove a linha (per `phase-03-videos/TD-05`).
2. No `onApplicationBootstrap` do worker, chamar `queue.upsertJobScheduler('abandoned-upload-cleanup', { every: 3600000 }, { name: 'abandoned-upload-cleanup' })`, que é idempotente. Não usar a opção `repeat`, removida na v6 (per `phase-03-videos/TD-05`; library-refs `bullmq`).
3. Colocar o limite de 24h em uma constante única do módulo `videos` (`ABANDONED_UPLOAD_TTL_MS`) e registrar `UploadCleanupProcessor` no `WorkerModule`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `UploadCleanupProcessor` | Integration: banco + MinIO reais — remove só os `uploading` antigos, mantém os recentes e os `processing`/`ready`, e trata `NoSuchUpload` como sucesso | `src/worker/upload-cleanup.processor.integration-spec.ts` |

**Dependencies:** SI-03.2 (abort multipart), SI-03.3 (entidade), SI-03.7 (worker).

**Acceptance criteria:**

- Um vídeo `uploading` com `updated_at` de 25h atrás é removido, e o multipart dele some do bucket.
- Um vídeo `uploading` com `updated_at` de 1h atrás continua intacto.
- Vídeos `processing`, `ready` e `failed` nunca são removidos pela limpeza, qualquer que seja a idade.
- Depois de reiniciar o worker duas vezes, existe um único scheduler `abandoned-upload-cleanup` na fila `video-maintenance`.
- Um `UploadId` já abortado não faz o job falhar.

---

### SI-03.10 — Implementar leitura e entrega no VideosService

**Description:** Regras de leitura do vídeo e de assinatura das URLs de stream e download, restritas ao dono e só para vídeos prontos.

**Technical actions:**

1. Adicionar a exceção `VIDEO_NOT_READY` em `src/videos/videos.exceptions.ts` (ver `### Error Catalog`; per `phase-02-auth/TD-07`).
2. Implementar `getDetail(publicId, userId)` em `src/videos/videos.service.ts`: usa `findOwnedOrFail` e mapeia para o shape de `GET /videos/:id`. `thumbnailUrl` vem de `buildPublicThumbnailUrl(thumbnail_key)`, ou é `null` (per `phase-03-videos/TD-02`, `TD-14`).
3. Implementar `getStreamUrl(publicId, userId)`: exige `status = ready` (senão lança `VIDEO_NOT_READY`) e devolve `{ url, expiresAt }` de `presignGetObject` pelo cliente **público** (per `phase-03-videos/TD-10`, `TD-11`).
4. Implementar `getDownloadUrl(publicId, userId)`: igual ao stream, mas passa `downloadFilename = original_filename` para `ResponseContentDisposition: attachment` (per `phase-03-videos/TD-11`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` (leitura) | Unit: ramos de dono, `VIDEO_NOT_READY` por status e mapeamento do detalhe | `src/videos/videos.service.spec.ts` |
| `VideosService` (leitura) | Integration: MinIO real — URL de stream responde `206` a `Range`, e a de download traz `Content-Disposition: attachment` | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.2 (presign), SI-03.5 (`findOwnedOrFail` + exceções).

**Acceptance criteria:**

- `getDetail` de um vídeo `ready` devolve `durationSeconds`, `metadata` e um `thumbnailUrl` que responde `200` sem autenticação.
- `getDetail` de um vídeo `uploading` devolve `thumbnailUrl = null` e `durationSeconds = null`.
- `getStreamUrl` e `getDownloadUrl` de um vídeo `processing` ou `failed` lançam `VIDEO_NOT_READY`.
- A URL de `getStreamUrl` com `Range: bytes=0-1023` responde `206` com 1024 bytes, e `expiresAt` fica no futuro.
- A URL de `getDownloadUrl` responde com `Content-Disposition: attachment; filename="{original_filename}"`.

---

### SI-03.11 — Endpoints de detalhe, stream e download

**Route:** GET /videos/:id, GET /videos/:id/stream, GET /videos/:id/download
**Test Specs:** see `nestjs-project/specs/videos-delivery.plan.md`
**Authorization:** Owner only (ver `### Authorization Matrix`)

**Description:** Expõe a leitura do vídeo e a entrega por URL assinada. É aqui que o fluxo completo da fase fecha: upload → processamento → streaming e download.

**Technical actions:**

1. Adicionar as 3 rotas `GET` em `src/videos/videos.controller.ts`, delegando para `getDetail`, `getStreamUrl` e `getDownloadUrl` (SI-03.10). Todas retornam `200` com os shapes de `### API Contracts` (per `phase-03-videos/TD-11`).
2. Criar os DTOs de resposta em `src/videos/dto/`: `VideoDetailDto` e `SignedUrlDto { url, expiresAt }`. Anotar tudo com `@nestjs/swagger` e regenerar o `openapi.json` exportado (per `openapi-docs-nestjs/TD-01`, `TD-02`).

**Tests:**

_(empty — controller wiring; cenários E2E vêm do spec de /plan-test-specs, e as regras são testadas na SI-03.10)_

**Dependencies:** SI-03.6 (controller + módulo), SI-03.8 (vídeo chega em `ready`), SI-03.10 (regras de leitura).

**Acceptance criteria:**

- Depois de upload completo e processamento, `GET /videos/:id` retorna `200` com `status: "ready"`, `durationSeconds` e `thumbnailUrl`.
- `GET /videos/:id/stream` de um vídeo `ready` retorna `200` com `{ url, expiresAt }`. Um GET na `url` com `Range: bytes=0-1023` retorna `206`.
- `GET /videos/:id/download` de um vídeo `ready` retorna `200` com `{ url, expiresAt }`. Um GET na `url` traz `Content-Disposition: attachment`.
- `GET /videos/:id/stream` de um vídeo `processing` retorna `409 VIDEO_NOT_READY`.
- As 3 rotas retornam `401` sem token e `404 VIDEO_NOT_FOUND` com token de outro usuário.
- As 3 rotas aparecem no `openapi.json` exportado.

---

## Technical Specifications

### Data Model

#### Video (`videos`)

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated. Internal ID, also used in storage keys *(per phase-03-videos/TD-02, TD-12)* |
| public_id | varchar(11) | unique, not null. URL-safe random ID from `node:crypto`, regenerated and retried on unique violation *(per phase-03-videos/TD-12)* |
| channel_id | uuid | FK → `channels.id`, not null, on delete cascade |
| title | varchar(100) | not null |
| status | enum `video_status` (`uploading`, `processing`, `ready`, `failed`) | not null, default `uploading` *(per phase-03-videos/TD-13)* |
| original_filename | varchar(255) | not null |
| content_type | varchar(100) | not null. Allowlist `video/mp4`, `video/webm` *(per phase-03-videos/TD-05, TD-10)* |
| size_bytes | bigint | not null, `> 0` and `≤ 10 GiB` (10737418240) *(per phase-03-videos/TD-05)* |
| part_size_bytes | integer | not null. Set by the server, 64 MiB (67108864) *(per phase-03-videos/TD-05)* |
| storage_key | varchar(255) | not null. Key in the `videos` bucket: `{id}/original` *(per phase-03-videos/TD-02)* |
| upload_id | varchar(255) | nullable. S3 multipart `UploadId`; set while `status = uploading`, cleared on complete or abort *(per phase-03-videos/TD-04)* |
| thumbnail_key | varchar(255) | nullable. Key in the `thumbnails` bucket: `{id}.jpg`; set by the worker *(per phase-03-videos/TD-02, TD-09)* |
| duration_seconds | numeric(10,3) | nullable. Set by the worker from ffprobe *(per phase-03-videos/TD-09)* |
| metadata | jsonb | nullable. ffprobe summary: `container`, `videoCodec`, `audioCodec`, `width`, `height`, `bitrate` *(per phase-03-videos/TD-09)* |
| failure_reason | varchar(255) | nullable. Set when `status = failed` *(per phase-03-videos/TD-13)* |
| created_at | timestamp | `@CreateDateColumn` |
| updated_at | timestamp | `@UpdateDateColumn`. Staleness reference for the cleanup job *(per phase-03-videos/TD-05)* |

**Relations:** `Channel` has many `Video` (one-to-many, `video.channel_id`). Ownership is resolved through `channels.user_id`.
**Indexes:** unique on `public_id`; index on `channel_id`; composite index on `(status, updated_at)` for the cleanup job.

**State transitions** *(per phase-03-videos/TD-13)*:

- `uploading → processing`: `POST /videos/:id/upload/complete` succeeds and the job is enqueued.
- `processing → ready`: the worker probes, passes the codec gate and stores the thumbnail.
- `processing → failed`: the codec gate rejects the file (no retry), or every retry attempt is exhausted.
- `uploading → (deleted)`: explicit abort, or the cleanup job after 24h without activity. The row and the multipart upload are removed.

`published`/visibility is **not** part of this phase. Phase 04 adds it as a separate column.

### API Contracts

All endpoints require `Authorization: Bearer <access token>`, through the inherited global JWT guard *(per phase-02-auth/TD-02)*. `:id` is always the `public_id` *(per phase-03-videos/TD-12)*. Errors use the inherited `{ statusCode, error, message }` envelope *(per phase-02-auth/TD-07)*. Every endpoint is documented in the exported `openapi.json` *(per openapi-docs-nestjs/TD-01, TD-02)*. Presigned URLs are always signed with the **public** S3 client (`S3_PUBLIC_ENDPOINT`) *(per phase-03-videos/TD-03)*.

#### POST /videos (SI-03.5)

Pre-registers the draft and opens the S3 multipart upload *(per phase-03-videos/TD-04, TD-05, TD-13)*.

**Request headers:**
- Content-Type: application/json

**Request body:**
- title: string, required — 1..100 characters
- filename: string, required — 1..255 characters
- contentType: string, required — one of `video/mp4`, `video/webm`
- sizeBytes: integer, required — `1..10737418240`

**Response 201:**
- id: string (public_id, 11 chars)
- status: `"uploading"`
- partSizeBytes: integer (67108864)
- partCount: integer (`ceil(sizeBytes / partSizeBytes)`)

**Error responses:**
- 400 VIDEO_TOO_LARGE: when `sizeBytes` > 10 GiB
- 400 UNSUPPORTED_VIDEO_TYPE: when `contentType` is not in the allowlist
- 400 validation error: when the request body fails schema validation

---

#### POST /videos/:id/upload/part-urls (SI-03.5)

Signs `UploadPart` URLs for the requested parts. The client PUTs each part's bytes directly to storage and keeps the `ETag` response header *(per phase-03-videos/TD-04)*.

**Request body:**
- partNumbers: integer[], required — 1..100 items, each `1..partCount`, no duplicates

**Response 200:**
- parts: `{ partNumber: integer, url: string }[]`
- expiresAt: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when the id does not exist or the video belongs to another user
- 409 VIDEO_UPLOAD_NOT_IN_PROGRESS: when `status != uploading`
- 400 validation error: when `partNumbers` is invalid or out of range

---

#### GET /videos/:id/upload/parts (SI-03.5)

Lists the parts storage already has, so an interrupted upload can resume (`ListParts`) *(per phase-03-videos/TD-04)*.

**Response 200:**
- parts: `{ partNumber: integer, etag: string, sizeBytes: integer }[]`

**Error responses:**
- 404 VIDEO_NOT_FOUND: when the id does not exist or the video belongs to another user
- 409 VIDEO_UPLOAD_NOT_IN_PROGRESS: when `status != uploading`

---

#### POST /videos/:id/upload/complete (SI-03.5)

Completes the multipart upload, moves the video to `processing` and enqueues `process-video` *(per phase-03-videos/TD-04, TD-08, TD-13)*.

**Request body:**
- parts: `{ partNumber: integer, etag: string }[]`, required — exactly `partCount` items, ascending `partNumber`

**Response 202:**
- id: string (public_id)
- status: `"processing"`

**Error responses:**
- 404 VIDEO_NOT_FOUND: when the id does not exist or the video belongs to another user
- 409 VIDEO_UPLOAD_NOT_IN_PROGRESS: when `status != uploading`
- 400 INVALID_UPLOAD_PARTS: when storage rejects the part list (missing part, wrong ETag, or wrong count)
- 400 validation error: when the request body fails schema validation

---

#### DELETE /videos/:id/upload (SI-03.5)

Aborts an in-progress upload: aborts the multipart upload and deletes the draft row *(per phase-03-videos/TD-05)*.

**Response 204:** No content.

**Error responses:**
- 404 VIDEO_NOT_FOUND: when the id does not exist or the video belongs to another user
- 409 VIDEO_UPLOAD_NOT_IN_PROGRESS: when `status != uploading`

---

#### GET /videos/:id (SI-03.8)

**Response 200:**
- id: string (public_id)
- title: string
- status: `"uploading" | "processing" | "ready" | "failed"`
- sizeBytes: integer
- contentType: string
- durationSeconds: number | null
- metadata: `{ container, videoCodec, audioCodec, width, height, bitrate }` | null
- thumbnailUrl: string | null — stable public URL `{S3_PUBLIC_ENDPOINT}/{S3_BUCKET_THUMBNAILS}/{thumbnail_key}` *(per phase-03-videos/TD-02)*
- failureReason: string | null
- createdAt: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when the id does not exist or the video belongs to another user

---

#### GET /videos/:id/stream (SI-03.8)

Returns a short-lived presigned `GetObject` URL. Storage answers the player's `Range` requests with `206 Partial Content`, so the bytes never pass through Node *(per phase-03-videos/TD-10, TD-11)*.

**Response 200:**
- url: string
- expiresAt: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when the id does not exist or the video belongs to another user
- 409 VIDEO_NOT_READY: when `status != ready`

---

#### GET /videos/:id/download (SI-03.8)

Same as `/stream`, but the URL is signed with `ResponseContentDisposition: attachment; filename="{original_filename}"` *(per phase-03-videos/TD-11)*.

**Response 200:**
- url: string
- expiresAt: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when the id does not exist or the video belongs to another user
- 409 VIDEO_NOT_READY: when `status != ready`

### Authorization Matrix

Owner means `videos.channel_id → channels.user_id = authenticated user id` *(per phase-03-videos/TD-14)*. A non-owner gets `404 VIDEO_NOT_FOUND`, not 403, so the endpoint does not reveal that the video exists.

| Endpoint | Anonymous | Authenticated (non-owner) | Owner |
|----------|-----------|---------------|-------|
| POST /videos | ✗ (401) | ✓ (becomes owner) | — |
| POST /videos/:id/upload/part-urls | ✗ (401) | ✗ (404) | ✓ |
| GET /videos/:id/upload/parts | ✗ (401) | ✗ (404) | ✓ |
| POST /videos/:id/upload/complete | ✗ (401) | ✗ (404) | ✓ |
| DELETE /videos/:id/upload | ✗ (401) | ✗ (404) | ✓ |
| GET /videos/:id | ✗ (401) | ✗ (404) | ✓ |
| GET /videos/:id/stream | ✗ (401) | ✗ (404) | ✓ |
| GET /videos/:id/download | ✗ (401) | ✗ (404) | ✓ |

Thumbnails are the one exception: they are served by the public-read `thumbnails` bucket. Its keys are the internal UUID, so the URLs cannot be enumerated *(per phase-03-videos/TD-02)*.

### Error Catalog

The envelope is inherited from phase 02 (`DomainException` + domain exception filter → `{ statusCode, error, message }`) *(per phase-02-auth/TD-07)*.

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_NOT_FOUND | 404 | The `public_id` does not exist, or the video belongs to another user |
| VIDEO_TOO_LARGE | 400 | `sizeBytes` > 10 GiB at pre-registration |
| UNSUPPORTED_VIDEO_TYPE | 400 | `contentType` is not `video/mp4` or `video/webm` |
| VIDEO_UPLOAD_NOT_IN_PROGRESS | 409 | An upload operation (part-urls, parts, complete, abort) on a video whose `status != uploading` |
| INVALID_UPLOAD_PARTS | 400 | `CompleteMultipartUpload` rejected by storage (S3 `InvalidPart` / `InvalidPartOrder`) or wrong part count |
| VIDEO_NOT_READY | 409 | Stream/download requested while `status != ready` |

Worker-side `failure_reason` values (not HTTP; stored on the row and returned in `failureReason`):

| failure_reason | Trigger |
|----------------|---------|
| UNPLAYABLE_CODEC | The ffprobe codec gate rejects the file. Not retried *(per phase-03-videos/TD-10)* |
| PROCESSING_FAILED | Every retry attempt of `process-video` is exhausted (ffprobe/ffmpeg/storage error) *(per phase-03-videos/TD-13)* |

### Events/Messages

Queue backend: BullMQ on Redis (`REDIS_HOST`, `REDIS_PORT`) through `@nestjs/bullmq` *(per phase-03-videos/TD-06)*. The API only produces jobs. Processors are registered only in the worker entrypoint (`createApplicationContext`) *(per phase-03-videos/TD-07)*.

#### video-processing → `process-video`

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideosService.completeUpload` (API), right after `CompleteMultipartUpload` succeeds and `status` becomes `processing` *(per phase-03-videos/TD-08)*
**Consumer:** `VideoProcessor` (worker). It runs ffprobe over an **internal** presigned URL, applies the codec gate, extracts one frame at ~10% of the duration (clamped for short videos) with ffmpeg, PUTs the thumbnail to the `thumbnails` bucket, and sets `duration_seconds`, `metadata`, `thumbnail_key` and `status = ready` *(per phase-03-videos/TD-09, TD-10)*
**Trigger:** upload completed by the owner
**Delivery semantics:** at-least-once. `jobId = videoId` makes enqueueing idempotent. `attempts: 3`, `backoff: { type: 'exponential', delay: 1000 }`. A codec-gate rejection throws an unrecoverable error, so it is not retried and goes straight to `failed`. When the attempts run out, the processor's `failed` handler sets `status = failed` and `failure_reason = PROCESSING_FAILED`. The processor is idempotent: re-running it on a `ready` video is a no-op *(per phase-03-videos/TD-06, TD-13)*

#### video-maintenance → `abandoned-upload-cleanup` (Job Scheduler)

**Payload:**

```json
{}
```

**Producer:** `queue.upsertJobScheduler('abandoned-upload-cleanup', { every: 3600000 }, { name: 'abandoned-upload-cleanup' })`, upserted at worker boot (idempotent). BullMQ v6 Job Schedulers, not the removed `repeat` option *(per phase-03-videos/TD-05; library-refs `bullmq`)*
**Consumer:** `UploadCleanupProcessor` (worker). For each `status = uploading` row with `updated_at < now() - 24h`, it calls `AbortMultipartUpload` and deletes the row
**Trigger:** every 1h
**Delivery semantics:** at-least-once. The job is idempotent: an already-aborted `UploadId` (`NoSuchUpload`) is treated as success *(per phase-03-videos/TD-05)*

---

## Dependency Map

```
SI-03.1 (root — Compose, buckets, env)
├── SI-03.2 — depends on SI-03.1 (MinIO + storage env)
├── SI-03.4 — depends on SI-03.1 (Redis + redis env)
└── SI-03.7 — depends on SI-03.1, SI-03.2, SI-03.4 (worker reutiliza storage e fila)
SI-03.3 (root — entidade Video; depende só do Channel da fase 02)

SI-03.5 — depends on SI-03.2, SI-03.3, SI-03.4 (upload precisa de storage, entidade e producer)
└── SI-03.6 — depends on SI-03.5 (controller de upload)
SI-03.8 — depends on SI-03.3, SI-03.7 (processor roda no worker)
SI-03.9 — depends on SI-03.2, SI-03.3, SI-03.7 (limpeza roda no worker)
SI-03.10 — depends on SI-03.2, SI-03.5 (leitura reaproveita findOwnedOrFail e presign)
└── SI-03.11 — depends on SI-03.6, SI-03.8, SI-03.10 (fecha o fluxo upload → processamento → stream/download)
```

Ordem sugerida: SI-03.1 → 03.3 → 03.2 → 03.4 → 03.5 → 03.6 → 03.7 → 03.8 → 03.9 → 03.10 → 03.11.

---

## Deliverables

- [ ] SI-03.1 — Infra: object storage, Redis e contrato de env
- [ ] SI-03.2 — Criar StorageModule (clientes S3 interno e público)
- [ ] SI-03.3 — Criar entidade Video, migration e gerador de public_id
- [ ] SI-03.4 — Configurar fila BullMQ e producer de processamento
- [ ] SI-03.5 — Implementar ciclo de upload no VideosService
- [ ] SI-03.6 — Endpoints de upload (VideosController)
- [ ] SI-03.7 — Infra: entrypoint e container do video worker
- [ ] SI-03.8 — Implementar VideoProcessor (metadados, thumbnail e status)
- [ ] SI-03.9 — Limpeza agendada de uploads abandonados
- [ ] SI-03.10 — Implementar leitura e entrega no VideosService
- [ ] SI-03.11 — Endpoints de detalhe, stream e download

**Full test suites:**

- [ ] Backend tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`docker compose exec nestjs-api npm run lint`)
