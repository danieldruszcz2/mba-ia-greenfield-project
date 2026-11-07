import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import {
  S3_ERROR_NAMES,
  STORAGE_CLIENTS,
  STORAGE_DEFAULTS,
} from './storage.constants';
import type {
  CompletedPart,
  PresignGetObjectOptions,
  PresignedPartUrls,
  PresignedUrl,
  UploadedPart,
} from './storage.types';

@Injectable()
export class StorageService {
  constructor(
    @Inject(STORAGE_CLIENTS.INTERNAL) private readonly internalClient: S3Client,
    @Inject(STORAGE_CLIENTS.PUBLIC) private readonly publicClient: S3Client,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  get videosBucket(): string {
    return this.config.buckets.videos;
  }

  get thumbnailsBucket(): string {
    return this.config.buckets.thumbnails;
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const output = await this.internalClient.send(
      new CreateMultipartUploadCommand({
        Bucket: this.videosBucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!output.UploadId) {
      throw new Error(`Storage returned no UploadId for key "${key}"`);
    }
    return output.UploadId;
  }

  async presignUploadParts(
    key: string,
    uploadId: string,
    partNumbers: number[],
    expiresIn: number = STORAGE_DEFAULTS.PRESIGN_EXPIRES_IN_SECONDS,
  ): Promise<PresignedPartUrls> {
    const expiresAt = this.expiresAt(expiresIn);
    const parts = await Promise.all(
      partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await getSignedUrl(
          this.publicClient,
          new UploadPartCommand({
            Bucket: this.videosBucket,
            Key: key,
            UploadId: uploadId,
            PartNumber: partNumber,
          }),
          { expiresIn },
        ),
      })),
    );
    return { parts, expiresAt };
  }

  async listParts(key: string, uploadId: string): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = [];
    let marker: string | undefined;
    do {
      const output = await this.internalClient.send(
        new ListPartsCommand({
          Bucket: this.videosBucket,
          Key: key,
          UploadId: uploadId,
          PartNumberMarker: marker,
        }),
      );
      for (const part of output.Parts ?? []) {
        parts.push({
          partNumber: part.PartNumber ?? 0,
          etag: part.ETag ?? '',
          sizeBytes: part.Size ?? 0,
        });
      }
      marker = output.IsTruncated ? output.NextPartNumberMarker : undefined;
    } while (marker);
    return parts;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    await this.internalClient.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.videosBucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((part) => ({
            PartNumber: part.partNumber,
            ETag: part.etag,
          })),
        },
      }),
    );
  }

  /** Idempotent: an already-aborted (or unknown) upload counts as success. */
  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.internalClient.send(
        new AbortMultipartUploadCommand({
          Bucket: this.videosBucket,
          Key: key,
          UploadId: uploadId,
        }),
      );
    } catch (error) {
      if ((error as Error).name === S3_ERROR_NAMES.NO_SUCH_UPLOAD) {
        return;
      }
      throw error;
    }
  }

  async presignGetObject(
    key: string,
    options: PresignGetObjectOptions,
  ): Promise<PresignedUrl> {
    const expiresIn =
      options.expiresIn ?? STORAGE_DEFAULTS.PRESIGN_EXPIRES_IN_SECONDS;
    const client =
      options.client === 'public' ? this.publicClient : this.internalClient;
    const url = await getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: this.videosBucket,
        Key: key,
        ResponseContentDisposition: options.downloadFilename
          ? contentDispositionAttachment(options.downloadFilename)
          : undefined,
      }),
      { expiresIn },
    );
    return { url, expiresAt: this.expiresAt(expiresIn) };
  }

  async putObject(
    bucket: string,
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.internalClient.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  buildPublicThumbnailUrl(key: string): string {
    const base = this.config.publicEndpoint.replace(/\/+$/, '');
    return `${base}/${this.thumbnailsBucket}/${encodeURI(key)}`;
  }

  private expiresAt(expiresInSeconds: number): Date {
    return new Date(Date.now() + expiresInSeconds * 1000);
  }
}

function contentDispositionAttachment(filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
