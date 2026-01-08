/**
 * Interview Routes
 *
 * REST API endpoints for interview creation and management.
 *
 * Routes:
 * - POST /api/interviews
 * - GET /api/interviews
 * - GET /api/interviews/:id
 * - PATCH /api/interviews/:id
 * - GET /api/interviews/:id/postcall-status
 * - POST /api/interviews/:id/clone
 * - GET /api/interviews/suggested-retakes
 * - GET /api/interviews/history
 * - POST /api/interviews/from-resume
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import type { InterviewStatus } from '@prisma/client';
import logger from '../utils/logger';
import { requireSession } from '../middleware/sessionAuthMiddleware';
import { prisma } from '../services/databaseService';
import * as interviewService from '../services/interviewService';
import { postCallProcessingService } from '../services/postCallProcessingService';

const router = Router();
const interviewLogger = logger.child({ component: 'interview-routes' });

const uuidSchema = z.string().uuid();

const interviewStatusSchema = z.enum([
  'PENDING',
  'IN_PROGRESS',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);

const createInterviewSchema = z.object({
  jobTitle: z.string().min(1).max(255),
  seniority: z.string().min(1).max(30).optional(),
  companyName: z.string().min(1).max(255),
  jobDescription: z.string().min(1).max(100000),
  resumeId: uuidSchema,
  language: z.string().min(2).max(10).optional(),
  country: z.string().length(2).optional(),
});

const updateInterviewSchema = z
  .object({
    retellCallId: z.string().min(1).optional(),
    status: interviewStatusSchema.optional(),
    score: z.number().min(0).max(100).optional(),
    feedbackText: z.string().max(200000).optional(),
    callDuration: z.number().int().nonnegative().optional(),
    startedAt: z.string().datetime().optional(),
    endedAt: z.string().datetime().optional(),
  })
  .strict();

const listInterviewsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  status: interviewStatusSchema.optional(),
  sortBy: z.enum(['createdAt', 'score', 'companyName']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
});

const cloneInterviewSchema = z
  .object({
    useLatestResume: z.boolean().optional(),
    resumeId: uuidSchema.optional(),
    updateJobDescription: z.string().min(1).max(100000).optional(),
  })
  .strict();

const historyQuerySchema = z.object({
  jobTitle: z.string().min(1).max(255).optional(),
  companyName: z.string().min(1).max(255).optional(),
});

const fromResumeSchema = z
  .object({
    resumeId: uuidSchema,
    jobTitle: z.string().min(1).max(255),
    companyName: z.string().min(1).max(255),
    jobDescription: z.string().min(1).max(100000),
  })
  .strict();

async function ensureInterviewOwnership(interviewId: string, userId: string) {
  const found = await prisma.interview.findFirst({
    where: { id: interviewId, userId },
    select: { id: true },
  });
  return !!found;
}

// ========================================
// ROUTES
// ========================================

/**
 * POST /api/interviews
 * Create interview record (resume is referenced by resumeId)
 */
router.post('/', requireSession, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const body = createInterviewSchema.parse(req.body);

    const interview = await interviewService.createInterview({
      userId,
      jobTitle: body.jobTitle,
      seniority: body.seniority,
      companyName: body.companyName,
      jobDescription: body.jobDescription,
      resumeId: body.resumeId,
      language: body.language,
      country: body.country,
    });

    interviewLogger.info('Interview created', {
      userId: userId.slice(0, 12),
      interviewId: interview.id,
      language: interview.language,
    });

    return res.json({
      status: 'success',
      data: interview,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation failed',
        errors: error.errors,
      });
    }

    interviewLogger.error('Error creating interview', { error: error.message });
    return res.status(500).json({
      status: 'error',
      message: 'Failed to create interview',
    });
  }
});

/**
 * GET /api/interviews
 * List interviews for current user
 */
router.get('/', requireSession, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const query = listInterviewsQuerySchema.parse(req.query);

    const result = await interviewService.getUserInterviews(userId, {
      page: query.page,
      limit: query.limit,
      status: query.status,
      sortBy: query.sortBy,
      sortOrder: query.sortOrder,
    });

    return res.json({
      status: 'success',
      data: result.interviews,
      pagination: result.pagination,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation failed',
        errors: error.errors,
      });
    }

    interviewLogger.error('Error listing interviews', { error: error.message });
    return res.status(500).json({
      status: 'error',
      message: 'Failed to list interviews',
    });
  }
});

/**
 * GET /api/interviews/suggested-retakes
 */
router.get('/suggested-retakes', requireSession, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;

    const result = await interviewService.getSuggestedRetakes(userId, Number.isFinite(limit) ? limit : 5);

    return res.json({
      status: 'success',
      data: result,
    });
  } catch (error: any) {
    interviewLogger.error('Error getting suggested retakes', { error: error.message });
    return res.status(500).json({
      status: 'error',
      message: 'Failed to get suggested retakes',
    });
  }
});

/**
 * GET /api/interviews/history
 */
router.get('/history', requireSession, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const query = historyQuerySchema.parse(req.query);

    const result = await interviewService.getInterviewHistory(userId, {
      jobTitle: query.jobTitle,
      companyName: query.companyName,
    });

    return res.json({
      status: 'success',
      data: result,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation failed',
        errors: error.errors,
      });
    }

    interviewLogger.error('Error getting interview history', { error: error.message });
    return res.status(500).json({
      status: 'error',
      message: 'Failed to get interview history',
    });
  }
});

/**
 * POST /api/interviews/from-resume
 */
router.post('/from-resume', requireSession, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const body = fromResumeSchema.parse(req.body);

    const interview = await interviewService.createInterviewFromResume(userId, body.resumeId, {
      jobTitle: body.jobTitle,
      companyName: body.companyName,
      jobDescription: body.jobDescription,
    });

    return res.json({
      status: 'success',
      data: interview,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation failed',
        errors: error.errors,
      });
    }

    interviewLogger.error('Error creating interview from resume', { error: error.message });
    return res.status(500).json({
      status: 'error',
      message: error.message || 'Failed to create interview from resume',
    });
  }
});

/**
 * GET /api/interviews/:id
 */
router.get('/:id', requireSession, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const interviewId = uuidSchema.parse(req.params.id);

    const interview = await interviewService.getInterviewById(interviewId);
    if (!interview || interview.user?.id !== userId) {
      return res.status(404).json({
        status: 'error',
        message: 'Interview not found',
      });
    }

    return res.json({
      status: 'success',
      data: interview,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation failed',
        errors: error.errors,
      });
    }

    interviewLogger.error('Error getting interview', { error: error.message });
    return res.status(500).json({
      status: 'error',
      message: 'Failed to get interview',
    });
  }
});

/**
 * PATCH /api/interviews/:id
 * Update an interview (used to link Retell call, complete, cancel, etc.)
 */
router.patch('/:id', requireSession, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const interviewId = uuidSchema.parse(req.params.id);

    const owns = await ensureInterviewOwnership(interviewId, userId);
    if (!owns) {
      return res.status(404).json({
        status: 'error',
        message: 'Interview not found',
      });
    }

    const body = updateInterviewSchema.parse(req.body);

    const updated = await interviewService.updateInterview(interviewId, {
      retellCallId: body.retellCallId,
      status: body.status as InterviewStatus | undefined,
      score: body.score,
      feedbackText: body.feedbackText,
      callDuration: body.callDuration,
      startedAt: body.startedAt ? new Date(body.startedAt) : undefined,
      endedAt: body.endedAt ? new Date(body.endedAt) : undefined,
    });

    return res.json({
      status: 'success',
      data: updated,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation failed',
        errors: error.errors,
      });
    }

    interviewLogger.error('Error updating interview', { error: error.message });
    return res.status(500).json({
      status: 'error',
      message: 'Failed to update interview',
    });
  }
});

/**
 * GET /api/interviews/:id/postcall-status
 */
router.get('/:id/postcall-status', requireSession, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const interviewId = uuidSchema.parse(req.params.id);

    const owns = await ensureInterviewOwnership(interviewId, userId);
    if (!owns) {
      return res.status(404).json({
        status: 'error',
        message: 'Interview not found',
      });
    }

    const baseStatus = await postCallProcessingService.getProcessingStatus(interviewId);

    const interview = await prisma.interview.findUnique({
      where: { id: interviewId },
      select: {
        status: true,
        feedbackText: true,
        feedbackDocumentId: true,
      },
    });

    const hasFeedback = !!(interview?.feedbackText || interview?.feedbackDocumentId);

    return res.json({
      status: 'success',
      data: {
        processingStatus: baseStatus.status,
        hasTranscript: baseStatus.hasTranscript,
        hasMetrics: baseStatus.hasMetrics,
        hasStudyPlan: baseStatus.hasStudyPlan,
        hasFeedback,
        overallScore: baseStatus.overallScore,
        interviewStatus: interview?.status || 'PENDING',
      },
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation failed',
        errors: error.errors,
      });
    }

    interviewLogger.error('Error getting postcall status', { error: error.message });
    return res.status(500).json({
      status: 'error',
      message: 'Failed to get postcall status',
    });
  }
});

/**
 * POST /api/interviews/:id/clone
 */
router.post('/:id/clone', requireSession, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const originalId = uuidSchema.parse(req.params.id);
    const body = cloneInterviewSchema.parse(req.body ?? {});

    const interview = await interviewService.cloneInterview(originalId, userId, body);

    return res.json({
      status: 'success',
      data: interview,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation failed',
        errors: error.errors,
      });
    }

    interviewLogger.error('Error cloning interview', { error: error.message });
    return res.status(500).json({
      status: 'error',
      message: error.message || 'Failed to clone interview',
    });
  }
});

// ========================================
// INTERVIEW MEDIA ROUTES
// ========================================

import * as interviewMediaService from '../services/interviewMediaService';

const mediaUploadSchema = z.object({
  mimeType: z.string().min(1).max(100),
  sizeBytes: z.number().int().positive().max(500 * 1024 * 1024), // Max 500MB
});

const mediaCompleteSchema = z.object({
  blobKey: z.string().min(1).max(500),
  mimeType: z.string().min(1).max(100),
  sizeBytes: z.number().int().positive(),
  durationSec: z.number().int().nonnegative().optional(),
});

/**
 * POST /api/interviews/:id/media/upload-url
 * Generate a SAS URL for uploading interview media
 */
router.post('/:id/media/upload-url', requireSession, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const interviewId = uuidSchema.parse(req.params.id);
    const body = mediaUploadSchema.parse(req.body);

    const result = await interviewMediaService.getUploadUrl({
      userId,
      interviewId,
      mimeType: body.mimeType,
      sizeBytes: body.sizeBytes,
    });

    if (!result.success) {
      return res.status(400).json({
        status: 'error',
        message: result.error,
      });
    }

    return res.json({
      status: 'success',
      data: {
        uploadUrl: result.uploadUrl,
        blobKey: result.blobKey,
        mediaId: result.mediaId,
        expiresAt: result.expiresAt?.toISOString(),
        headers: result.headers,
      },
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation failed',
        errors: error.errors,
      });
    }

    interviewLogger.error('Error generating media upload URL', { error: error.message });
    return res.status(500).json({
      status: 'error',
      message: 'Failed to generate upload URL',
    });
  }
});

/**
 * POST /api/interviews/:id/media/complete
 * Mark media upload as complete
 */
router.post('/:id/media/complete', requireSession, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const interviewId = uuidSchema.parse(req.params.id);
    const body = mediaCompleteSchema.parse(req.body);

    const result = await interviewMediaService.completeUpload({
      userId,
      interviewId,
      blobKey: body.blobKey,
      mimeType: body.mimeType,
      sizeBytes: body.sizeBytes,
      durationSec: body.durationSec,
    });

    if (!result.success) {
      return res.status(400).json({
        status: 'error',
        message: result.error,
      });
    }

    return res.json({
      status: 'success',
      data: {
        mediaId: result.mediaId,
      },
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation failed',
        errors: error.errors,
      });
    }

    interviewLogger.error('Error completing media upload', { error: error.message });
    return res.status(500).json({
      status: 'error',
      message: 'Failed to complete upload',
    });
  }
});

/**
 * GET /api/interviews/:id/media
 * Get media info for an interview
 */
router.get('/:id/media', requireSession, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const interviewId = uuidSchema.parse(req.params.id);

    const media = await interviewMediaService.getMediaInfo(userId, interviewId);

    if (!media) {
      return res.json({
        status: 'success',
        data: null,
      });
    }

    return res.json({
      status: 'success',
      data: {
        id: media.id,
        status: media.status,
        mimeType: media.mimeType,
        sizeBytes: media.sizeBytes,
        durationSec: media.durationSec,
        downloadUrl: media.downloadUrl,
        createdAt: media.createdAt.toISOString(),
      },
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid interview ID',
      });
    }

    interviewLogger.error('Error getting media info', { error: error.message });
    return res.status(500).json({
      status: 'error',
      message: 'Failed to get media info',
    });
  }
});

/**
 * GET /api/interviews/:id/media/download
 * Get a signed download URL for interview media
 */
router.get('/:id/media/download', requireSession, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const interviewId = uuidSchema.parse(req.params.id);

    const downloadUrl = await interviewMediaService.getDownloadUrl(userId, interviewId);

    if (!downloadUrl) {
      return res.status(404).json({
        status: 'error',
        message: 'Media not found or not available',
      });
    }

    return res.json({
      status: 'success',
      data: {
        downloadUrl,
      },
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid interview ID',
      });
    }

    interviewLogger.error('Error getting media download URL', { error: error.message });
    return res.status(500).json({
      status: 'error',
      message: 'Failed to get download URL',
    });
  }
});

/**
 * POST /api/interviews/:id/media/fail
 * Mark media upload as failed (for retry)
 */
router.post('/:id/media/fail', requireSession, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const interviewId = uuidSchema.parse(req.params.id);

    await interviewMediaService.failUpload(userId, interviewId);

    return res.json({
      status: 'success',
    });
  } catch (error: any) {
    interviewLogger.error('Error marking media as failed', { error: error.message });
    return res.status(500).json({
      status: 'error',
      message: 'Failed to update media status',
    });
  }
});

export default router;
