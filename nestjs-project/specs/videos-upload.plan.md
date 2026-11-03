---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.6
target_file: nestjs-project/test/videos-upload.e2e-spec.ts
---

# Video Upload Endpoints Test Plan

## Application Overview

O dono do canal inicia o upload de um vídeo e recebe um rascunho `uploading`. Depois pede URLs pré-assinadas por parte, envia os bytes direto ao MinIO, consulta as partes já enviadas para retomar, conclui o upload (o vídeo vai para `processing` e o job entra na fila) ou aborta. O arquivo nunca passa pela API, só JSON pequeno. Todas as rotas exigem JWT. As rotas com `:id` (public_id de 11 caracteres) só respondem ao dono.

## Test Scenarios

### 1. Upload lifecycle — POST /videos, part-urls, parts, complete, abort

**Setup:** `beforeEach` limpa `videos`, `channels` e `users` (`DELETE FROM`) e esvazia as filas BullMQ. Em `beforeAll`, sobe o `AppModule` via `Test.createTestingModule(...).compile()` com os mesmos global pipes e filters do `main.ts`. Registra e confirma dois usuários (dono e outro) e guarda os access tokens. O MinIO e o Redis são os reais do Compose, e `S3_PUBLIC_ENDPOINT=http://minio:9000` no ambiente de teste. Em `afterAll`, chama `app.close()`.

#### 1.1. initiate-upload-creates-draft

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-03T13:08:42Z

**Steps:**
  1. POST /videos com token do dono e body `{ title: "Meu vídeo", filename: "clip.mp4", contentType: "video/mp4", sizeBytes: 104857600 }`
    - expect: status `201`
    - expect: body `{ id, status: "uploading", partSizeBytes: 67108864, partCount: 2 }`
    - expect: `id` casa `/^[A-Za-z0-9_-]{11}$/`
    - expect: a linha em `videos` com esse `public_id` tem `status = 'uploading'`, `upload_id` não nulo e `channel_id` do canal do dono

#### 1.2. part-urls-accept-direct-put

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-03T13:08:42Z

**Steps:**
  1. POST /videos com token do dono (`sizeBytes` de 2 partes) e guardar `id`
    - expect: status `201`
  2. POST /videos/:id/upload/part-urls com body `{ partNumbers: [1, 2] }`
    - expect: status `200`
    - expect: `parts` tem 2 itens `{ partNumber, url }` e `expiresAt` é ISO-8601 no futuro
  3. PUT direto em cada `url`, com os bytes da parte (fora da API, via HTTP client)
    - expect: o storage responde `200` com header `ETag`

#### 1.3. list-parts-for-resume

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-03T13:08:42Z

**Steps:**
  1. Criar o upload, pedir a URL da parte 1 e fazer PUT só dessa parte
    - expect: PUT `200` com `ETag`
  2. GET /videos/:id/upload/parts com token do dono
    - expect: status `200`
    - expect: `parts` tem exatamente 1 item com `partNumber: 1`, `etag` igual ao ETag do PUT e `sizeBytes` > 0

#### 1.4. complete-upload-moves-to-processing

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-03T13:08:42Z

**Steps:**
  1. Criar o upload, fazer PUT de todas as partes e guardar os ETags
    - expect: todos os PUTs `200`
  2. POST /videos/:id/upload/complete com body `{ parts: [{ partNumber: 1, etag }, { partNumber: 2, etag }] }`
    - expect: status `202` com body `{ id, status: "processing" }`
    - expect: a linha em `videos` tem `status = 'processing'` e `upload_id = null`
    - expect: a fila `video-processing` tem um job `process-video` com `id` igual ao uuid interno do vídeo

#### 1.5. abort-upload-removes-draft

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-03T13:08:42Z

**Steps:**
  1. Criar o upload e guardar `id`
    - expect: status `201`
  2. DELETE /videos/:id/upload com token do dono
    - expect: status `204`
  3. GET /videos/:id com token do dono
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`
    - expect: `ListMultipartUploads` do bucket `videos` não contém o `UploadId` do vídeo

#### 1.6. auth-and-ownership-enforced

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-03T13:08:42Z

**Steps:**
  1. POST /videos sem header `Authorization`
    - expect: status `401`
  2. Com um upload do dono criado, chamar POST part-urls, GET parts, POST complete e DELETE upload com token do **outro** usuário
    - expect: as 4 respostas são `404` com `error: "VIDEO_NOT_FOUND"`
    - expect: a linha do vídeo continua `uploading`, sem alteração

#### 1.7. initiate-upload-rejects-invalid-input

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-11-03T13:08:42Z

**Steps:**
  1. POST /videos com `sizeBytes: 10737418241`
    - expect: status `400` com `error: "VIDEO_TOO_LARGE"`
  2. POST /videos com `contentType: "video/avi"`
    - expect: status `400` com `error: "UNSUPPORTED_VIDEO_TYPE"`
  3. POST /videos sem `title`
    - expect: status `400` (erro de validação)
    - expect: nenhuma linha em `videos` foi criada pelos 3 requests

#### 1.8. upload-routes-in-openapi

**Covers AC:** #8
**Source:** auto
**Last sync:** 2026-11-03T13:08:42Z

**Steps:**
  1. Carregar o `openapi.json` exportado (o mesmo artefato do script de export)
    - expect: `paths` contém `/videos` (post), `/videos/{id}/upload/part-urls` (post), `/videos/{id}/upload/parts` (get), `/videos/{id}/upload/complete` (post) e `/videos/{id}/upload` (delete)
