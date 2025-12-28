/**
 * Feedback Storage Service
 * 
 * Handles persisting structured feedback JSON and PDF metadata
 * to the database for versioning and audit trails.
 */

import { PrismaClient } from '@prisma/client';
import { StructuredFeedback } from '../types/feedback';
import logger from '../utils/logger';
import crypto from 'crypto';

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
  feedbackJsonId: string;
  pdfBuffer: Buffer;
  pageCount: number;
  locale?: string;
  includesStudyPlan?: boolean;
  includesHighlights?: boolean;
  storageKey?: string;  // S3 key if stored externally
  storeInline?: boolean;  // Store Base64 in database (for small PDFs)
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
  id: string;
  feedbackJsonId: string;
  interviewId: string;
  pageCount: number;
  fileSizeBytes: number;
  checksum: string;
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
    const record = await prisma.feedbackJson.create({
      data: {
        interviewId,
        schemaVersion: feedback.schemaVersion,
        promptVersion: feedback.promptVersion,
        model: feedback.model,
        contentJson: feedback as any,  // Prisma Json type
        overallScore: feedback.overallScore,
        generationTimeMs,
        tokenCount,
        warningCount: feedback.warnings?.length || 0
      }
    });
    
    logger.info('Feedback JSON stored successfully', {
      id: record.id,
      interviewId: record.interviewId
    });
    
    return {
      id: record.id,
      interviewId: record.interviewId,
      schemaVersion: record.schemaVersion,
      promptVersion: record.promptVersion,
      model: record.model,
      overallScore: record.overallScore,
      createdAt: record.createdAt
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
 * Generate SHA-256 checksum for PDF deduplication
 */
function generateChecksum(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Store feedback PDF metadata (and optionally content) in the database
 */
export async function storeFeedbackPdf(
  params: StoreFeedbackPdfParams
): Promise<StoredFeedbackPdf> {
  const {
    interviewId,
    feedbackJsonId,
    pdfBuffer,
    pageCount,
    locale,
    includesStudyPlan = true,
    includesHighlights = true,
    storageKey,
    storeInline = false
  } = params;
  
  const fileSizeBytes = pdfBuffer.length;
  const checksum = generateChecksum(pdfBuffer);
  
  logger.info('Storing feedback PDF', {
    interviewId,
    feedbackJsonId,
    fileSizeBytes,
    pageCount,
    storeInline
  });
  
  try {
    // Check for duplicate by checksum
    const existing = await prisma.feedbackPdf.findFirst({
      where: { checksum }
    });
    
    if (existing) {
      logger.info('Duplicate PDF detected, returning existing', {
        existingId: existing.id,
        checksum
      });
      return {
        id: existing.id,
        feedbackJsonId: existing.feedbackJsonId,
        interviewId: existing.interviewId,
        pageCount: existing.pageCount,
        fileSizeBytes: existing.fileSizeBytes,
        checksum: existing.checksum,
        createdAt: existing.createdAt
      };
    }
    
    // Store PDF
    const record = await prisma.feedbackPdf.create({
      data: {
        interviewId,
        feedbackJsonId,
        pageCount,
        fileSizeBytes,
        checksum,
        storageKey,
        pdfBase64: storeInline ? pdfBuffer.toString('base64') : null,
        locale,
        includesStudyPlan,
        includesHighlights
      }
    });
    
    logger.info('Feedback PDF stored successfully', {
      id: record.id,
      interviewId: record.interviewId,
      checksum
    });
    
    return {
      id: record.id,
      feedbackJsonId: record.feedbackJsonId,
      interviewId: record.interviewId,
      pageCount: record.pageCount,
      fileSizeBytes: record.fileSizeBytes,
      checksum: record.checksum,
      createdAt: record.createdAt
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
    const record = await prisma.feedbackJson.findFirst({
      where: { interviewId },
      orderBy: { createdAt: 'desc' }
    });
    
    if (!record) return null;
    
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
    const records = await prisma.feedbackJson.findMany({
      where: { interviewId },
      orderBy: { createdAt: 'desc' },
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
    
    return records;
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
  try {
    const records = await prisma.feedbackPdf.findMany({
      where: { feedbackJsonId },
      orderBy: { createdAt: 'desc' }
    });
    
    return records.map(r => ({
      id: r.id,
      feedbackJsonId: r.feedbackJsonId,
      interviewId: r.interviewId,
      pageCount: r.pageCount,
      fileSizeBytes: r.fileSizeBytes,
      checksum: r.checksum,
      createdAt: r.createdAt
    }));
  } catch (error: any) {
    logger.error('Failed to get PDFs for feedback', {
      feedbackJsonId,
      error: error.message
    });
    return [];
  }
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
  try {
    const allRecords = await prisma.feedbackJson.findMany({
      where: { interviewId },
      orderBy: { createdAt: 'desc' },
      select: { id: true }
    });
    
    if (allRecords.length <= keepCount) return 0;
    
    const toDelete = allRecords.slice(keepCount).map(r => r.id);
    
    // PDFs will be cascade deleted
    const result = await prisma.feedbackJson.deleteMany({
      where: { id: { in: toDelete } }
    });
    
    logger.info('Cleaned up old feedback versions', {
      interviewId,
      deletedCount: result.count
    });
    
    return result.count;
  } catch (error: any) {
    logger.error('Failed to cleanup old feedback', {
      interviewId,
      error: error.message
    });
    return 0;
  }
}
