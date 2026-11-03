# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 9/11 completed

### SI-03.1 — Infra: object storage, Redis e contrato de env
- **Status:** completed
- **Tests:** 15 passing
- **Observations:**
  - A imagem Chainguard do MinIO não tem shell, então não dá para ter healthcheck nela. O `minio-init` espera o MinIO com `mc ready` e o `nestjs-api` depende de `minio-init: service_completed_successfully`. Na prática, "MinIO pronto" equivale ao init terminar com exit code 0.
  - O `minio-init` usa `cgr.dev/chainguard/minio-client:latest-dev`, pinado por digest, porque a variante sem `-dev` também não tem shell para rodar os vários comandos `mc`.
  - O override de `S3_PUBLIC_ENDPOINT` nos testes fica em `test/setup-test-env.ts`, ligado no `setupFiles` dos dois configs do Jest. Ele usa `S3_ENDPOINT` (`http://minio:9000`), a não ser que `S3_TEST_PUBLIC_ENDPOINT` esteja definido.
  - Credenciais locais do MinIO em `.env`/`.env.example`: `S3_ACCESS_KEY=streamtube` e `S3_SECRET_KEY=streamtube-secret`. O Compose usa as mesmas como `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`.

### SI-03.2 — Criar StorageModule (clientes S3 interno e público)
- **Status:** completed
- **Tests:** 8 passing
- **Observations:**
  - Os dois `S3Client` são providers com tokens `Symbol` (`STORAGE_CLIENTS.INTERNAL` / `PUBLIC`), em vez de `new` dentro do service. Assim a DI e o teste conseguem acessar o cliente interno.
  - No ambiente de testes, `S3_PUBLIC_ENDPOINT` e `S3_ENDPOINT` apontam para o mesmo host (`minio:9000`, via `test/setup-test-env.ts`). Por isso o AC "host público vs interno" só confirma que cada cliente usa a sua variável. A diferença real de host só aparece em dev.
  - O download manda `Content-Disposition` com `filename="..."` (ASCII) e também `filename*=UTF-8''...`, para nomes com acento.

### SI-03.3 — Criar entidade Video, migration e gerador de public_id
- **Status:** completed
- **Tests:** 75 passing (3 suítes novas + 11 suítes existentes afetadas, 2 rodadas seguidas sem flakiness)
- **Observations:**
  - A regra de entidades pede os dois lados da relação, então entrou `Channel.videos` (`@OneToMany`). Por isso `Video` foi adicionado aos `ALL_ENTITIES` das 10 suítes que carregam `Channel`. Sem ele, o TypeORM falha na metadata.
  - O `VideosModule` foi criado já nesta SI, só com `forFeature([Video])` + `VideosRepository` e registrado no `AppModule`, para o app continuar subindo (o `Channel` referencia `Video`). A SI-03.6 completa o módulo.
  - `migrations.integration-spec.ts`: entrou `CreateVideos`. Os `DROP TABLE` do setup passaram a ser sequenciais, porque em paralelo davam deadlock com a FK `videos → channels`. O setup também passou a dropar os enums `verification_tokens_type_enum` e `video_status`, que sobram das suítes com `synchronize: true`.
  - O banco local de dev não tem nenhuma linha na tabela `migrations`, porque o schema veio do `synchronize` dos testes. Por isso o `npm run migration:run` falha com "relation already exists". Isso é anterior a esta fase. Para usar as migrations em dev é preciso recriar o banco.
  - `size_bytes` (bigint) e `duration_seconds` (numeric) usam um transformer para voltar como `number`, porque o `pg` devolve esses tipos como string.
  - Rodar o prettier por diretório reescreveu arquivos não tocados só no line ending (`core.autocrlf=true`), sem diff de conteúdo. A partir daqui, o prettier roda só nos arquivos editados.

### SI-03.4 — Configurar fila BullMQ e producer de processamento
- **Status:** completed
- **Tests:** 5 passing (+ 7 e2e de smoke do AppModule passando, sem open handles)
- **Observations:**
  - No BullMQ v6, `ioredis` virou peer dependency opcional e precisa ser instalado explicitamente. Sem ele o `new Queue` quebra com "could not load the optional 'ioredis' package". Foi instalado `ioredis@^5.11.1`. Essa mudança não aparecia na doc da v6 consultada no Context7.
  - O `QueueModule` exporta `BullModule` (as filas) e `VideoProcessingProducer`, para o worker da SI-03.7 reaproveitar as mesmas filas.
  - O `AppModule` agora depende do Redis para subir, então as suítes e2e precisam do `redis` do Compose rodando.

### SI-03.5 — Implementar ciclo de upload no VideosService
- **Status:** completed
- **Tests:** 21 passing (+ e2e de smoke do AppModule passando)
- **Observations:**
  - O canal do usuário vem de um novo `ChannelsService.findByUserId`, para o `VideosService` não ler a entidade de outro domínio direto. O `VideosModule` importa `ChannelsModule`.
  - O `id` (uuid) do vídeo é gerado na aplicação antes do insert, porque a `storage_key` (`{id}/original`) é necessária para abrir o multipart. Se o insert falhar, o multipart é abortado (compensação).
  - Um `partNumbers` fora de `1..partCount` lança `INVALID_UPLOAD_PARTS` (400), reaproveitando o código do catálogo. O contrato fala genericamente em "400 validation error" para esse caso.
  - A lista de nomes de erro do S3 mapeados para `INVALID_UPLOAD_PARTS` inclui `EntityTooSmall`, além de `InvalidPart`/`InvalidPartOrder`. Ele aparece quando uma parte intermediária tem menos de 5 MiB.
  - Aparece o aviso de deprecação do pg "client.query() when the client is already executing a query" nas suítes de integração. Ele já existia antes e vem do TypeORM/pg, sem falha associada.

### SI-03.6 — Endpoints de upload (VideosController)
- **Status:** completed
- **Tests:** 9 passing (1 de compilação do módulo + 8 e2e do spec `videos-upload.plan.md`)
- **Observations:**
  - Os DTOs de request seguem `.claude/rules/nestjs-dtos.md`: só `class-validator` + JSDoc, sem `@ApiProperty`. Os DTOs de resposta têm `@ApiProperty`. Como o `openapi:export` roda com ts-node (sem o plugin do Swagger), os schemas de request saem sem propriedades no `openapi.json`, o mesmo comportamento dos DTOs de auth que já existiam.
  - `sizeBytes` e `contentType` não têm limite/allowlist no DTO, de propósito. Assim os erros de domínio `VIDEO_TOO_LARGE` e `UNSUPPORTED_VIDEO_TYPE` (do contrato) aparecem, em vez de um 400 genérico de validação.
  - O cenário 1.5 (`abort-upload-removes-draft`) verifica o `GET /videos/:id` → `404` só pelo status. A rota de detalhe só existe na SI-03.11, então por enquanto o 404 é de rota inexistente. A SI-03.11 cobre o `VIDEO_NOT_FOUND` no detalhe.
  - Os helpers de e2e (`test/helpers/videos-e2e.helpers.ts`: app com pipes/filters do `main.ts`, registro+confirmação+login, PUT direto no storage) ficam compartilhados com o e2e da SI-03.11.
  - O `openapi.json` foi regenerado com as 5 rotas de upload.

### SI-03.7 — Infra: entrypoint e container do video worker
- **Status:** completed
- **Tests:** 22 passing (worker.module + suítes afetadas pelo refactor) + 9 e2e (upload + app) com cache frio do Jest; tsc e eslint limpos
- **Observations:**
  - A config do `ConfigModule` e a do TypeORM foram extraídas para `src/config/config-module.options.ts` e `src/database/typeorm-options.factory.ts`, usadas pelo `AppModule` e pelo `WorkerModule`. Assim a mesma config não fica duplicada nos dois.
  - O `WorkerModule` importa `UsersModule` só para a metadata da entidade `User`, já que o `Video` chega nela pelo `Channel`. O `VideosModule` passou a exportar o `VideosRepository` para os processors das SI-03.8/03.9.
  - Novo `QUEUE_PREFIX` (default `bull`), e os testes usam `bull-test` via `test/setup-test-env.ts`. Sem isso, o container `video-worker` consumiria os jobs criados pelos testes assim que o processor existir.
  - No compose, o worker roda `node --watch-path=src` + ts-node direto, sem `npm run`. Pelo npm, o container saía com exit 1 no SIGTERM. Também ganhou `TS_NODE_TRANSPILE_ONLY=true`: o boot caiu de ~90 s para ~35 s (o type-check continua com `tsc --noEmit`). O shutdown leva ~2 s e sai com exit 0.
  - O primeiro e2e depois do rebuild da imagem falhou com o cache frio do ts-jest. O `beforeAll` passou dos 5 s e a conexão Redis deu `ETIMEDOUT`. Como o `afterAll` quebrava antes do `app.close()`, o Jest ficou preso nos open handles. Correção: `E2E_SETUP_TIMEOUT_MS = 60s` nos hooks e teardown protegido. Validado com `jest --clearCache`.
  - Ambiente: o disco `C:` encheu durante o rebuild e o Docker Desktop travou com erro de I/O. O usuário migrou o disco do Docker para outro HD. O CLI do Docker agora fica em `AppData/Local/Programs/DockerDesktop/resources/bin`, que não está no PATH deste shell.
  - O prettier converteu as aspas do `compose.yaml` inteiro. A mudança foi revertida e só o bloco `video-worker` foi reaplicado, para não misturar mudança cosmética com a funcional.

### SI-03.8 — Implementar VideoProcessor (metadados, thumbnail e status)
- **Status:** completed
- **Tests:** 24 passing (unit do codec gate + integração com ffprobe/ffmpeg reais + processor com DB/MinIO/Redis); tsc e eslint limpos
- **Observations:**
  - As fixtures `test/fixtures/sample.mp4` (h264/aac, 5 s, 72 KB) e `unplayable.avi` (mpeg4, 33 KB) foram geradas com o ffmpeg do container (`testsrc` + `sine`).
  - O handler de falha usa `@OnWorkerEvent('failed')` do `@nestjs/bullmq`, equivalente ao `worker.on('failed')` em `onApplicationBootstrap` que o plano cita. Ele só marca `failed` na última tentativa (`attemptsMade >= attempts`) ou quando o erro é `UnrecoverableError` (codec). Nas tentativas intermediárias, não faz nada.
  - O container vem do `format_name` do ffprobe (`mov,mp4,...` → `mp4`, `matroska,webm` → `webm`). Áudio ausente é aceito pelo gate.
  - Um vídeo apagado entre o enqueue e o processamento (ex.: abort) gera só um warning, e o job termina sem erro.
  - O critério de aceite "lê por HTTP Range, sem baixar o arquivo inteiro" não tem teste próprio. Ele vem da forma de entrada: o ffprobe/ffmpeg recebe a URL assinada, sem cópia local.
  - `VideosRepository.findById` foi adicionado para o worker.

### SI-03.9 — Limpeza agendada de uploads abandonados
- **Status:** completed
- **Tests:** 13 passing (7 da limpeza + 6 das suítes do worker afetadas pelo novo registro); tsc e eslint limpos
- **Observations:**
  - O `upsertJobScheduler` está num provider separado, `UploadCleanupScheduler` (`OnApplicationBootstrap`), e não dentro do processor. Assim ele roda só no worker e o teste consegue chamá-lo direto.
  - O teste da limpeza usa `compile()` sem `init()`: os workers do BullMQ ficam parados e o teste chama `process()` e o scheduler direto. Isso evita corrida com o job que o scheduler dispara no boot.
  - Para envelhecer a linha, o `updated_at` é ajustado com SQL cru (`now() - make_interval(...)`), porque o `@UpdateDateColumn` sobrescreveria o valor em qualquer `save`/`update`.
  - Se um abort falhar no meio, o erro propaga: o job falha e o lote é refeito na próxima hora. Como o abort é idempotente, refazer é seguro.

### SI-03.10 — Implementar leitura e entrega no VideosService
- **Status:** pending
- **Tests:** 
- **Observations:** 

### SI-03.11 — Endpoints de detalhe, stream e download
- **Status:** pending
- **Tests:** 
- **Observations:** 
