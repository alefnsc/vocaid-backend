/**
 * Interview Media Service
 * 
 * Handles interview recording uploads and retrieval.
 * Uses Azure Blob Storage with SAS URLs for direct client uploads.
 * 
 * @module services/interviewMediaService
 */

import { v4 as uuidv4 } from 'uuid';
import logger from '../utils/logger';
import { prisma } from './databaseService';
import { 
  generateMediaUploadSas, 
  generateMediaDownloadSas,
  deleteMedia,
  isAzureBlobEnabled 
} from './azureBlobService';
import type { MediaStatus, MediaKind } from '@prisma/client';

const mediaLogger = logger.child({ component: 'interview-media' });

// ============================================
// TYPES
// ============================================

export interface UploadUrlRequest {
  userId: string;
  interviewId: string;
  mimeType: string;
  sizeBytes: number;
  kind?: MediaKind;
}

export interface UploadUrlResponse {
  success: boolean;
  uploadUrl?: string;
  blobKey?: string;
  mediaId?: string;
  expiresAt?: Date;
  headers?: Record<string, string>;
  error?: string;
}

export interface CompleteUploadRequest {
  userId: string;
  interviewId: string;
  blobKey: string;
  mimeType: string;
  sizeBytes: number;
  durationSec?: number;
}

export interface CompleteUploadResponse {
  success: boolean;
  mediaId?: string;
  error?: string;
}

export interface MediaInfo {
  id: string;
  interviewId: string;
  status: MediaStatus;
  mimeType: string;
  sizeBytes: number;
  durationSec: number | null;
  downloadUrl?: string;
  createdAt: Date;
}

// ============================================
// SERVICE FUNCTIONS
// ============================================

/**
 * Generate a SAS URL for uploading interview media
 */
export async function getUploadUrl(request: UploadUrlRequest): Promise<UploadUrlResponse> {
  const { userId, interviewId, mimeType, sizeBytes, kind = 'RECORDING' } = request;

  // Validate user owns interview
  const interview = await prisma.interview.findFirst({
    where: { id: interviewId, userId },
    select: { id: true },
  });

  if (!interview) {
    return { success: false, error: 'Interview not found or not owned by user' };
  }

  // Check if media already exists for this interview
  const existing = await prisma.interviewMedia.findUnique({
    where: { interviewId },
    select: { id: true, status: true },
  });

  if (existing && existing.status === 'AVAILABLE') {
    return { success: false, error: 'Recording already exists for this interview' };
  }

  // Generate unique media ID
  const mediaId = existing?.id || uuidv4();

  // Generate SAS URL for upload
  const sasResult = await generateMediaUploadSas(
    userId,
    interviewId,
    mediaId,
    mimeType
  );

  if (!sasResult.success || !sasResult.uploadUrl || !sasResult.blobKey) {
    return { success: false, error: sasResult.error || 'Failed to generate upload URL' };
  }

  // Create or update media record with UPLOADING status
  if (existing) {
    await prisma.interviewMedia.update({
      where: { id: mediaId },
      data: {
        blobKey: sasResult.blobKey,
        mimeType,
        sizeBytes,
        status: 'UPLOADING',
      },
    });
  } else {
    await prisma.interviewMedia.create({
      data: {
        id: mediaId,
        interviewId,
        userId,
        kind,
        blobKey: sasResult.blobKey,
        mimeType,
        sizeBytes,
        status: 'UPLOADING',
      },
    });
  }

  mediaLogger.info('Generated media upload URL', {
    userId: userId.slice(0, 12),
    interviewId: interviewId.slice(0, 12),
    mediaId: mediaId.slice(0, 12),
    mimeType,
    sizeBytes,
  });

  return {
    success: true,
    uploadUrl: sasResult.uploadUrl,
    blobKey: sasResult.blobKey,
    mediaId,
    expiresAt: sasResult.expiresAt,
    headers: sasResult.headers,
  };
}

/**
 * Mark media upload as complete
 */
export async function completeUpload(request: CompleteUploadRequest): Promise<CompleteUploadResponse> {
  const { userId, interviewId, blobKey, mimeType, sizeBytes, durationSec } = request;

  // Validate user owns interview
  const interview = await prisma.interview.findFirst({
    where: { id: interviewId, userId },
    select: { id: true },
  });

  if (!interview) {
    return { success: false, error: 'Interview not found or not owned by user' };
  }

  // Find existing media record
  const media = await prisma.interviewMedia.findUnique({
    where: { interviewId },
    select: { id: true, blobKey: true, status: true },
  });

  if (!media) {
    return { success: false, error: 'No pending upload found for this interview' };
  }

  if (media.blobKey !== blobKey) {
    return { success: false, error: 'Blob key mismatch' };
  }

  // Update media record to AVAILABLE
  await prisma.interviewMedia.update({
    where: { id: media.id },
    data: {
      status: 'AVAILABLE',
      mimeType,
      sizeBytes,
      durationSec,
    },
  });

  mediaLogger.info('Media upload completed', {
    userId: userId.slice(0, 12),
    interviewId: interviewId.slice(0, 12),
    mediaId: media.id.slice(0, 12),
    durationSec,
  });

  return {
    success: true,
    mediaId: media.id,
  };
}

/**
 * Mark media upload as failed
 */
export async function failUpload(userId: string, interviewId: string): Promise<void> {
  const media = await prisma.interviewMedia.findFirst({
    where: { interviewId, userId },
    select: { id: true },
  });

  if (media) {
    await prisma.interviewMedia.update({
      where: { id: media.id },
      data: { status: 'FAILED' },
    });

    mediaLogger.warn('Media upload marked as failed', {
      userId: userId.slice(0, 12),
      interviewId: interviewId.slice(0, 12),
    });
  }
}

/**
 * Get media info for an interview
 */
export async function getMediaInfo(
  userId: string, 
  interviewId: string,
  includeDownloadUrl: boolean = true
): Promise<MediaInfo | null> {
  // Validate user owns interview
  const interview = await prisma.interview.findFirst({
    where: { id: interviewId, userId },
    select: { id: true },
  });

  if (!interview) {
    return null;
  }

  const media = await prisma.interviewMedia.findUnique({
    where: { interviewId },
    select: {
      id: true,
      interviewId: true,
      status: true,
      mimeType: true,
      sizeBytes: true,
      durationSec: true,
      blobKey: true,
      createdAt: true,
    },
  });

  if (!media) {
    return null;
  }

  let downloadUrl: string | undefined;
  if (includeDownloadUrl && media.status === 'AVAILABLE') {
    downloadUrl = await generateMediaDownloadSas(media.blobKey) || undefined;
  }

  return {
    id: media.id,
    interviewId: media.interviewId,
    status: media.status,
    mimeType: media.mimeType,
    sizeBytes: media.sizeBytes,
    durationSec: media.durationSec,
    downloadUrl,
    createdAt: media.createdAt,
  };
}

/**
 * Get download URL for interview media
 */
export async function getDownloadUrl(
  userId: string, 
  interviewId: string
): Promise<string | null> {
  // Validate user owns interview
  const interview = await prisma.interview.findFirst({
    where: { id: interviewId, userId },
    select: { id: true },
  });

  if (!interview) {
    return null;
  }

  const media = await prisma.interviewMedia.findUnique({
    where: { interviewId },
    select: { blobKey: true, status: true },
  });

  if (!media || media.status !== 'AVAILABLE') {
    return null;
  }

  return generateMediaDownloadSas(media.blobKey);
}

/**
 * Delete media for an interview
 */
export async function deleteInterviewMedia(
  userId: string, 
  interviewId: string
): Promise<boolean> {
  // Validate user owns interview
  const interview = await prisma.interview.findFirst({
    where: { id: interviewId, userId },
    select: { id: true },
  });

  if (!interview) {
    return false;
  }

  const media = await prisma.interviewMedia.findUnique({
    where: { interviewId },
    select: { id: true, blobKey: true },
  });

  if (!media) {
    return false;
  }

  // Delete from Azure Blob Storage
  await deleteMedia(media.blobKey);

  // Delete from database
  await prisma.interviewMedia.delete({
    where: { id: media.id },
  });

  mediaLogger.info('Media deleted', {
    userId: userId.slice(0, 12),
    interviewId: interviewId.slice(0, 12),
  });

  return true;
}

/**
 * Check if Azure Blob Storage is available for media
 */
export function isMediaStorageAvailable(): boolean {
  return isAzureBlobEnabled();
}

export default {
  getUploadUrl,
  completeUpload,
  failUpload,
  getMediaInfo,
  getDownloadUrl,
  deleteInterviewMedia,
  isMediaStorageAvailable,
};
