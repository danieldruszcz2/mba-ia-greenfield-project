/* Smoke manual — upload de arquivo grande (Fase 03).
 *
 * Prova o requisito "upload de até 10GB sem impacto na performance" fora da suíte:
 * envia um arquivo grande em partes de 64 MiB direto ao MinIO, espera o worker
 * processar e confere detalhe, stream (Range/206) e download (attachment).
 *
 * Roda DENTRO do container nestjs-api, contra o build em dist/ (rode `npm run build` antes).
 * A API sobe in-process; o processamento fica com o container video-worker.
 *
 *   docker compose exec -e SMOKE_FILE=/tmp/smoke-10g.mp4 nestjs-api node scripts/smoke-large-upload.js
 *
 * Passo a passo completo em docs/phases/phase-03-videos/roteiro-testes-manuais.md (seção 7).
 * Ao final remove o vídeo, a thumbnail e o usuário criados pelo smoke.
 */
const APP = '/home/node/app';
require(`${APP}/node_modules/dotenv`).config({ path: `${APP}/.env` });
// Dentro do container o endpoint público (localhost:9000) não alcança o MinIO.
process.env.S3_PUBLIC_ENDPOINT = process.env.S3_ENDPOINT;

const fs = require('node:fs');
const { NestFactory } = require(`${APP}/node_modules/@nestjs/core`);
const { ValidationPipe } = require(`${APP}/node_modules/@nestjs/common`);
const { DataSource } = require(`${APP}/node_modules/typeorm`);
const { AppModule } = require(`${APP}/dist/app.module`);
const { DomainExceptionFilter } = require(`${APP}/dist/common/filters/domain-exception.filter`);
const { ValidationExceptionFilter } = require(`${APP}/dist/common/filters/validation-exception.filter`);

const FILE = process.env.SMOKE_FILE ?? '/tmp/smoke-large.mp4';
const CONCURRENCY = 4;
const PROCESSING_TIMEOUT_MS = 15 * 60 * 1000;
const mb = (n) => Math.round(n / 1024 / 1024);

async function main() {
  const size = fs.statSync(FILE).size;
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new DomainExceptionFilter(), new ValidationExceptionFilter());
  await app.listen(0);
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  const ds = app.get(DataSource);

  let apiBytesSent = 0;
  const api = async (method, path, token, body) => {
    const payload = body ? JSON.stringify(body) : undefined;
    apiBytesSent += payload ? Buffer.byteLength(payload) : 0;
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: payload,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  // Usuário dedicado do smoke (confirmado via SQL para pular o e-mail).
  const email = `smoke+${Date.now()}@example.com`;
  const password = 'password123';
  await api('POST', '/auth/register', null, { email, password });
  await ds.query('UPDATE "users" SET "is_confirmed" = true WHERE "email" = $1', [email]);
  const login = await api('POST', '/auth/login', null, { email, password });
  const token = login.body.access_token;

  const rssBefore = process.memoryUsage().rss;
  const t0 = Date.now();
  const init = await api('POST', '/videos', token, {
    title: `Smoke ${(size / 1e9).toFixed(2)}GB`, filename: FILE.split('/').pop(), contentType: 'video/mp4', sizeBytes: size,
  });
  if (init.status !== 201) throw new Error(`initiate ${init.status} ${JSON.stringify(init.body)}`);
  const { id, partSizeBytes, partCount } = init.body;

  // Assina todas as partes (lotes de até 100) e envia direto ao MinIO, 4 em paralelo.
  const urls = new Map();
  for (let start = 1; start <= partCount; start += 100) {
    const partNumbers = [];
    for (let n = start; n < Math.min(start + 100, partCount + 1); n++) partNumbers.push(n);
    const signed = await api('POST', `/videos/${id}/upload/part-urls`, token, { partNumbers });
    for (const p of signed.body.parts) urls.set(p.partNumber, p.url);
  }
  const fd = fs.openSync(FILE, 'r');
  const etags = new Array(partCount);
  let storageBytesSent = 0;
  let next = 1;
  let peakRss = rssBefore;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const n = next++;
      if (n > partCount) return;
      const offset = (n - 1) * partSizeBytes;
      const length = Math.min(partSizeBytes, size - offset);
      const buf = Buffer.allocUnsafe(length);
      fs.readSync(fd, buf, 0, length, offset);
      const res = await fetch(urls.get(n), { method: 'PUT', body: buf });
      if (res.status !== 200) throw new Error(`part ${n} -> ${res.status}`);
      etags[n - 1] = res.headers.get('etag');
      storageBytesSent += length;
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }
  });
  await Promise.all(workers);
  fs.closeSync(fd);
  const listed = await api('GET', `/videos/${id}/upload/parts`, token);
  const complete = await api('POST', `/videos/${id}/upload/complete`, token, {
    parts: etags.map((etag, i) => ({ partNumber: i + 1, etag })),
  });
  const uploadMs = Date.now() - t0;
  if (complete.status !== 202) throw new Error(`complete ${complete.status} ${JSON.stringify(complete.body)}`);

  // Espera o worker (container video-worker) pelo banco.
  const t1 = Date.now();
  let row;
  for (;;) {
    [row] = await ds.query('SELECT "id", "status", "failure_reason", "duration_seconds", "thumbnail_key" FROM "videos" WHERE "public_id" = $1', [id]);
    if (row.status === 'ready' || row.status === 'failed') break;
    if (Date.now() - t1 > PROCESSING_TIMEOUT_MS) throw new Error(`still ${row.status}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  const processingMs = Date.now() - t1;

  const detail = await api('GET', `/videos/${id}`, token);
  const stream = await api('GET', `/videos/${id}/stream`, token);
  const head = await fetch(stream.body.url, { headers: { Range: 'bytes=0-1023' } });
  const tailStart = size - 1024 * 1024;
  const tail = await fetch(stream.body.url, { headers: { Range: `bytes=${tailStart}-` } });
  const download = await api('GET', `/videos/${id}/download`, token);
  const dl = await fetch(download.body.url, { headers: { Range: 'bytes=0-0' } });
  const thumb = detail.body.thumbnailUrl ? await fetch(detail.body.thumbnailUrl) : null;

  const summary = {
    file: { bytes: size, gib: +(size / 1024 ** 3).toFixed(2) },
    upload: {
      publicId: id, partSizeMiB: mb(partSizeBytes), partCount, partsListedBeforeComplete: listed.body.parts.length,
      seconds: +(uploadMs / 1000).toFixed(1), throughputMiBps: +(mb(size) / (uploadMs / 1000)).toFixed(1),
      bytesSentToApi: apiBytesSent, bytesSentToStorage: storageBytesSent,
      scriptRssMiB: { before: mb(rssBefore), peak: mb(peakRss) },
    },
    completeStatus: complete.status,
    processing: { seconds: +(processingMs / 1000).toFixed(1), status: row.status, failureReason: row.failure_reason },
    detail: {
      status: detail.body.status, durationSeconds: detail.body.durationSeconds,
      metadata: detail.body.metadata, thumbnailHttp: thumb && thumb.status,
    },
    stream: {
      head: { status: head.status, bytes: (await head.arrayBuffer()).byteLength, contentRange: head.headers.get('content-range') },
      tail: { status: tail.status, bytes: (await tail.arrayBuffer()).byteLength, contentRange: tail.headers.get('content-range') },
    },
    download: { status: dl.status, contentDisposition: dl.headers.get('content-disposition') },
  };
  console.log(JSON.stringify(summary, null, 2));

  // Limpeza: objetos, linha do vídeo e usuário do smoke.
  const { S3Client, DeleteObjectCommand } = require(`${APP}/node_modules/@aws-sdk/client-s3`);
  const s3 = new S3Client({
    endpoint: process.env.S3_ENDPOINT, region: process.env.S3_REGION, forcePathStyle: true,
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY, secretAccessKey: process.env.S3_SECRET_KEY },
  });
  await s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET_VIDEOS, Key: `${row.id}/original` }));
  if (row.thumbnail_key) {
    await s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET_THUMBNAILS, Key: row.thumbnail_key }));
  }
  await ds.query('DELETE FROM "refresh_tokens" WHERE "user_id" IN (SELECT "id" FROM "users" WHERE "email" = $1)', [email]);
  await ds.query('DELETE FROM "verification_tokens" WHERE "user_id" IN (SELECT "id" FROM "users" WHERE "email" = $1)', [email]);
  await ds.query('DELETE FROM "channels" WHERE "user_id" IN (SELECT "id" FROM "users" WHERE "email" = $1)', [email]);
  await ds.query('DELETE FROM "users" WHERE "email" = $1', [email]);
  await app.close();
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
