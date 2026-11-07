/** Container → codecs a browser plays progressively (TD-10 playability gate). */
export const PLAYABLE_CODECS = {
  mp4: { video: ['h264'], audio: ['aac'] },
  webm: { video: ['vp8', 'vp9', 'av1'], audio: ['opus', 'vorbis'] },
} as const;

export const WORKER_FAILURE_REASONS = {
  UNPLAYABLE_CODEC: 'UNPLAYABLE_CODEC',
  PROCESSING_FAILED: 'PROCESSING_FAILED',
} as const;

export const THUMBNAIL = {
  CONTENT_TYPE: 'image/jpeg',
  /** Frame position as a fraction of the duration. */
  POSITION_RATIO: 0.1,
  /** Keeps the seek strictly inside the stream for very short videos. */
  END_MARGIN_SECONDS: 0.1,
} as const;

export const thumbnailKey = (videoId: string): string => `${videoId}.jpg`;

/** ~10% of the duration, clamped to `[0, duration − margin]`. */
export function thumbnailPosition(durationSeconds: number): number {
  const upper = Math.max(0, durationSeconds - THUMBNAIL.END_MARGIN_SECONDS);
  return Math.min(
    Math.max(0, durationSeconds * THUMBNAIL.POSITION_RATIO),
    upper,
  );
}
