import { UnrecoverableError } from 'bullmq';
import type { VideoMetadata } from '../videos/entities/video.entity';
import { MediaProbeService } from './media-probe.service';
import { thumbnailPosition } from './worker.constants';

const metadata = (overrides: Partial<VideoMetadata>): VideoMetadata => ({
  container: 'mp4',
  videoCodec: 'h264',
  audioCodec: 'aac',
  width: 320,
  height: 240,
  bitrate: 100000,
  ...overrides,
});

describe('MediaProbeService.assertPlayable', () => {
  const service = new MediaProbeService();

  it.each([
    ['mp4', 'h264', 'aac'],
    ['mp4', 'h264', null],
    ['webm', 'vp8', 'vorbis'],
    ['webm', 'vp9', 'opus'],
    ['webm', 'av1', null],
  ])('should accept %s with %s/%s', (container, videoCodec, audioCodec) => {
    expect(() =>
      service.assertPlayable(metadata({ container, videoCodec, audioCodec })),
    ).not.toThrow();
  });

  it.each([
    ['mp4', 'hevc', 'aac'],
    ['mp4', 'h264', 'opus'],
    ['webm', 'h264', 'opus'],
    ['avi', 'mpeg4', null],
    [null, 'h264', 'aac'],
    ['mp4', null, 'aac'],
  ])(
    'should reject %s with %s/%s as unrecoverable UNPLAYABLE_CODEC',
    (container, videoCodec, audioCodec) => {
      const act = () =>
        service.assertPlayable(metadata({ container, videoCodec, audioCodec }));

      expect(act).toThrow(UnrecoverableError);
      expect(act).toThrow('UNPLAYABLE_CODEC');
    },
  );
});

describe('thumbnailPosition', () => {
  it('should pick ~10% of the duration', () => {
    expect(thumbnailPosition(100)).toBeCloseTo(10);
  });

  it('should stay inside the stream for very short videos', () => {
    expect(thumbnailPosition(0.05)).toBe(0);
    expect(thumbnailPosition(0.5)).toBeLessThanOrEqual(0.4);
  });

  it('should never be negative', () => {
    expect(thumbnailPosition(0)).toBe(0);
  });
});
