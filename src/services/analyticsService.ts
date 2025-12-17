/**
 * Analytics Service
 * Historical Score Engine and Time-Series Analytics
 * 
 * Features:
 * - Score tracking by role and company
 * - Time-series aggregation (daily/weekly/monthly)
 * - Percentile calculations
 * - Interview volume analytics
 * - Usage logging
 */

import { prisma, dbLogger } from './databaseService';
import { Prisma } from '@prisma/client';

// ========================================
// TYPES
// ========================================

export type TimePeriod = 'daily' | 'weekly' | 'monthly';

export interface ScoreByRole {
  role: string;
  avgScore: number;
  count: number;
  trend: number; // Percentage change from previous period
  bestScore: number;
  worstScore: number;
}

export interface ScoreByCompany {
  company: string;
  avgScore: number;
  count: number;
  trend: number;
  bestScore: number;
  worstScore: number;
}

export interface TimeSeriesDataPoint {
  date: string;
  value: number;
  count?: number;
}

export interface VolumeDataPoint {
  period: string;
  count: number;
}

export interface PercentileResult {
  percentile: number;
  userAvgScore: number;
  globalAvgScore: number;
  totalUsers: number;
}

export interface UsageEvent {
  userId: string;
  eventType: string;
  eventData?: Record<string, any>;
}

// ========================================
// SCORE HISTORY MANAGEMENT
// ========================================

/**
 * Record interview score in history
 * Called after interview completion
 */
export async function recordInterviewScore(
  userId: string,
  interviewId: string,
  role: string,
  company: string,
  scores: {
    overall: number;
    technical?: number;
    communication?: number;
    confidence?: number;
  },
  callDuration?: number
) {
  try {
    const record = await prisma.interviewScoreHistory.create({
      data: {
        userId,
        interviewId,
        role: normalizeRole(role),
        company: normalizeCompany(company),
        overallScore: scores.overall,
        technicalScore: scores.technical,
        communicationScore: scores.communication,
        confidenceScore: scores.confidence,
        callDuration
      }
    });

    dbLogger.info('Interview score recorded in history', {
      userId,
      interviewId,
      role: record.role,
      score: scores.overall
    });

    // Also log as usage event
    await logUsageEvent({
      userId,
      eventType: 'interview_completed',
      eventData: {
        interviewId,
        role: record.role,
        company: record.company,
        score: scores.overall
      }
    });

    return record;
  } catch (error: any) {
    dbLogger.error('Failed to record interview score', {
      userId,
      interviewId,
      error: error.message
    });
    throw error;
  }
}

/**
 * Normalize role/job title for consistent grouping
 */
function normalizeRole(role: string): string {
  const normalized = role.toLowerCase().trim();
  
  // Common role mappings
  const roleMappings: Record<string, string> = {
    'software engineer': 'Software Engineer',
    'swe': 'Software Engineer',
    'software developer': 'Software Engineer',
    'frontend developer': 'Frontend Engineer',
    'frontend engineer': 'Frontend Engineer',
    'front-end developer': 'Frontend Engineer',
    'backend developer': 'Backend Engineer',
    'backend engineer': 'Backend Engineer',
    'back-end developer': 'Backend Engineer',
    'fullstack developer': 'Full Stack Engineer',
    'full stack developer': 'Full Stack Engineer',
    'full-stack developer': 'Full Stack Engineer',
    'product manager': 'Product Manager',
    'pm': 'Product Manager',
    'project manager': 'Project Manager',
    'data scientist': 'Data Scientist',
    'data analyst': 'Data Analyst',
    'ml engineer': 'ML Engineer',
    'machine learning engineer': 'ML Engineer',
    'devops engineer': 'DevOps Engineer',
    'sre': 'SRE',
    'site reliability engineer': 'SRE',
    'ux designer': 'UX Designer',
    'ui designer': 'UI Designer',
    'ux/ui designer': 'UX/UI Designer',
  };

  // Check for exact match
  if (roleMappings[normalized]) {
    return roleMappings[normalized];
  }

  // Check for partial matches
  for (const [key, value] of Object.entries(roleMappings)) {
    if (normalized.includes(key)) {
      return value;
    }
  }

  // Return original with proper casing
  return role.split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Normalize company name for consistent grouping
 */
function normalizeCompany(company: string): string {
  // Remove common suffixes
  let normalized = company.trim()
    .replace(/\s*(Inc\.|Inc|LLC|Ltd\.|Ltd|Corp\.|Corp|Co\.|Co|PLC|GmbH|S\.A\.|SA)\.?$/i, '')
    .trim();

  // Capitalize first letter of each word
  return normalized.split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

// ========================================
// SCORE ANALYTICS
// ========================================

/**
 * Get scores grouped by role
 */
export async function getScoresByRole(
  clerkId: string,
  options: {
    startDate?: Date;
    endDate?: Date;
    role?: string;
    limit?: number;
  } = {}
): Promise<ScoreByRole[]> {
  const { startDate, endDate, role, limit = 10 } = options;

  // First get the user's UUID from clerkId
  const user = await prisma.user.findUnique({
    where: { clerkId },
    select: { id: true }
  });

  if (!user) {
    return [];
  }

  // Build where clause
  const where: Prisma.InterviewScoreHistoryWhereInput = {
    userId: user.id
  };

  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = startDate;
    if (endDate) where.createdAt.lte = endDate;
  }

  if (role) {
    where.role = role;
  }

  // Get current period scores
  const currentScores = await prisma.interviewScoreHistory.groupBy({
    by: ['role'],
    where,
    _avg: { overallScore: true },
    _count: { id: true },
    _max: { overallScore: true },
    _min: { overallScore: true }
  });

  // Calculate trends (compare to previous period)
  const periodLength = startDate && endDate 
    ? endDate.getTime() - startDate.getTime()
    : 30 * 24 * 60 * 60 * 1000; // Default 30 days

  const previousStartDate = startDate 
    ? new Date(startDate.getTime() - periodLength)
    : new Date(Date.now() - 2 * periodLength);
  const previousEndDate = startDate || new Date(Date.now() - periodLength);

  const previousScores = await prisma.interviewScoreHistory.groupBy({
    by: ['role'],
    where: {
      userId: user.id,
      createdAt: {
        gte: previousStartDate,
        lt: previousEndDate
      }
    },
    _avg: { overallScore: true }
  });

  const previousScoreMap = new Map(
    previousScores.map(s => [s.role, s._avg.overallScore || 0])
  );

  // Transform results
  const results: ScoreByRole[] = currentScores.map(score => {
    const previousAvg = previousScoreMap.get(score.role) || 0;
    const currentAvg = score._avg.overallScore || 0;
    const trend = previousAvg > 0 
      ? Math.round(((currentAvg - previousAvg) / previousAvg) * 100)
      : 0;

    return {
      role: score.role,
      avgScore: Math.round(currentAvg * 10) / 10,
      count: score._count.id,
      trend,
      bestScore: score._max.overallScore || 0,
      worstScore: score._min.overallScore || 0
    };
  });

  // Sort by count and limit
  return results
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

/**
 * Get scores grouped by company
 */
export async function getScoresByCompany(
  clerkId: string,
  options: {
    startDate?: Date;
    endDate?: Date;
    company?: string;
    limit?: number;
  } = {}
): Promise<ScoreByCompany[]> {
  const { startDate, endDate, company, limit = 10 } = options;

  const user = await prisma.user.findUnique({
    where: { clerkId },
    select: { id: true }
  });

  if (!user) {
    return [];
  }

  const where: Prisma.InterviewScoreHistoryWhereInput = {
    userId: user.id
  };

  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = startDate;
    if (endDate) where.createdAt.lte = endDate;
  }

  if (company) {
    where.company = company;
  }

  const currentScores = await prisma.interviewScoreHistory.groupBy({
    by: ['company'],
    where,
    _avg: { overallScore: true },
    _count: { id: true },
    _max: { overallScore: true },
    _min: { overallScore: true }
  });

  // Calculate trends
  const periodLength = startDate && endDate 
    ? endDate.getTime() - startDate.getTime()
    : 30 * 24 * 60 * 60 * 1000;

  const previousStartDate = startDate 
    ? new Date(startDate.getTime() - periodLength)
    : new Date(Date.now() - 2 * periodLength);
  const previousEndDate = startDate || new Date(Date.now() - periodLength);

  const previousScores = await prisma.interviewScoreHistory.groupBy({
    by: ['company'],
    where: {
      userId: user.id,
      createdAt: {
        gte: previousStartDate,
        lt: previousEndDate
      }
    },
    _avg: { overallScore: true }
  });

  const previousScoreMap = new Map(
    previousScores.map(s => [s.company, s._avg.overallScore || 0])
  );

  const results: ScoreByCompany[] = currentScores.map(score => {
    const previousAvg = previousScoreMap.get(score.company) || 0;
    const currentAvg = score._avg.overallScore || 0;
    const trend = previousAvg > 0 
      ? Math.round(((currentAvg - previousAvg) / previousAvg) * 100)
      : 0;

    return {
      company: score.company,
      avgScore: Math.round(currentAvg * 10) / 10,
      count: score._count.id,
      trend,
      bestScore: score._max.overallScore || 0,
      worstScore: score._min.overallScore || 0
    };
  });

  return results
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

/**
 * Get score history as time series
 */
export async function getScoreTimeSeries(
  clerkId: string,
  period: TimePeriod = 'weekly',
  options: {
    months?: number;
    role?: string;
    company?: string;
  } = {}
): Promise<TimeSeriesDataPoint[]> {
  const { months = 6, role, company } = options;

  const user = await prisma.user.findUnique({
    where: { clerkId },
    select: { id: true }
  });

  if (!user) {
    return [];
  }

  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - months);

  const where: Prisma.InterviewScoreHistoryWhereInput = {
    userId: user.id,
    createdAt: { gte: startDate }
  };

  if (role) where.role = role;
  if (company) where.company = company;

  const scores = await prisma.interviewScoreHistory.findMany({
    where,
    select: {
      overallScore: true,
      createdAt: true
    },
    orderBy: { createdAt: 'asc' }
  });

  // Group by period
  const grouped = new Map<string, { sum: number; count: number }>();

  for (const score of scores) {
    const periodKey = getPeriodKey(score.createdAt, period);
    const existing = grouped.get(periodKey) || { sum: 0, count: 0 };
    grouped.set(periodKey, {
      sum: existing.sum + score.overallScore,
      count: existing.count + 1
    });
  }

  // Convert to array
  return Array.from(grouped.entries()).map(([date, data]) => ({
    date,
    value: Math.round((data.sum / data.count) * 10) / 10,
    count: data.count
  }));
}

/**
 * Get period key for grouping
 */
function getPeriodKey(date: Date, period: TimePeriod): string {
  switch (period) {
    case 'daily':
      return date.toISOString().split('T')[0];
    case 'weekly':
      const weekStart = new Date(date);
      weekStart.setDate(date.getDate() - date.getDay());
      return weekStart.toISOString().split('T')[0];
    case 'monthly':
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    default:
      return date.toISOString().split('T')[0];
  }
}

// ========================================
// VOLUME ANALYTICS
// ========================================

/**
 * Get interview volume over time
 */
export async function getInterviewVolume(
  clerkId: string,
  period: TimePeriod = 'monthly',
  options: {
    months?: number;
    role?: string;
  } = {}
): Promise<VolumeDataPoint[]> {
  const { months = 6, role } = options;

  const user = await prisma.user.findUnique({
    where: { clerkId },
    select: { id: true }
  });

  if (!user) {
    return [];
  }

  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - months);

  const where: Prisma.InterviewWhereInput = {
    userId: user.id,
    createdAt: { gte: startDate },
    status: 'COMPLETED'
  };

  if (role) {
    where.jobTitle = { contains: role, mode: 'insensitive' };
  }

  const interviews = await prisma.interview.findMany({
    where,
    select: { createdAt: true },
    orderBy: { createdAt: 'asc' }
  });

  // Group by period
  const grouped = new Map<string, number>();

  for (const interview of interviews) {
    const periodKey = getPeriodKey(interview.createdAt, period);
    grouped.set(periodKey, (grouped.get(periodKey) || 0) + 1);
  }

  return Array.from(grouped.entries()).map(([periodLabel, count]) => ({
    period: periodLabel,
    count
  }));
}

// ========================================
// PERCENTILE CALCULATIONS
// ========================================

/**
 * Calculate user's percentile ranking
 */
export async function getUserPercentile(
  clerkId: string,
  options: {
    role?: string;
    months?: number;
  } = {}
): Promise<PercentileResult> {
  const { role, months = 3 } = options;

  const user = await prisma.user.findUnique({
    where: { clerkId },
    select: { id: true }
  });

  if (!user) {
    return {
      percentile: 0,
      userAvgScore: 0,
      globalAvgScore: 0,
      totalUsers: 0
    };
  }

  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - months);

  const roleFilter = role ? { role } : {};

  // Get user's average score
  const userScore = await prisma.interviewScoreHistory.aggregate({
    where: {
      userId: user.id,
      createdAt: { gte: startDate },
      ...roleFilter
    },
    _avg: { overallScore: true }
  });

  const userAvgScore = userScore._avg.overallScore || 0;

  // Get all users' average scores for comparison
  const allUserScores = await prisma.interviewScoreHistory.groupBy({
    by: ['userId'],
    where: {
      createdAt: { gte: startDate },
      ...roleFilter
    },
    _avg: { overallScore: true }
  });

  // Calculate percentile
  const sortedScores = allUserScores
    .map(s => s._avg.overallScore || 0)
    .sort((a, b) => a - b);

  const userPosition = sortedScores.filter(s => s < userAvgScore).length;
  const percentile = sortedScores.length > 0
    ? Math.round((userPosition / sortedScores.length) * 100)
    : 50;

  // Calculate global average
  const globalAvgScore = sortedScores.length > 0
    ? sortedScores.reduce((a, b) => a + b, 0) / sortedScores.length
    : 0;

  return {
    percentile,
    userAvgScore: Math.round(userAvgScore * 10) / 10,
    globalAvgScore: Math.round(globalAvgScore * 10) / 10,
    totalUsers: allUserScores.length
  };
}

// ========================================
// USAGE LOGGING
// ========================================

/**
 * Log a usage event
 */
export async function logUsageEvent(event: UsageEvent) {
  try {
    // Get user UUID from clerkId if necessary
    let userId = event.userId;
    if (userId.startsWith('user_')) {
      const user = await prisma.user.findUnique({
        where: { clerkId: userId },
        select: { id: true }
      });
      if (!user) {
        dbLogger.warn('User not found for usage event', { clerkId: userId });
        return null;
      }
      userId = user.id;
    }

    const log = await prisma.usageLog.create({
      data: {
        userId,
        eventType: event.eventType,
        eventData: event.eventData || {}
      }
    });

    return log;
  } catch (error: any) {
    dbLogger.error('Failed to log usage event', {
      event,
      error: error.message
    });
    return null;
  }
}

/**
 * Get usage summary for a user
 */
export async function getUsageSummary(
  clerkId: string,
  options: {
    startDate?: Date;
    endDate?: Date;
  } = {}
) {
  const user = await prisma.user.findUnique({
    where: { clerkId },
    select: { id: true }
  });

  if (!user) {
    return null;
  }

  const { startDate, endDate } = options;

  const where: Prisma.UsageLogWhereInput = {
    userId: user.id
  };

  if (startDate || endDate) {
    where.timestamp = {};
    if (startDate) where.timestamp.gte = startDate;
    if (endDate) where.timestamp.lte = endDate;
  }

  const events = await prisma.usageLog.groupBy({
    by: ['eventType'],
    where,
    _count: { id: true }
  });

  return events.reduce((acc, event) => {
    acc[event.eventType] = event._count.id;
    return acc;
  }, {} as Record<string, number>);
}

/**
 * Get available roles and companies for a user (for filter dropdowns)
 */
export async function getAvailableFilters(clerkId: string): Promise<{
  roles: string[];
  companies: string[];
}> {
  const user = await prisma.user.findUnique({
    where: { clerkId },
    select: { id: true }
  });

  if (!user) {
    return { roles: [], companies: [] };
  }

  const [roles, companies] = await Promise.all([
    prisma.interviewScoreHistory.findMany({
      where: { userId: user.id },
      select: { role: true },
      distinct: ['role']
    }),
    prisma.interviewScoreHistory.findMany({
      where: { userId: user.id },
      select: { company: true },
      distinct: ['company']
    })
  ]);

  return {
    roles: roles.map(r => r.role).sort(),
    companies: companies.map(c => c.company).sort()
  };
}

// ========================================
// DASHBOARD AGGREGATIONS
// ========================================

/**
 * Get comprehensive dashboard analytics
 */
export async function getDashboardAnalytics(
  clerkId: string,
  period: TimePeriod = 'monthly'
) {
  const [
    scoresByRole,
    scoresByCompany,
    scoreTimeSeries,
    interviewVolume,
    percentile,
    filters
  ] = await Promise.all([
    getScoresByRole(clerkId, { limit: 5 }),
    getScoresByCompany(clerkId, { limit: 5 }),
    getScoreTimeSeries(clerkId, period),
    getInterviewVolume(clerkId, period),
    getUserPercentile(clerkId),
    getAvailableFilters(clerkId)
  ]);

  return {
    scoresByRole,
    scoresByCompany,
    scoreTimeSeries,
    interviewVolume,
    percentile,
    filters
  };
}
