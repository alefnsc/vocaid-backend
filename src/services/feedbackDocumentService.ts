/**
 * Feedback Document Service
 * 
 * Manages the FeedbackDocument entity which serves as the canonical
 * feedback artifact per interview, consolidating feedback text,
 * transcription, structured JSON, and PDF storage key.
 * 
 * Designed for long-term replacement of FeedbackJson/FeedbackPdf tables.
 * 
 * @module services/feedbackDocumentService
 */

import { prisma, dbLogger } from './databaseService';
import { StructuredFeedback } from '../types/feedback';

// ========================================
// TYPES
// ========================================

export interface UpsertFeedbackDocumentParams {
  interviewId: string;
  userId: string;
  transcriptionText?: string | null;
  feedbackText?: string | null;
  contentJson?: StructuredFeedback | object | null;
  pdfStorageKey?: string | null;
  overallScore?: number | null;
  schemaVersion?: string | null;
  promptVersion?: string | null;
  model?: string | null;
}

export interface FeedbackDocumentSummary {
  id: string;
  interviewId: string;
  userId: string;
  pdfStorageKey: string | null;
  overallScore: number | null;
  hasTranscription: boolean;
  hasFeedbackText: boolean;
  hasContentJson: boolean;
  generatedAt: Date;
}

// Create logger for feedback document operations
const logger = dbLogger.child({ component: 'feedback-document' });

// ========================================
// CORE FUNCTIONS
// ========================================

/**
 * Upsert a FeedbackDocument for an interview (idempotent by interviewId)
 * 
 * Creates or updates the canonical feedback artifact for the interview.
 * Supports partial updates - only provided fields are updated.
 * 
 * @param params - Feedback document data
 * @returns The created or updated FeedbackDocument
 */
export async function upsertFeedbackDocument(
  params: UpsertFeedbackDocumentParams
): Promise<FeedbackDocumentSummary> {
  const {
    interviewId,
    userId,
    transcriptionText,
    feedbackText,
    contentJson,
    pdfStorageKey,
    overallScore,
    schemaVersion,
    promptVersion,
    model
  } = params;

  logger.info('Upserting feedback document', {
    interviewId,
    userId: userId.slice(0, 8) + '...',
    hasTranscription: !!transcriptionText,
    hasFeedbackText: !!feedbackText,
    hasContentJson: !!contentJson,
    hasStorageKey: !!pdfStorageKey
  });

  try {
    // Build update object with only defined fields
    const updateData: Record<string, unknown> = { generatedAt: new Date() };
    if (transcriptionText !== undefined) updateData.transcriptionText = transcriptionText;
    if (feedbackText !== undefined) updateData.feedbackText = feedbackText;
    if (contentJson !== undefined) updateData.contentJson = contentJson;
    if (pdfStorageKey !== undefined) updateData.pdfStorageKey = pdfStorageKey;
    if (overallScore !== undefined) updateData.overallScore = overallScore;
    if (schemaVersion !== undefined) updateData.schemaVersion = schemaVersion;
    if (promptVersion !== undefined) updateData.promptVersion = promptVersion;
    if (model !== undefined) updateData.model = model;

    const record = await prisma.feedbackDocument.upsert({
      where: { interviewId },
      create: {
        interviewId,
        userId,
        transcriptionText: transcriptionText ?? null,
        feedbackText: feedbackText ?? null,
        contentJson: contentJson ?? undefined,
        pdfStorageKey: pdfStorageKey ?? null,
        overallScore: overallScore ?? null,
        schemaVersion: schemaVersion ?? null,
        promptVersion: promptVersion ?? null,
        model: model ?? null,
        generatedAt: new Date()
      },
      update: updateData as Parameters<typeof prisma.feedbackDocument.upsert>[0]['update']
    });

    // Link the feedback document back to the interview (created only after generation)
    // Non-blocking if interview doesn't exist yet (should not happen in normal flow)
    await prisma.interview.updateMany({
      where: { id: interviewId, feedbackDocumentId: null },
      data: { feedbackDocumentId: record.id }
    });

    logger.info('Feedback document upserted successfully', {
      id: record.id,
      interviewId: record.interviewId
    });

    return {
      id: record.id,
      interviewId: record.interviewId,
      userId: record.userId,
      pdfStorageKey: record.pdfStorageKey,
      overallScore: record.overallScore,
      hasTranscription: !!record.transcriptionText,
      hasFeedbackText: !!record.feedbackText,
      hasContentJson: !!record.contentJson,
      generatedAt: record.generatedAt
    };
  } catch (error: any) {
    logger.error('Failed to upsert feedback document', {
      interviewId,
      error: error.message
    });
    throw error;
  }
}

/**
 * Get feedback document for an interview
 * 
 * @param interviewId - The interview ID
 * @returns FeedbackDocument or null if not found
 */
export async function getFeedbackDocument(interviewId: string) {
  try {
    const record = await prisma.feedbackDocument.findUnique({
      where: { interviewId }
    });

    if (!record) {
      return null;
    }

    return {
      id: record.id,
      interviewId: record.interviewId,
      userId: record.userId,
      transcriptionText: record.transcriptionText,
      feedbackText: record.feedbackText,
      contentJson: record.contentJson as StructuredFeedback | null,
      pdfStorageKey: record.pdfStorageKey,
      overallScore: record.overallScore,
      schemaVersion: record.schemaVersion,
      promptVersion: record.promptVersion,
      model: record.model,
      generatedAt: record.generatedAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    };
  } catch (error: any) {
    logger.error('Failed to get feedback document', {
      interviewId,
      error: error.message
    });
    throw error;
  }
}

/**
 * Check if a feedback document exists for an interview
 * 
 * @param interviewId - The interview ID
 * @returns true if exists, false otherwise
 */
export async function hasFeedbackDocument(interviewId: string): Promise<boolean> {
  try {
    const count = await prisma.feedbackDocument.count({
      where: { interviewId }
    });
    return count > 0;
  } catch (error: any) {
    logger.error('Failed to check feedback document existence', {
      interviewId,
      error: error.message
    });
    return false;
  }
}

/**
 * Get the PDF storage key for a feedback document
 * Returns null if no document or no storage key exists
 * 
 * @param interviewId - The interview ID
 * @returns storageKey or null
 */
export async function getFeedbackPdfStorageKey(interviewId: string): Promise<string | null> {
  try {
    const record = await prisma.feedbackDocument.findUnique({
      where: { interviewId },
      select: { pdfStorageKey: true }
    });
    return record?.pdfStorageKey ?? null;
  } catch (error: any) {
    logger.warn('Failed to get feedback PDF storage key', {
      interviewId,
      error: error.message
    });
    return null;
  }
}

/**
 * Update just the storage key for a feedback document
 * Creates the document if it doesn't exist (requires userId)
 * 
 * @param interviewId - The interview ID
 * @param storageKey - The Azure Blob storage key for the PDF
 * @param userId - Required if creating a new document
 */
export async function updateFeedbackPdfStorageKey(
  interviewId: string,
  storageKey: string,
  userId?: string
): Promise<void> {
  try {
    // Try to update first
    const result = await prisma.feedbackDocument.updateMany({
      where: { interviewId },
      data: { pdfStorageKey: storageKey, generatedAt: new Date() }
    });

    if (result.count === 0 && userId) {
      // Document doesn't exist, create it with minimal data
      await prisma.feedbackDocument.create({
        data: {
          interviewId,
          userId,
          pdfStorageKey: storageKey,
          generatedAt: new Date()
        }
      });
      logger.info('Created feedback document with storage key', { interviewId });
    } else if (result.count > 0) {
      logger.info('Updated feedback document storage key', { interviewId });
    }

    const doc = await prisma.feedbackDocument.findUnique({
      where: { interviewId },
      select: { id: true }
    });

    if (doc?.id) {
      await prisma.interview.updateMany({
        where: { id: interviewId, feedbackDocumentId: null },
        data: { feedbackDocumentId: doc.id }
      });
    }
  } catch (error: any) {
    logger.error('Failed to update feedback PDF storage key', {
      interviewId,
      error: error.message
    });
    throw error;
  }
}

// ========================================
// BATCH OPERATIONS
// ========================================

/**
 * Get feedback documents for multiple interviews
 * Useful for list views to show feedback availability
 * 
 * @param interviewIds - Array of interview IDs
 * @returns Map of interviewId to basic document info
 */
export async function getFeedbackDocumentsBatch(
  interviewIds: string[]
): Promise<Map<string, { hasDocument: boolean; hasStorageKey: boolean }>> {
  const result = new Map<string, { hasDocument: boolean; hasStorageKey: boolean }>();
  
  // Initialize all as not having document
  interviewIds.forEach(id => {
    result.set(id, { hasDocument: false, hasStorageKey: false });
  });

  if (interviewIds.length === 0) {
    return result;
  }

  try {
    const documents = await prisma.feedbackDocument.findMany({
      where: { interviewId: { in: interviewIds } },
      select: { interviewId: true, pdfStorageKey: true }
    });

    documents.forEach(doc => {
      result.set(doc.interviewId, {
        hasDocument: true,
        hasStorageKey: !!doc.pdfStorageKey
      });
    });
  } catch (error: any) {
    logger.warn('Failed to batch fetch feedback documents', {
      count: interviewIds.length,
      error: error.message
    });
  }

  return result;
}
