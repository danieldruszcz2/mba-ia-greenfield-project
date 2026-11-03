# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 4/11 completed

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
- **Status:** pending
- **Tests:** 
- **Observations:** 

### SI-03.6 — Endpoints de upload (VideosController)
- **Status:** pending
- **Tests:** 
- **Observations:** 

### SI-03.7 — Infra: entrypoint e container do video worker
- **Status:** pending
- **Tests:** 
- **Observations:** 

### SI-03.8 — Implementar VideoProcessor (metadados, thumbnail e status)
- **Status:** pending
- **Tests:** 
- **Observations:** 

### SI-03.9 — Limpeza agendada de uploads abandonados
- **Status:** pending
- **Tests:** 
- **Observations:** 

### SI-03.10 — Implementar leitura e entrega no VideosService
- **Status:** pending
- **Tests:** 
- **Observations:** 

### SI-03.11 — Endpoints de detalhe, stream e download
- **Status:** pending
- **Tests:** 
- **Observations:** 
