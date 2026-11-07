export const QUEUE_NAMES = {
  VIDEO_PROCESSING: 'video-processing',
  VIDEO_MAINTENANCE: 'video-maintenance',
} as const;

export const JOB_NAMES = {
  PROCESS_VIDEO: 'process-video',
  ABANDONED_UPLOAD_CLEANUP: 'abandoned-upload-cleanup',
} as const;

export const VIDEO_PROCESSING_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
} as const;

export const ABANDONED_UPLOAD_CLEANUP_EVERY_MS = 60 * 60 * 1000;

export interface ProcessVideoJobData {
  videoId: string;
}
