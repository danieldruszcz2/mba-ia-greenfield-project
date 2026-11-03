import { spawn } from 'node:child_process';
import { Injectable } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import type { VideoMetadata } from '../videos/entities/video.entity';
import { PLAYABLE_CODECS, WORKER_FAILURE_REASONS } from './worker.constants';

export interface ProbeResult {
  durationSeconds: number;
  metadata: VideoMetadata;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { format_name?: string; duration?: string; bit_rate?: string };
}

/** Last bytes of stderr kept for error messages. */
const STDERR_TAIL = 2_000;

function run(command: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout));
      } else {
        reject(new Error(`${command} exited with code ${code}: ${stderr}`));
      }
    });
  });
}

/** Maps ffprobe's `format_name` (e.g. "mov,mp4,m4a,...") to the container we care about. */
function containerOf(formatName: string | undefined): string | null {
  if (!formatName) return null;
  const names = formatName.split(',');
  if (names.includes('mp4')) return 'mp4';
  if (names.includes('webm')) return 'webm';
  return names[0] ?? null;
}

const toNumberOrNull = (value: string | number | undefined): number | null => {
  const parsed = Number(value);
  return value === undefined || Number.isNaN(parsed) ? null : parsed;
};

/**
 * Wraps the `ffprobe` / `ffmpeg` CLIs. Inputs are URLs (presigned GETs), so
 * both tools read only the byte ranges they need — never the full 10GB file.
 */
@Injectable()
export class MediaProbeService {
  async probe(url: string): Promise<ProbeResult> {
    const raw = await run('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      url,
    ]);
    const output = JSON.parse(raw.toString()) as FfprobeOutput;
    const streams = output.streams ?? [];
    const video = streams.find((s) => s.codec_type === 'video');
    const audio = streams.find((s) => s.codec_type === 'audio');

    return {
      durationSeconds: toNumberOrNull(output.format?.duration) ?? 0,
      metadata: {
        container: containerOf(output.format?.format_name),
        videoCodec: video?.codec_name ?? null,
        audioCodec: audio?.codec_name ?? null,
        width: video?.width ?? null,
        height: video?.height ?? null,
        bitrate: toNumberOrNull(output.format?.bit_rate),
      },
    };
  }

  /** Grabs a single JPEG frame at `atSeconds`. */
  async extractFrame(url: string, atSeconds: number): Promise<Buffer> {
    const frame = await run('ffmpeg', [
      '-v',
      'error',
      '-ss',
      atSeconds.toFixed(3),
      '-i',
      url,
      '-frames:v',
      '1',
      '-f',
      'image2',
      '-c:v',
      'mjpeg',
      'pipe:1',
    ]);
    if (frame.length === 0) {
      throw new Error(`ffmpeg produced no frame at ${atSeconds}s`);
    }
    return frame;
  }

  /**
   * Codec gate: only files a browser can play progressively pass. Rejection is
   * an `UnrecoverableError`, so BullMQ does not retry it.
   */
  assertPlayable(metadata: VideoMetadata): void {
    const rules = metadata.container
      ? PLAYABLE_CODECS[metadata.container as keyof typeof PLAYABLE_CODECS]
      : undefined;
    const videoOk =
      !!rules &&
      !!metadata.videoCodec &&
      (rules.video as readonly string[]).includes(metadata.videoCodec);
    const audioOk =
      !!rules &&
      (metadata.audioCodec === null ||
        (rules.audio as readonly string[]).includes(metadata.audioCodec));

    if (!videoOk || !audioOk) {
      throw new UnrecoverableError(WORKER_FAILURE_REASONS.UNPLAYABLE_CODEC);
    }
  }
}
