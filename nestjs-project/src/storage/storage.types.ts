export type StorageClientKind = 'internal' | 'public';

export interface PresignedPartUrl {
  partNumber: number;
  url: string;
}

export interface PresignedPartUrls {
  parts: PresignedPartUrl[];
  expiresAt: Date;
}

export interface UploadedPart {
  partNumber: number;
  etag: string;
  sizeBytes: number;
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export interface PresignedUrl {
  url: string;
  expiresAt: Date;
}

export interface PresignGetObjectOptions {
  client: StorageClientKind;
  expiresIn?: number;
  /** When set, the URL forces a download (`Content-Disposition: attachment`). */
  downloadFilename?: string;
}
