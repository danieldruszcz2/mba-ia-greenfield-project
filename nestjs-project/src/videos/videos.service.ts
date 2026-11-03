import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ChannelsService } from '../channels/channels.service';
import { VideoProcessingProducer } from '../queue/video-processing.producer';
import { StorageService } from '../storage/storage.service';
import type {
  CompletedPart,
  PresignedPartUrls,
  PresignedUrl,
  UploadedPart,
} from '../storage/storage.types';
import {
  type Video,
  type VideoMetadata,
  VideoStatus,
} from './entities/video.entity';
import {
  ALLOWED_VIDEO_CONTENT_TYPES,
  S3_INVALID_PARTS_ERROR_NAMES,
  VIDEO_UPLOAD_LIMITS,
  videoStorageKey,
} from './videos.constants';
import {
  InvalidUploadPartsException,
  UnsupportedVideoTypeException,
  VideoNotFoundException,
  VideoNotReadyException,
  VideoTooLargeException,
  VideoUploadNotInProgressException,
} from './videos.exceptions';
import { VideosRepository } from './videos.repository';

export interface InitiateUploadInput {
  title: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

export interface InitiatedUpload {
  id: string;
  status: VideoStatus;
  partSizeBytes: number;
  partCount: number;
}

export interface CompletedUpload {
  id: string;
  status: VideoStatus;
}

export interface VideoDetail {
  id: string;
  title: string;
  status: VideoStatus;
  sizeBytes: number;
  contentType: string;
  durationSeconds: number | null;
  metadata: VideoMetadata | null;
  thumbnailUrl: string | null;
  failureReason: string | null;
  createdAt: Date;
}

const partCountOf = (video: Pick<Video, 'size_bytes' | 'part_size_bytes'>) =>
  Math.ceil(video.size_bytes / video.part_size_bytes);

@Injectable()
export class VideosService {
  constructor(
    private readonly videosRepository: VideosRepository,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    private readonly videoProcessingProducer: VideoProcessingProducer,
  ) {}

  /** Pre-registers the draft and opens the S3 multipart upload. */
  async initiateUpload(
    userId: string,
    input: InitiateUploadInput,
  ): Promise<InitiatedUpload> {
    if (input.sizeBytes > VIDEO_UPLOAD_LIMITS.MAX_SIZE_BYTES) {
      throw new VideoTooLargeException(VIDEO_UPLOAD_LIMITS.MAX_SIZE_BYTES);
    }
    if (
      !(ALLOWED_VIDEO_CONTENT_TYPES as readonly string[]).includes(
        input.contentType,
      )
    ) {
      throw new UnsupportedVideoTypeException(ALLOWED_VIDEO_CONTENT_TYPES);
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new Error(`User ${userId} has no channel`);
    }

    const id = randomUUID();
    const storageKey = videoStorageKey(id);
    const uploadId = await this.storageService.createMultipartUpload(
      storageKey,
      input.contentType,
    );

    let video: Video;
    try {
      video = await this.videosRepository.insertWithUniquePublicId({
        id,
        channel_id: channel.id,
        title: input.title,
        original_filename: input.filename,
        content_type: input.contentType,
        size_bytes: input.sizeBytes,
        part_size_bytes: VIDEO_UPLOAD_LIMITS.PART_SIZE_BYTES,
        storage_key: storageKey,
        upload_id: uploadId,
        status: VideoStatus.UPLOADING,
      });
    } catch (err) {
      // Compensation: do not leave an orphan multipart upload in storage.
      await this.storageService.abortMultipartUpload(storageKey, uploadId);
      throw err;
    }

    return {
      id: video.public_id,
      status: video.status,
      partSizeBytes: video.part_size_bytes,
      partCount: partCountOf(video),
    };
  }

  async getPartUrls(
    publicId: string,
    userId: string,
    partNumbers: number[],
  ): Promise<PresignedPartUrls> {
    const video = await this.findUploadingOrFail(publicId, userId);
    const partCount = partCountOf(video);
    const outOfRange = partNumbers.filter((n) => n < 1 || n > partCount);
    if (outOfRange.length > 0) {
      throw new InvalidUploadPartsException(
        `Part numbers out of range 1..${partCount}: ${outOfRange.join(', ')}`,
      );
    }

    await this.videosRepository.touch(video.id);
    return this.storageService.presignUploadParts(
      video.storage_key,
      video.upload_id as string,
      partNumbers,
    );
  }

  async listUploadedParts(
    publicId: string,
    userId: string,
  ): Promise<UploadedPart[]> {
    const video = await this.findUploadingOrFail(publicId, userId);
    await this.videosRepository.touch(video.id);
    return this.storageService.listParts(
      video.storage_key,
      video.upload_id as string,
    );
  }

  /** Assembles the object, moves the video to `processing` and enqueues the job. */
  async completeUpload(
    publicId: string,
    userId: string,
    parts: CompletedPart[],
  ): Promise<CompletedUpload> {
    const video = await this.findUploadingOrFail(publicId, userId);
    const partCount = partCountOf(video);
    if (parts.length !== partCount) {
      throw new InvalidUploadPartsException(
        `Expected ${partCount} parts, received ${parts.length}`,
      );
    }

    try {
      await this.storageService.completeMultipartUpload(
        video.storage_key,
        video.upload_id as string,
        parts,
      );
    } catch (err) {
      const name = (err as Error).name;
      if ((S3_INVALID_PARTS_ERROR_NAMES as readonly string[]).includes(name)) {
        throw new InvalidUploadPartsException(
          `Storage rejected the part list (${name})`,
        );
      }
      throw err;
    }

    await this.videosRepository.update(video.id, {
      status: VideoStatus.PROCESSING,
      upload_id: null,
    });
    await this.videoProcessingProducer.enqueue(video.id);

    return { id: video.public_id, status: VideoStatus.PROCESSING };
  }

  /** Aborts the multipart upload and deletes the draft. */
  async abortUpload(publicId: string, userId: string): Promise<void> {
    const video = await this.findUploadingOrFail(publicId, userId);
    await this.storageService.abortMultipartUpload(
      video.storage_key,
      video.upload_id as string,
    );
    await this.videosRepository.deleteById(video.id);
  }

  async getDetail(publicId: string, userId: string): Promise<VideoDetail> {
    const video = await this.findOwnedOrFail(publicId, userId);
    return {
      id: video.public_id,
      title: video.title,
      status: video.status,
      sizeBytes: video.size_bytes,
      contentType: video.content_type,
      durationSeconds: video.duration_seconds,
      metadata: video.metadata,
      thumbnailUrl: video.thumbnail_key
        ? this.storageService.buildPublicThumbnailUrl(video.thumbnail_key)
        : null,
      failureReason: video.failure_reason,
      createdAt: video.created_at,
    };
  }

  /** Short-lived URL; storage answers the player's `Range` requests with 206. */
  async getStreamUrl(publicId: string, userId: string): Promise<PresignedUrl> {
    const video = await this.findReadyOrFail(publicId, userId);
    return this.storageService.presignGetObject(video.storage_key, {
      client: 'public',
    });
  }

  /** Same as the stream URL, but forces `Content-Disposition: attachment`. */
  async getDownloadUrl(
    publicId: string,
    userId: string,
  ): Promise<PresignedUrl> {
    const video = await this.findReadyOrFail(publicId, userId);
    return this.storageService.presignGetObject(video.storage_key, {
      client: 'public',
      downloadFilename: video.original_filename,
    });
  }

  async findOwnedOrFail(publicId: string, userId: string): Promise<Video> {
    const video = await this.videosRepository.findOwnedByPublicId(
      publicId,
      userId,
    );
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  private async findReadyOrFail(
    publicId: string,
    userId: string,
  ): Promise<Video> {
    const video = await this.findOwnedOrFail(publicId, userId);
    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException();
    }
    return video;
  }

  private async findUploadingOrFail(
    publicId: string,
    userId: string,
  ): Promise<Video> {
    const video = await this.findOwnedOrFail(publicId, userId);
    if (video.status !== VideoStatus.UPLOADING || !video.upload_id) {
      throw new VideoUploadNotInProgressException();
    }
    return video;
  }
}
