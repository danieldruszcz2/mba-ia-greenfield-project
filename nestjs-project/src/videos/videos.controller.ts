import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import {
  CompleteUploadDto,
  CompleteUploadResponseDto,
} from './dto/complete-upload.dto';
import {
  InitiateUploadDto,
  InitiateUploadResponseDto,
} from './dto/initiate-upload.dto';
import {
  PartUrlsDto,
  PartUrlsResponseDto,
  UploadedPartsResponseDto,
} from './dto/part-urls.dto';
import { VideosService } from './videos.service';

const errorSchema = { $ref: getSchemaPath(ApiErrorEnvelope) };

@ApiTags('videos')
@ApiBearerAuth('access-token')
@ApiResponse({
  status: 401,
  description: 'Missing or invalid access token',
  schema: errorSchema,
})
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Pre-registers the video as an `uploading` draft and opens an S3 multipart upload. The file bytes go straight to storage.',
  })
  @ApiResponse({ status: 201, type: InitiateUploadResponseDto })
  @ApiResponse({
    status: 400,
    description: 'VIDEO_TOO_LARGE, UNSUPPORTED_VIDEO_TYPE or validation error',
    schema: errorSchema,
  })
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateUploadDto,
  ): Promise<InitiateUploadResponseDto> {
    return this.videosService.initiateUpload(user.sub, dto);
  }

  @Post(':id/upload/part-urls')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign upload URLs for parts',
    description:
      'Returns presigned `UploadPart` URLs. The client PUTs each part to its URL and keeps the `ETag` response header.',
  })
  @ApiResponse({ status: 200, type: PartUrlsResponseDto })
  @ApiResponse({
    status: 400,
    description: 'INVALID_UPLOAD_PARTS or validation error',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_UPLOAD_NOT_IN_PROGRESS',
    schema: errorSchema,
  })
  async getPartUrls(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: PartUrlsDto,
  ): Promise<PartUrlsResponseDto> {
    return this.videosService.getPartUrls(id, user.sub, dto.partNumbers);
  }

  @Get(':id/upload/parts')
  @ApiOperation({
    summary: 'List uploaded parts',
    description: 'Lists the parts storage already has, to resume an upload.',
  })
  @ApiResponse({ status: 200, type: UploadedPartsResponseDto })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_UPLOAD_NOT_IN_PROGRESS',
    schema: errorSchema,
  })
  async listUploadedParts(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ): Promise<UploadedPartsResponseDto> {
    return { parts: await this.videosService.listUploadedParts(id, user.sub) };
  }

  @Post(':id/upload/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Complete the upload',
    description:
      'Assembles the uploaded parts, moves the video to `processing` and enqueues processing.',
  })
  @ApiResponse({ status: 202, type: CompleteUploadResponseDto })
  @ApiResponse({
    status: 400,
    description: 'INVALID_UPLOAD_PARTS or validation error',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_UPLOAD_NOT_IN_PROGRESS',
    schema: errorSchema,
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResponseDto> {
    return this.videosService.completeUpload(id, user.sub, dto.parts);
  }

  @Delete(':id/upload')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Abort the upload',
    description: 'Aborts the multipart upload and deletes the draft.',
  })
  @ApiResponse({ status: 204, description: 'Upload aborted' })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_UPLOAD_NOT_IN_PROGRESS',
    schema: errorSchema,
  })
  async abortUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ): Promise<void> {
    await this.videosService.abortUpload(id, user.sub);
  }
}
