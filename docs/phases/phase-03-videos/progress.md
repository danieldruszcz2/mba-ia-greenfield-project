# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 1/11 completed

### SI-03.1 — Infra: object storage, Redis e contrato de env
- **Status:** completed
- **Tests:** 15 passing
- **Observations:**
  - A imagem Chainguard do MinIO não tem shell, então não dá para ter healthcheck nela. O `minio-init` espera o MinIO com `mc ready` e o `nestjs-api` depende de `minio-init: service_completed_successfully`. Na prática, "MinIO pronto" equivale ao init terminar com exit code 0.
  - O `minio-init` usa `cgr.dev/chainguard/minio-client:latest-dev`, pinado por digest, porque a variante sem `-dev` também não tem shell para rodar os vários comandos `mc`.
  - O override de `S3_PUBLIC_ENDPOINT` nos testes fica em `test/setup-test-env.ts`, ligado no `setupFiles` dos dois configs do Jest. Ele usa `S3_ENDPOINT` (`http://minio:9000`), a não ser que `S3_TEST_PUBLIC_ENDPOINT` esteja definido.
  - Credenciais locais do MinIO em `.env`/`.env.example`: `S3_ACCESS_KEY=streamtube` e `S3_SECRET_KEY=streamtube-secret`. O Compose usa as mesmas como `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`.

### SI-03.2 — Criar StorageModule (clientes S3 interno e público)
- **Status:** pending
- **Tests:** 
- **Observations:** 

### SI-03.3 — Criar entidade Video, migration e gerador de public_id
- **Status:** pending
- **Tests:** 
- **Observations:** 

### SI-03.4 — Configurar fila BullMQ e producer de processamento
- **Status:** pending
- **Tests:** 
- **Observations:** 

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
