import { DomainException } from '../common/exceptions/domain.exception';

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoTooLargeException extends DomainException {
  constructor(maxBytes: number) {
    super('VIDEO_TOO_LARGE', 400, `Video exceeds the ${maxBytes} bytes limit`);
  }
}

export class UnsupportedVideoTypeException extends DomainException {
  constructor(allowed: readonly string[]) {
    super(
      'UNSUPPORTED_VIDEO_TYPE',
      400,
      `Unsupported video type. Allowed: ${allowed.join(', ')}`,
    );
  }
}

export class VideoUploadNotInProgressException extends DomainException {
  constructor() {
    super(
      'VIDEO_UPLOAD_NOT_IN_PROGRESS',
      409,
      'The video upload is not in progress',
    );
  }
}

export class InvalidUploadPartsException extends DomainException {
  constructor(detail: string) {
    super('INVALID_UPLOAD_PARTS', 400, detail);
  }
}
