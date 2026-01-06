/**
 * Interview Service
 * Handles interview-related database operations
 */

import { prisma, dbLogger } from './databaseService';
import { Prisma, InterviewStatus } from '@prisma/client';
import { sendInterviewCompleteEmail } from './transactionalEmailService';

// ========================================
// INTERVIEW CRUD OPERATIONS
// ========================================

interface CreateInterviewData {
  userId: string; // DB UUID
  jobTitle: string;
  seniority?: string; // Candidate seniority: intern, junior, mid, senior, staff, principal
  companyName: string;
  jobDescription: string;
  resumeId: string; // UUID reference to ResumeDocument (resume stored in Azure Blob)
  language?: string; // Interview language code
  country?: string; // Job location country code (e.g., 'US', 'BR')
}

interface UpdateInterviewData {
  retellCallId?: string;
  status?: InterviewStatus;
  score?: number;
  feedbackText?: string;
  callDuration?: number;
  startedAt?: Date;
  endedAt?: Date;
}

interface InterviewQueryOptions {
  page?: number;
  limit?: number;
  status?: InterviewStatus;
  sortBy?: 'createdAt' | 'score' | 'companyName';
  sortOrder?: 'asc' | 'desc';
}

/**
 * Create a new interview
 */
export async function createInterview(data: CreateInterviewData) {
  dbLogger.info('Creating new interview', { 
    userId: data.userId, 
    jobTitle: data.jobTitle,
    company: data.companyName 
  });

  // User ID is the DB UUID (session auth)
  const resolvedUserId = data.userId;

  const interview = await prisma.interview.create({
    data: {
      userId: resolvedUserId,
      jobTitle: data.jobTitle,
      seniority: data.seniority || 'mid',
      companyName: data.companyName,
      jobDescription: data.jobDescription,
      resumeId: data.resumeId, // Foreign key to ResumeDocument
      language: data.language || 'en-US',
      roleCountryCode: data.country || null,
      status: 'PENDING'
    }
  });

  dbLogger.info('Interview created', { interviewId: interview.id });
  return interview;
}

/**
 * Get interview by ID
 */
export async function getInterviewById(id: string) {
  return prisma.interview.findUnique({
    where: { id },
    include: {
      user: {
        select: {
          id: true,
          
          firstName: true,
          lastName: true,
          email: true
        }
      },
      metrics: true
    }
  });
}

/**
 * Get interview by Retell Call ID
 */
export async function getInterviewByRetellCallId(retellCallId: string) {
  return prisma.interview.findUnique({
    where: { retellCallId },
    include: {
      user: {
        select: {
          id: true,
          
          firstName: true,
          lastName: true
        }
      },
      metrics: true
    }
  });
}

/**
 * Get user's interviews with pagination
 */
export async function getUserInterviews(
  userId: string,
  options: InterviewQueryOptions = {}
) {
  const {
    page = 1,
    limit = 10,
    status,
    sortBy = 'createdAt',
    sortOrder = 'desc'
  } = options;

  const skip = (page - 1) * limit;

  // Build where clause
  const where: Prisma.InterviewWhereInput = {
    user: { id: userId }
  };

  if (status) {
    where.status = status;
  }

  // Get total count
  const total = await prisma.interview.count({ where });

  // Get interviews with hasFeedback computed field
  // OPTIMIZATION: Use raw SQL to check feedback existence without fetching the blob
  const interviews = await prisma.$queryRaw<Array<{
    id: string;
    jobTitle: string;
    companyName: string;
    status: string;
    score: number | null;
    callDuration: number | null;
    createdAt: Date;
    startedAt: Date | null;
    endedAt: Date | null;
    seniority: string | null;
    language: string | null;
    hasFeedback: boolean;
  }>>`
    SELECT 
      id,
      job_title as "jobTitle",
      company_name as "companyName",
      status,
      score,
      call_duration as "callDuration",
      created_at as "createdAt",
      started_at as "startedAt",
      ended_at as "endedAt",
      seniority,
      language,
      (feedback_document_id IS NOT NULL) as "hasFeedback"
    FROM interviews
    WHERE user_id = ${userId}
    ${status ? Prisma.sql`AND status = ${status}` : Prisma.empty}
    ORDER BY ${Prisma.raw(`${sortBy === 'createdAt' ? 'created_at' : sortBy} ${sortOrder.toUpperCase()}`)}
    LIMIT ${limit}
    OFFSET ${skip}
  `;

  return {
    interviews,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      hasMore: skip + interviews.length < total
    }
  };
}

/**
 * Update interview
 */
export async function updateInterview(id: string, data: UpdateInterviewData) {
  dbLogger.info('Updating interview', { interviewId: id, updates: Object.keys(data) });

  return prisma.interview.update({
    where: { id },
    data
  });
}

/**
 * Update interview by Retell Call ID
 */
export async function updateInterviewByRetellCallId(
  retellCallId: string, 
  data: UpdateInterviewData
) {
  dbLogger.info('Updating interview by Retell Call ID', { 
    retellCallId, 
    updates: Object.keys(data) 
  });

  return prisma.interview.update({
    where: { retellCallId },
    data
  });
}

/**
 * Start interview (update status and start time)
 */
export async function startInterview(id: string, retellCallId: string) {
  dbLogger.info('Starting interview', { interviewId: id, retellCallId });

  return prisma.interview.update({
    where: { id },
    data: {
      retellCallId,
      status: 'IN_PROGRESS',
      startedAt: new Date()
    }
  });
}

/**
 * Complete interview with results
 */
export async function completeInterview(
  retellCallId: string,
  results: {
    score?: number | null;
    feedbackText?: string;
    callDuration?: number;
  }
) {
  dbLogger.info('Completing interview', { retellCallId });

  // Import feedback parser for metrics extraction
  const { parseFeedbackSummary, convertToInterviewMetrics } = await import('../utils/feedbackParser');

  // Parse feedback to extract score if not provided (prioritize feedbackText when score is null)
  let finalScore: number | null | undefined = results.score;
  let parsedFeedback = null;

  if (results.feedbackText) {
    try {
      parsedFeedback = parseFeedbackSummary(results.feedbackText);
      
      // Prioritize: set score from feedbackText when score is null or undefined
      if (parsedFeedback.overallScore !== null && (finalScore === null || finalScore === undefined)) {
        finalScore = parsedFeedback.overallScore;
        dbLogger.info('Extracted score from feedbackText (score was null)', { 
          retellCallId, 
          extractedScore: finalScore,
          categoryScores: parsedFeedback.categoryScores 
        });
      }
    } catch (parseError: any) {
      dbLogger.warn('Failed to parse feedback text', { 
        retellCallId, 
        error: parseError.message 
      });
    }
  }

  const completedInterview = await prisma.interview.update({
    where: { retellCallId },
    data: {
      status: 'COMPLETED',
      endedAt: new Date(),
      score: finalScore ?? undefined,
      feedbackText: results.feedbackText,
      callDuration: results.callDuration
    },
    include: {
      user: {
        select: {
          id: true,
          
          email: true,
          firstName: true,
          lastName: true,
          preferredLanguage: true
        }
      }
    }
  });

  // ========================================
  // SAVE INTERVIEW METRICS (non-blocking)
  // ========================================
  if (parsedFeedback && parsedFeedback.categoryScores && Object.keys(parsedFeedback.categoryScores).length > 0) {
    try {
      const metrics = convertToInterviewMetrics(parsedFeedback, completedInterview.id);
      
      if (metrics.length > 0) {
        await addInterviewMetrics(completedInterview.id, metrics);
        dbLogger.info('Interview metrics saved', { 
          interviewId: completedInterview.id,
          metricsCount: metrics.length 
        });
      }
    } catch (metricsError: any) {
      // Non-blocking - interview is still complete even if metrics fail
      dbLogger.warn('Failed to save interview metrics', { 
        interviewId: completedInterview.id,
        error: metricsError.message 
      });
    }
  }

  // ========================================
  // PERSIST TRANSCRIPT SEGMENTS (non-blocking)
  // ========================================
  try {
    const { RetellService } = await import('./retellService');
    const retellService = new RetellService(process.env.RETELL_API_KEY || '');
    const { createTranscriptSegments } = await import('./analyticsService');
    
    const callDetails = await retellService.getCall(retellCallId);
    
    if (callDetails) {
      const callDurationMs = results.callDuration || 
        ((callDetails as any).end_timestamp && (callDetails as any).start_timestamp 
          ? (callDetails as any).end_timestamp - (callDetails as any).start_timestamp 
          : 0);
      
      await createTranscriptSegments(completedInterview.id, callDetails, callDurationMs);
      dbLogger.info('Transcript segments persisted', { 
        interviewId: completedInterview.id 
      });
    }
  } catch (transcriptError: any) {
    // Non-blocking - interview is still complete even if transcript fails
    dbLogger.warn('Failed to persist transcript segments', { 
      interviewId: completedInterview.id,
      error: transcriptError.message 
    });
  }

  // ========================================
  // SEND INTERVIEW COMPLETE EMAIL (non-blocking, idempotent)
  // ========================================
  if (completedInterview.user?.email) {
    // Fire and forget
    sendInterviewCompleteEmail(completedInterview.id)
      .then(result => {
        if (result.success && !result.skipped) {
          dbLogger.info('Interview complete email sent', {
            interviewId: completedInterview.id,
            userId: completedInterview.user?.id,
            messageId: result.messageId,
          });
        } else if (result.skipped) {
          dbLogger.info('Interview complete email skipped', {
            interviewId: completedInterview.id,
            reason: result.reason,
          });
        }
      })
      .catch(err => {
        dbLogger.warn('Interview complete email failed (non-blocking)', {
          interviewId: completedInterview.id,
          error: err.message,
        });
      });
  }

  return completedInterview;
}

/**
 * Cancel interview
 */
export async function cancelInterview(id: string, reason?: string) {
  dbLogger.info('Cancelling interview', { interviewId: id, reason });

  return prisma.interview.update({
    where: { id },
    data: {
      status: 'CANCELLED',
      endedAt: new Date()
    }
  });
}

/**
 * Add metrics to interview
 */
export async function addInterviewMetrics(
  interviewId: string,
  metrics: Array<{
    category: string;
    metricName: string;
    score: number;
    maxScore?: number;
    feedback?: string;
  }>
) {
  dbLogger.info('Adding interview metrics', { 
    interviewId, 
    metricsCount: metrics.length 
  });

  return prisma.interviewMetric.createMany({
    data: metrics.map(m => ({
      interviewId,
      category: m.category,
      metricName: m.metricName,
      score: m.score,
      maxScore: m.maxScore || 10,
      feedback: m.feedback
    }))
  });
}

/**
 * Get interview statistics for dashboard
 */
export async function getInterviewStats(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true }
  });

  if (!user) {
    return null;
  }

  const stats = await prisma.interview.groupBy({
    by: ['status'],
    where: { userId: user.id },
    _count: { status: true }
  });

  const avgScore = await prisma.interview.aggregate({
    where: { 
      userId: user.id,
      status: 'COMPLETED',
      score: { not: null }
    },
    _avg: { score: true },
    _max: { score: true },
    _min: { score: true }
  });

  // Score distribution (last 30 days)
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const recentInterviews = await prisma.interview.findMany({
    where: {
      userId: user.id,
      status: 'COMPLETED',
      createdAt: { gte: thirtyDaysAgo }
    },
    select: {
      score: true,
      createdAt: true,
      companyName: true,
      jobTitle: true
    },
    orderBy: { createdAt: 'asc' }
  });

  return {
    statusCounts: stats.reduce((acc, s) => {
      acc[s.status] = s._count.status;
      return acc;
    }, {} as Record<string, number>),
    scoreStats: {
      average: avgScore._avg.score ? Math.round(avgScore._avg.score * 10) / 10 : null,
      highest: avgScore._max.score,
      lowest: avgScore._min.score
    },
    recentInterviews
  };
}

/**
 * Get interview details for PDF download
 */
export async function getInterviewForDownload(id: string, userId: string) {
  const interview = await prisma.interview.findFirst({
    where: {
      id,
      user: { id: userId }
    },
    select: {
      id: true,
      jobTitle: true,
      companyName: true,
      resumeId: true,
      resumeDocument: {
        select: {
          storageKey: true,
          fileName: true,
          mimeType: true
        }
      },
      feedbackDocument: {
        select: {
          pdfStorageKey: true
        }
      }
    }
  });

  return interview;
}

// ========================================
// CLONE & RETRY FUNCTIONALITY
// ========================================

interface CloneInterviewOptions {
  useLatestResume?: boolean;
  resumeId?: string; // From resume repository
  updateJobDescription?: string;
}

/**
 * Clone an interview to retry with same job details
 * Creates a new interview with the same job info but fresh status
 */
export async function cloneInterview(
  originalInterviewId: string,
  userId: string,
  options: CloneInterviewOptions = {}
) {
  dbLogger.info('Cloning interview', { originalInterviewId, userId });
  
  // Get original interview
  const original = await prisma.interview.findFirst({
    where: {
      id: originalInterviewId,
      user: { id: userId }
    },
    select: {
      userId: true,
      jobTitle: true,
      seniority: true,
      companyName: true,
      jobDescription: true,
      resumeId: true
    }
  });
  
  if (!original) {
    throw new Error('Original interview not found');
  }
  
  // Determine resume to use
  let resumeId = original.resumeId;
  
  if (options.resumeId) {
    // Use resume from repository
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true }
    });
    
    if (user) {
      const resume = await prisma.resumeDocument?.findFirst({
        where: {
          id: options.resumeId,
          userId: user.id,
          isActive: true
        },
        select: {
          id: true
        }
      });
      
      if (resume) {
        resumeId = resume.id;
      }
    }
  } else if (options.useLatestResume) {
    // Use latest (primary) resume from repository
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true }
    });
    
    if (user) {
      const primaryResume = await prisma.resumeDocument?.findFirst({
        where: {
          userId: user.id,
          isPrimary: true,
          isActive: true
        },
        select: {
          id: true
        }
      });
      
      if (primaryResume) {
        resumeId = primaryResume.id;
      }
    }
  }
  
  // Create cloned interview
  const clonedInterview = await prisma.interview.create({
    data: {
      userId: original.userId,
      jobTitle: original.jobTitle,
      seniority: original.seniority,
      companyName: original.companyName,
      jobDescription: options.updateJobDescription || original.jobDescription,
      resumeId,
      status: 'PENDING'
    }
  });
  
  dbLogger.info('Interview cloned', { 
    originalId: originalInterviewId, 
    newId: clonedInterview.id 
  });
  
  return clonedInterview;
}

/**
 * Get suggested retake candidates (interviews that could benefit from practice)
 */
export async function getSuggestedRetakes(
  userId: string,
  limit: number = 5
) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true }
  });
  
  if (!user) return [];
  
  // Find completed interviews with low scores (under 70)
  const lowScoreInterviews = await prisma.interview.findMany({
    where: {
      userId: user.id,
      status: 'COMPLETED',
      score: { lt: 70, not: null }
    },
    select: {
      id: true,
      jobTitle: true,
      companyName: true,
      score: true,
      createdAt: true
    },
    orderBy: { score: 'asc' },
    take: limit
  });
  
  return lowScoreInterviews.map(interview => ({
    ...interview,
    reason: 'Score below 70 - practice recommended'
  }));
}

/**
 * Get interview history for a specific role/company combination
 */
export async function getInterviewHistory(
  userId: string,
  options: {
    jobTitle?: string;
    companyName?: string;
  }
) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true }
  });
  
  if (!user) return [];
  
  const where: Prisma.InterviewWhereInput = {
    userId: user.id,
    status: 'COMPLETED'
  };
  
  if (options.jobTitle) {
    where.jobTitle = { contains: options.jobTitle, mode: 'insensitive' };
  }
  if (options.companyName) {
    where.companyName = { contains: options.companyName, mode: 'insensitive' };
  }
  
  const interviews = await prisma.interview.findMany({
    where,
    select: {
      id: true,
      jobTitle: true,
      companyName: true,
      score: true,
      createdAt: true,
      callDuration: true
    },
    orderBy: { createdAt: 'desc' }
  });
  
  // Calculate trend
  const scores = interviews.map(i => i.score).filter((s): s is number => s !== null);
  const avgScore = scores.length > 0 
    ? scores.reduce((a, b) => a + b, 0) / scores.length 
    : null;
  
  // Score improvement (first vs last if > 1 interview)
  let scoreImprovement = null;
  if (scores.length >= 2) {
    const firstScore = scores[scores.length - 1];
    const lastScore = scores[0];
    scoreImprovement = lastScore - firstScore;
  }
  
  return {
    interviews,
    stats: {
      totalAttempts: interviews.length,
      averageScore: avgScore ? Math.round(avgScore * 10) / 10 : null,
      scoreImprovement,
      bestScore: scores.length > 0 ? Math.max(...scores) : null
    }
  };
}

/**
 * Create interview from resume repository
 */
export async function createInterviewFromResume(
  userId: string,
  resumeId: string,
  jobDetails: {
    jobTitle: string;
    companyName: string;
    jobDescription: string;
  }
) {
  dbLogger.info('Creating interview from resume repository', { 
    userId, 
    resumeId 
  });
  
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true }
  });
  
  if (!user) {
    throw new Error('User not found');
  }
  
  // Get resume from repository
  const resume = await prisma.resumeDocument?.findFirst({
    where: {
      id: resumeId,
      userId: user.id,
      isActive: true
    },
    select: {
      id: true
    }
  });
  
  if (!resume) {
    throw new Error('Resume not found in repository');
  }
  
  // Update resume lastUsedAt
  await prisma.resumeDocument.update({
    where: { id: resume.id },
    data: { lastUsedAt: new Date() }
  });
  
  // Create interview with resumeId reference
  const interview = await prisma.interview.create({
    data: {
      userId: user.id,
      jobTitle: jobDetails.jobTitle,
      companyName: jobDetails.companyName,
      jobDescription: jobDetails.jobDescription,
      resumeId: resume.id,
      status: 'PENDING'
    }
  });
  
  dbLogger.info('Interview created from resume repository', { 
    interviewId: interview.id, 
    resumeId 
  });
  
  return interview;
}
