// Loaded by Jest right after `dotenv/config`.
// Tests always run inside the `nestjs-api` container, where the host-facing
// `S3_PUBLIC_ENDPOINT` (e.g. http://localhost:9000) does not reach MinIO.
// Presigned URLs embed the signing host, so tests must sign with an endpoint
// reachable from inside the Docker network.
process.env.S3_PUBLIC_ENDPOINT =
  process.env.S3_TEST_PUBLIC_ENDPOINT ?? process.env.S3_ENDPOINT;
