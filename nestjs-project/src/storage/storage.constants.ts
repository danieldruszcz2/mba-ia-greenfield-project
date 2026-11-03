export const STORAGE_CLIENTS = {
  /** Server-to-server calls (and URLs consumed) inside the Docker network. */
  INTERNAL: Symbol('STORAGE_INTERNAL_CLIENT'),
  /** Used only to sign URLs handed to callers outside the Docker network. */
  PUBLIC: Symbol('STORAGE_PUBLIC_CLIENT'),
} as const;

export const STORAGE_DEFAULTS = {
  PRESIGN_EXPIRES_IN_SECONDS: 900,
} as const;

export const S3_ERROR_NAMES = {
  NO_SUCH_UPLOAD: 'NoSuchUpload',
} as const;
