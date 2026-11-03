export const PUBLIC_ID_MAX_ATTEMPTS = 3;

export const VIDEO_UPLOAD_LIMITS = {
  /** 10 GiB */
  MAX_SIZE_BYTES: 10 * 1024 * 1024 * 1024,
  /** 64 MiB, dictated by the server (S3 allows at most 10,000 parts). */
  PART_SIZE_BYTES: 64 * 1024 * 1024,
  /** Upper bound of part URLs signed per request. */
  MAX_PART_URLS_PER_REQUEST: 100,
} as const;

/** An `uploading` draft untouched for longer than this is treated as abandoned. */
export const ABANDONED_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

export const ALLOWED_VIDEO_CONTENT_TYPES = ['video/mp4', 'video/webm'] as const;

/** S3 error names returned by CompleteMultipartUpload for a bad part list. */
export const S3_INVALID_PARTS_ERROR_NAMES = [
  'InvalidPart',
  'InvalidPartOrder',
  'EntityTooSmall',
] as const;

export const videoStorageKey = (videoId: string): string =>
  `${videoId}/original`;
