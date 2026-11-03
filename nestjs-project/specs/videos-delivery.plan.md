---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.11
target_file: nestjs-project/test/videos-delivery.e2e-spec.ts
---

# Video Detail, Stream and Download Endpoints Test Plan

## Application Overview

Depois que o upload termina e o worker processa o vídeo, o dono consulta o detalhe (status, duração, metadados, thumbnail) e pede URLs assinadas de curta duração para streaming e download. O MinIO responde `Range` com `206`, e o download vem com `Content-Disposition: attachment`. Os bytes nunca passam pela API. Só o dono acessa, e só vídeos `ready` geram URL.

## Test Scenarios

### 1. Detail and delivery — GET /videos/:id, /stream, /download

**Setup:** `beforeEach` limpa `videos`, `channels` e `users` (`DELETE FROM`) e esvazia as filas BullMQ. Em `beforeAll`, sobe o `AppModule` via `Test.createTestingModule(...).compile()` com os mesmos global pipes e filters do `main.ts`, e também `NestFactory.createApplicationContext(WorkerModule)` no mesmo processo, para os jobs `process-video` serem consumidos. Registra e confirma dois usuários (dono e outro). Um helper `uploadAndProcess(token, 'test/fixtures/sample.mp4')` faz o fluxo completo de upload (POST /videos → part-urls → PUT → complete) e espera via polling `GET /videos/:id` até `status: "ready"` (timeout de 30s). O MinIO e o Redis são os reais do Compose, e `S3_PUBLIC_ENDPOINT=http://minio:9000`. Em `afterAll`, fecha os dois contextos.

#### 1.1. detail-of-processed-video

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-03T13:08:42Z

**Steps:**
  1. `uploadAndProcess` com token do dono e guardar `id`
    - expect: o polling chega em `status: "ready"`
  2. GET /videos/:id com token do dono
    - expect: status `200`
    - expect: body com `status: "ready"`, `durationSeconds` > 0, `metadata.videoCodec: "h264"` e `thumbnailUrl` não nulo
  3. GET anônimo em `thumbnailUrl`
    - expect: status `200` com `Content-Type: image/jpeg`

#### 1.2. stream-url-serves-partial-content

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-03T13:08:42Z

**Steps:**
  1. Com um vídeo `ready` do dono, GET /videos/:id/stream
    - expect: status `200` com `{ url, expiresAt }`, e `expiresAt` no futuro
  2. GET na `url` com header `Range: bytes=0-1023`
    - expect: status `206` com corpo de 1024 bytes e header `Content-Range: bytes 0-1023/*`

#### 1.3. download-url-is-attachment

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-03T13:08:42Z

**Steps:**
  1. Com um vídeo `ready` do dono (`filename: "sample.mp4"`), GET /videos/:id/download
    - expect: status `200` com `{ url, expiresAt }`
  2. GET na `url`
    - expect: status `200` com header `Content-Disposition` contendo `attachment` e `filename="sample.mp4"`

#### 1.4. stream-of-processing-video-not-ready

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-03T13:08:42Z

**Steps:**
  1. Fazer o upload completo de um vídeo, sem esperar o processamento (contexto do worker pausado: `worker.pause()` antes do complete)
    - expect: POST complete `202` e `status: "processing"`
  2. GET /videos/:id/stream com token do dono
    - expect: status `409` com `error: "VIDEO_NOT_READY"`

#### 1.5. delivery-auth-and-ownership

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-03T13:08:42Z

**Steps:**
  1. Com um vídeo `ready` do dono, chamar GET /videos/:id, /stream e /download sem header `Authorization`
    - expect: as 3 respostas são `401`
  2. Chamar as mesmas 3 rotas com token do **outro** usuário
    - expect: as 3 respostas são `404` com `error: "VIDEO_NOT_FOUND"`

#### 1.6. delivery-routes-in-openapi

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-03T13:08:42Z

**Steps:**
  1. Carregar o `openapi.json` exportado
    - expect: `paths` contém `/videos/{id}` (get), `/videos/{id}/stream` (get) e `/videos/{id}/download` (get), com response `200` documentada
