import { randomBytes } from 'node:crypto';

export const PUBLIC_ID_LENGTH = 11;

const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * URL-safe random ID (`[A-Za-z0-9_-]{11}`, ~66 bits of entropy).
 * 64 symbols divide 256 evenly, so `byte & 63` has no modulo bias.
 */
export function generatePublicId(): string {
  const bytes = randomBytes(PUBLIC_ID_LENGTH);
  let id = '';
  for (const byte of bytes) {
    id += ALPHABET[byte & 63];
  }
  return id;
}
