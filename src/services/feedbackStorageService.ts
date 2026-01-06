/**
 * Feedback Storage Service
 *
 * Canonical storage:
 * - Structured feedback JSON stays in Postgres (FeedbackDocument.contentJson)
 * - Generated feedback PDF lives in Azure Blob (FeedbackDocument.pdfStorageKey)
 */

import { PrismaClient } from '@prisma/client';
import { StructuredFeedback } from '../types/feedback';
import logger from '../utils/logger';
import { upsertFeedbackDocument } from './feedbackDocumentService';

const prisma = new PrismaClient();

// ============================================
// TYPES
// ============================================

export interface StoreFeedbackJsonParams {
  interviewId: string;
  feedback: StructuredFeedback;
  generationTimeMs?: number;
  tokenCount?: number;
}

export interface StoreFeedbackPdfParams {
  interviewId: string;
  pdfBuffer: Buffer;
  pageCount: number;
  locale?: string;
  includesStudyPlan?: boolean;
  includesHighlights?: boolean;
  storageKey: string; // Azure Blob storage key
}

export interface StoredFeedbackJson {
  id: string;
  interviewId: string;
  schemaVersion: string;
  promptVersion: string;
  model: string;
  overallScore: number;
  createdAt: Date;
}

export interface StoredFeedbackPdf {
  interviewId: string;
  pageCount: number;
  fileSizeBytes: number;
  storageKey: string;
  createdAt: Date;
}

// ============================================
// FEEDBACK JSON STORAGE
// ============================================

/**
 * Store structured feedback JSON in the database
 */
export async function storeFeedbackJson(
  params: StoreFeedbackJsonParams
): Promise<StoredFeedbackJson> {
  const { interviewId, feedback, generationTimeMs, tokenCount } = params;
  
  logger.info('Storing feedback JSON', {
    interviewId,
    schemaVersion: feedback.schemaVersion,
    promptVersion: feedback.promptVersion,
    overallScore: feedback.overallScore
  });
  
  try {
    const interview = await prisma.interview.findUnique({
      where: { id: interviewId },
      select: { userId: true }
    });

    if (!interview?.userId) {
      throw new Error('Interview not found');
    }

    const record = await upsertFeedbackDocument({
      interviewId,
      userId: interview.userId,
      contentJson: feedback,
      overallScore: feedback.overallScore,
      schemaVersion: feedback.schemaVersion,
      promptVersion: feedback.promptVersion,
      model: feedback.model
    });

    logger.info('Feedback document stored successfully', {
      id: record.id,
      interviewId: record.interviewId
    });

    // Preserve signature: return a "StoredFeedbackJson"-like summary
    return {
      id: record.id,
      interviewId: record.interviewId,
      schemaVersion: feedback.schemaVersion,
      promptVersion: feedback.promptVersion,
      model: feedback.model,
      overallScore: feedback.overallScore,
      createdAt: record.generatedAt
    };
  } catch (error: any) {
    logger.error('Failed to store feedback JSON', {
      interviewId,
      error: error.message
    });
    throw error;
  }
}

// ============================================
// FEEDBACK PDF STORAGE
// ============================================

/**
 * Record feedback PDF storage key (PDF bytes are stored in Azure Blob)
 */
export async function storeFeedbackPdf(
  params: StoreFeedbackPdfParams
): Promise<StoredFeedbackPdf> {
  const {
    interviewId,
    pdfBuffer,
    pageCount,
    locale,
    includesStudyPlan = true,
    includesHighlights = true,
    storageKey
  } = params;
  
  const fileSizeBytes = pdfBuffer.length;
  
  logger.info('Storing feedback PDF', {
    interviewId,
    fileSizeBytes,
    pageCount,
    hasStorageKey: !!storageKey,
    locale,
    includesStudyPlan,
    includesHighlights
  });
  
  try {
    const interview = await prisma.interview.findUnique({
      where: { id: interviewId },
      select: { userId: true }
    });

    if (!interview?.userId) {
      throw new Error('Interview not found');
    }

    await upsertFeedbackDocument({
      interviewId,
      userId: interview.userId,
      pdfStorageKey: storageKey
    });

    return {
      interviewId,
      pageCount,
      fileSizeBytes,
      storageKey,
      createdAt: new Date()
    };
  } catch (error: any) {
    logger.error('Failed to store feedback PDF', {
      interviewId,
      error: error.message
    });
    throw error;
  }
}

// ============================================
// RETRIEVAL FUNCTIONS
// ============================================

/**
 * Get the latest feedback JSON for an interview
 */
export async function getLatestFeedbackJson(
  interviewId: string
): Promise<StructuredFeedback | null> {
  try {
    const record = await prisma.feedbackDocument.findUnique({
      where: { interviewId },
      select: { contentJson: true }
    });

    if (!record?.contentJson) return null;

    return record.contentJson as unknown as StructuredFeedback;
  } catch (error: any) {
    logger.error('Failed to get feedback JSON', {
      interviewId,
      error: error.message
    });
    return null;
  }
}

/**
 * Get all feedback versions for an interview
 */
export async function getFeedbackHistory(
  interviewId: string
): Promise<StoredFeedbackJson[]> {
  try {
    const record = await prisma.feedbackDocument.findUnique({
      where: { interviewId },
      select: {
        id: true,
        interviewId: true,
        schemaVersion: true,
        promptVersion: true,
        model: true,
        overallScore: true,
        createdAt: true
      }
    });

    if (!record) return [];

    return [
      {
        id: record.id,
        interviewId: record.interviewId,
        schemaVersion: record.schemaVersion || 'unknown',
        promptVersion: record.promptVersion || 'unknown',
        model: record.model || 'unknown',
        overallScore: record.overallScore ?? 0,
        createdAt: record.createdAt
      }
    ];
  } catch (error: any) {
    logger.error('Failed to get feedback history', {
      interviewId,
      error: error.message
    });
    return [];
  }
}

/**
 * Get PDF metadata for a feedback JSON
 */
export async function getPdfsForFeedback(
  feedbackJsonId: string
): Promise<StoredFeedbackPdf[]> {
  // Legacy API kept for compatibility; FeedbackDocument now stores a single PDF key.
  logger.debug('getPdfsForFeedback is deprecated; returning empty list', { feedbackJsonId });
  return [];
}

// ============================================
// CLEANUP FUNCTIONS
// ============================================

/**
 * Delete old feedback versions, keeping only the latest N
 */
export async function cleanupOldFeedback(
  interviewId: string,
  keepCount: number = 3
): Promise<number> {
  // No versioning in FeedbackDocument-only world.
  logger.debug('cleanupOldFeedback is a no-op for FeedbackDocument', { interviewId, keepCount });
  return 0;
}
