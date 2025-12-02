/**
 * Interview Service
 * Handles interview-related database operations
 */

import { prisma, dbLogger } from './databaseService';
import { Prisma, InterviewStatus } from '@prisma/client';

// ========================================
// INTERVIEW CRUD OPERATIONS
// ========================================

interface CreateInterviewData {
  userId: string; // Can be UUID or Clerk ID
  jobTitle: string;
  companyName: string;
  jobDescription: string;
  resumeData?: string;
  resumeFileName?: string;
  resumeMimeType?: string;
}

interface UpdateInterviewData {
  retellCallId?: string;
  status?: InterviewStatus;
  score?: number;
  feedbackPdf?: string;
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

  // Resolve user ID (might be Clerk ID or UUID)
  let resolvedUserId = data.userId;
  
  if (data.userId.startsWith('user_')) {
    // It's a Clerk ID, need to find or create user
    const user = await prisma.user.findUnique({
      where: { clerkId: data.userId },
      select: { id: true }
    });
    
    if (!user) {
      throw new Error(`User not found for Clerk ID: ${data.userId}`);
    }
    
    resolvedUserId = user.id;
  }

  const interview = await prisma.interview.create({
    data: {
      userId: resolvedUserId,
      jobTitle: data.jobTitle,
      companyName: data.companyName,
      jobDescription: data.jobDescription,
      resumeData: data.resumeData,
      resumeFileName: data.resumeFileName,
      resumeMimeType: data.resumeMimeType,
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
          clerkId: true,
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
          clerkId: true,
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
  clerkId: string,
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
    user: { clerkId }
  };

  if (status) {
    where.status = status;
  }

  // Get total count
  const total = await prisma.interview.count({ where });

  // Get interviews
  const interviews = await prisma.interview.findMany({
    where,
    skip,
    take: limit,
    orderBy: { [sortBy]: sortOrder },
    select: {
      id: true,
      jobTitle: true,
      companyName: true,
      status: true,
      score: true,
      callDuration: true,
      createdAt: true,
      startedAt: true,
      endedAt: true,
      feedbackPdf: true // Include to know if feedback exists
    }
  });

  // Transform to include hasFeedback flag instead of full PDF
  const transformedInterviews = interviews.map(i => ({
    ...i,
    hasFeedback: !!i.feedbackPdf,
    feedbackPdf: undefined // Remove actual PDF from list response
  }));

  return {
    interviews: transformedInterviews,
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
    score?: number;
    feedbackPdf?: string;
    feedbackText?: string;
    callDuration?: number;
  }
) {
  dbLogger.info('Completing interview', { retellCallId });

  return prisma.interview.update({
    where: { retellCallId },
    data: {
      status: 'COMPLETED',
      endedAt: new Date(),
      ...results
    }
  });
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
export async function getInterviewStats(clerkId: string) {
  const user = await prisma.user.findUnique({
    where: { clerkId },
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
export async function getInterviewForDownload(id: string, clerkId: string) {
  const interview = await prisma.interview.findFirst({
    where: {
      id,
      user: { clerkId }
    },
    select: {
      id: true,
      jobTitle: true,
      companyName: true,
      feedbackPdf: true,
      resumeData: true,
      resumeFileName: true,
      resumeMimeType: true
    }
  });

  return interview;
}
