import { Test } from '@nestjs/testing';
import { ChannelsService } from '../channels/channels.service';
import { VideoProcessingProducer } from '../queue/video-processing.producer';
import { StorageService } from '../storage/storage.service';
import { type Video, VideoStatus } from './entities/video.entity';
import { VIDEO_UPLOAD_LIMITS } from './videos.constants';
import {
  InvalidUploadPartsException,
  UnsupportedVideoTypeException,
  VideoNotFoundException,
  VideoTooLargeException,
  VideoUploadNotInProgressException,
} from './videos.exceptions';
import { VideosRepository } from './videos.repository';
import { VideosService } from './videos.service';

const USER_ID = 'user-1';
const PART = VIDEO_UPLOAD_LIMITS.PART_SIZE_BYTES;

const buildVideo = (overrides: Partial<Video> = {}): Video =>
  ({
    id: 'video-uuid',
    public_id: 'pubId123456',
    channel_id: 'channel-1',
    status: VideoStatus.UPLOADING,
    size_bytes: PART * 2,
    part_size_bytes: PART,
    storage_key: 'video-uuid/original',
    upload_id: 'upload-1',
    ...overrides,
  }) as Video;

describe('VideosService (upload)', () => {
  let service: VideosService;
  const repository = {
    insertWithUniquePublicId: jest.fn(),
    findOwnedByPublicId: jest.fn(),
    touch: jest.fn(),
    update: jest.fn(),
    deleteById: jest.fn(),
  };
  const channels = { findByUserId: jest.fn() };
  const storage = {
    createMultipartUpload: jest.fn(),
    presignUploadParts: jest.fn(),
    listParts: jest.fn(),
    completeMultipartUpload: jest.fn(),
    abortMultipartUpload: jest.fn(),
  };
  const producer = { enqueue: jest.fn() };

  const validInput = {
    title: 'Meu vídeo',
    filename: 'clip.mp4',
    contentType: 'video/mp4',
    sizeBytes: 1024 * 1024 * 1024,
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: VideosRepository, useValue: repository },
        { provide: ChannelsService, useValue: channels },
        { provide: StorageService, useValue: storage },
        { provide: VideoProcessingProducer, useValue: producer },
      ],
    }).compile();
    service = module.get(VideosService);
  });

  describe('initiateUpload', () => {
    it('should reject sizes above 10 GiB without touching storage or DB', async () => {
      await expect(
        service.initiateUpload(USER_ID, {
          ...validInput,
          sizeBytes: VIDEO_UPLOAD_LIMITS.MAX_SIZE_BYTES + 1,
        }),
      ).rejects.toBeInstanceOf(VideoTooLargeException);
      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
      expect(repository.insertWithUniquePublicId).not.toHaveBeenCalled();
    });

    it('should reject content types outside the allowlist', async () => {
      await expect(
        service.initiateUpload(USER_ID, {
          ...validInput,
          contentType: 'video/x-msvideo',
        }),
      ).rejects.toBeInstanceOf(UnsupportedVideoTypeException);
      expect(repository.insertWithUniquePublicId).not.toHaveBeenCalled();
    });

    it('should return the public id and the server-dictated part plan', async () => {
      channels.findByUserId.mockResolvedValue({ id: 'channel-1' });
      storage.createMultipartUpload.mockResolvedValue('upload-1');
      repository.insertWithUniquePublicId.mockImplementation(async (data) =>
        buildVideo({ ...data, public_id: 'pubId123456' }),
      );

      const result = await service.initiateUpload(USER_ID, validInput);

      expect(result).toEqual({
        id: 'pubId123456',
        status: VideoStatus.UPLOADING,
        partSizeBytes: PART,
        partCount: 16,
      });
      const inserted = repository.insertWithUniquePublicId.mock.calls[0][0];
      expect(inserted.storage_key).toBe(`${inserted.id}/original`);
      expect(inserted.upload_id).toBe('upload-1');
    });

    it('should abort the multipart upload when the insert fails', async () => {
      channels.findByUserId.mockResolvedValue({ id: 'channel-1' });
      storage.createMultipartUpload.mockResolvedValue('upload-1');
      repository.insertWithUniquePublicId.mockRejectedValue(
        new Error('db down'),
      );

      await expect(service.initiateUpload(USER_ID, validInput)).rejects.toThrow(
        'db down',
      );
      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        expect.stringMatching(/\/original$/),
        'upload-1',
      );
    });
  });

  describe('ownership and status guards', () => {
    it('should throw VideoNotFoundException when the video is not owned by the user', async () => {
      repository.findOwnedByPublicId.mockResolvedValue(null);

      await expect(
        service.getPartUrls('pubId123456', USER_ID, [1]),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it.each([VideoStatus.PROCESSING, VideoStatus.READY, VideoStatus.FAILED])(
      'should reject upload operations when status is %s',
      async (status) => {
        repository.findOwnedByPublicId.mockResolvedValue(
          buildVideo({ status, upload_id: null }),
        );

        await expect(
          service.completeUpload('pubId123456', USER_ID, []),
        ).rejects.toBeInstanceOf(VideoUploadNotInProgressException);
      },
    );
  });

  describe('getPartUrls', () => {
    it('should reject part numbers outside 1..partCount', async () => {
      repository.findOwnedByPublicId.mockResolvedValue(buildVideo());

      await expect(
        service.getPartUrls('pubId123456', USER_ID, [1, 3]),
      ).rejects.toBeInstanceOf(InvalidUploadPartsException);
      expect(storage.presignUploadParts).not.toHaveBeenCalled();
    });

    it('should touch the video before signing', async () => {
      repository.findOwnedByPublicId.mockResolvedValue(buildVideo());
      storage.presignUploadParts.mockResolvedValue({
        parts: [],
        expiresAt: new Date(),
      });

      await service.getPartUrls('pubId123456', USER_ID, [1, 2]);

      expect(repository.touch).toHaveBeenCalledWith('video-uuid');
      expect(storage.presignUploadParts).toHaveBeenCalledWith(
        'video-uuid/original',
        'upload-1',
        [1, 2],
      );
    });
  });

  describe('completeUpload', () => {
    const parts = [
      { partNumber: 1, etag: '"a"' },
      { partNumber: 2, etag: '"b"' },
    ];

    it('should reject a part list with the wrong count before calling storage', async () => {
      repository.findOwnedByPublicId.mockResolvedValue(buildVideo());

      await expect(
        service.completeUpload('pubId123456', USER_ID, parts.slice(0, 1)),
      ).rejects.toBeInstanceOf(InvalidUploadPartsException);
      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
    });

    it('should map storage InvalidPart to InvalidUploadPartsException and keep the status', async () => {
      repository.findOwnedByPublicId.mockResolvedValue(buildVideo());
      storage.completeMultipartUpload.mockRejectedValue(
        Object.assign(new Error('bad etag'), { name: 'InvalidPart' }),
      );

      await expect(
        service.completeUpload('pubId123456', USER_ID, parts),
      ).rejects.toBeInstanceOf(InvalidUploadPartsException);
      expect(repository.update).not.toHaveBeenCalled();
      expect(producer.enqueue).not.toHaveBeenCalled();
    });

    it('should propagate unknown storage errors unchanged', async () => {
      repository.findOwnedByPublicId.mockResolvedValue(buildVideo());
      storage.completeMultipartUpload.mockRejectedValue(new Error('timeout'));

      await expect(
        service.completeUpload('pubId123456', USER_ID, parts),
      ).rejects.toThrow('timeout');
    });

    it('should move to processing, clear upload_id and enqueue the internal id', async () => {
      repository.findOwnedByPublicId.mockResolvedValue(buildVideo());

      const result = await service.completeUpload(
        'pubId123456',
        USER_ID,
        parts,
      );

      expect(result).toEqual({
        id: 'pubId123456',
        status: VideoStatus.PROCESSING,
      });
      expect(repository.update).toHaveBeenCalledWith('video-uuid', {
        status: VideoStatus.PROCESSING,
        upload_id: null,
      });
      expect(producer.enqueue).toHaveBeenCalledWith('video-uuid');
    });
  });

  describe('abortUpload', () => {
    it('should abort the multipart upload and delete the draft', async () => {
      repository.findOwnedByPublicId.mockResolvedValue(buildVideo());

      await service.abortUpload('pubId123456', USER_ID);

      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        'video-uuid/original',
        'upload-1',
      );
      expect(repository.deleteById).toHaveBeenCalledWith('video-uuid');
    });
  });
});
