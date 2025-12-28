/**
 * Candidate Dashboard Service
 * 
 * Unified service for B2C candidate dashboard providing:
 * - Aggregated KPIs (interviews, scores, spending, credits)
 * - Filterable interview data by date range, role, seniority, resume
 * - Score evolution charts
 * - Resume utilization stats
 * 
 * This service consolidates multiple API calls into a single endpoint
 * to prevent frontend request waterfall and reduce latency.
 * 
 * @module services/candidateDashboardService
 */

import logger from '../utils/logger';
import { PrismaClient, InterviewStatus } from '@prisma/client';

const prisma = new PrismaClient();

const dashboardLogger = logger.child({ component: 'candidate-dashboard' });

// ========================================
// INTERFACES
// ========================================

export interface DashboardFilters {
  startDate?: Date;
  endDate?: Date;
  roleTitle?: string;
  seniority?: string;
  resumeId?: string;
}

export interface DashboardKPIs {
  totalInterviews: number;
  completedInterviews: number;
  averageScore: number | null;
  scoreChange: number | null; // Percentage change from previous period
  averageDurationMinutes: number | null;
  totalSpent: number;
  creditsRemaining: number;
  interviewsThisMonth: number;
  passRate: number | null; // Percentage of interviews with score >= 70
}

export interface ScoreEvolutionPoint {
  date: string; // ISO date string
  score: number;
  roleTitle: string;
  seniority: string | null;
}

export interface RecentInterview {
  id: string;
  date: string;
  roleTitle: string;
  companyName: string;
  seniority: string | null;
  resumeTitle: string | null;
  resumeId: string | null;
  durationMinutes: number | null;
  score: number | null;
  status: string;
}

export interface ResumeUtilization {
  id: string;
  title: string;
  fileName: string;
  createdAt: string;
  lastUsedAt: string | null;
  interviewCount: number; // Total interviews using this resume
  filteredInterviewCount: number; // Interviews using this resume under current filters
  isPrimary: boolean;
  qualityScore: number | null;
}

export interface FilterOptions {
  roleTitles: string[];
  seniorities: string[];
  resumes: Array<{ id: string; title: string }>;
}

export interface CandidateDashboardResponse {
  kpis: DashboardKPIs;
  scoreEvolution: ScoreEvolutionPoint[];
  recentInterviews: RecentInterview[];
  resumes: ResumeUtilization[];
  filterOptions: FilterOptions;
  filters: {
    startDate: string | null;
    endDate: string | null;
    roleTitle: string | null;
    seniority: string | null;
    resumeId: string | null;
  };
}

// ========================================
// HELPER FUNCTIONS
// ========================================

/**
 * Build Prisma where clause for interview filtering
 */
function buildInterviewWhereClause(
  userId: string,
  filters: DashboardFilters
): Record<string, unknown> {
  const where: Record<string, unknown> = {
    userId,
    status: InterviewStatus.COMPLETED,
  };

  if (filters.startDate) {
    where.endedAt = { ...((where.endedAt as object) || {}), gte: filters.startDate };
  }

  if (filters.endDate) {
    where.endedAt = { ...((where.endedAt as object) || {}), lte: filters.endDate };
  }

  if (filters.roleTitle) {
    where.jobTitle = filters.roleTitle;
  }

  if (filters.seniority) {
    where.seniority = filters.seniority;
  }

  if (filters.resumeId) {
    where.resumeId = filters.resumeId;
  }

  return where;
}

/**
 * Calculate date range for previous period (for comparison)
 */
function getPreviousPeriodRange(
  startDate: Date,
  endDate: Date
): { previousStart: Date; previousEnd: Date } {
  const duration = endDate.getTime() - startDate.getTime();
  const previousEnd = new Date(startDate.getTime() - 1); // 1ms before current start
  const previousStart = new Date(previousEnd.getTime() - duration);
  return { previousStart, previousEnd };
}

// ========================================
// MAIN SERVICE FUNCTIONS
// ========================================

/**
 * Get complete candidate dashboard data with filters
 */
export async function getCandidateDashboard(
  clerkId: string,
  filters: DashboardFilters = {},
  limit = 10
): Promise<CandidateDashboardResponse | null> {
  dashboardLogger.info('Fetching candidate dashboard', {
    clerkId: clerkId.slice(0, 15),
    filters: {
      hasStartDate: !!filters.startDate,
      hasEndDate: !!filters.endDate,
      roleTitle: filters.roleTitle,
      seniority: filters.seniority,
      resumeId: filters.resumeId?.slice(0, 8),
    },
  });

  // Get user first
  const user = await prisma.user.findUnique({
    where: { clerkId },
    select: {
      id: true,
      credits: true,
    },
  });

  if (!user) {
    dashboardLogger.warn('User not found for dashboard', { clerkId: clerkId.slice(0, 15) });
    return null;
  }

  dashboardLogger.debug('User found for dashboard', {
    clerkId: clerkId.slice(0, 15),
    internalUserId: user.id,
    credits: user.credits,
  });

  // Build where clause for filtered interviews
  const whereClause = buildInterviewWhereClause(user.id, filters);
  
  dashboardLogger.debug('Interview where clause', { whereClause });

  // Execute all queries in parallel for performance
  const [
    filteredInterviews,
    allCompletedInterviews,
    payments,
    resumes,
    distinctRoles,
    distinctSeniorities,
  ] = await Promise.all([
    // Filtered interviews with all details
    prisma.interview.findMany({
      where: whereClause,
      select: {
        id: true,
        jobTitle: true,
        companyName: true,
        seniority: true,
        resumeId: true,
        resumeFileName: true,
        score: true,
        callDuration: true,
        endedAt: true,
        createdAt: true,
        status: true,
        resumeDocument: {
          select: {
            id: true,
            title: true,
          },
        },
      },
      orderBy: { endedAt: 'desc' },
    }),

    // All completed interviews for filter options
    prisma.interview.findMany({
      where: {
        userId: user.id,
        status: InterviewStatus.COMPLETED,
      },
      select: {
        id: true,
        jobTitle: true,
        seniority: true,
        resumeId: true,
        score: true,
        callDuration: true,
        endedAt: true,
      },
      orderBy: { endedAt: 'desc' },
    }),

    // Payments for total spent
    prisma.payment.findMany({
      where: {
        userId: user.id,
        status: 'APPROVED',
      },
      select: {
        amountUSD: true,
        createdAt: true,
      },
    }),

    // User's resumes with interview counts
    prisma.resumeDocument.findMany({
      where: {
        userId: user.id,
        isActive: true,
        isLatest: true,
      },
      select: {
        id: true,
        title: true,
        fileName: true,
        createdAt: true,
        lastUsedAt: true,
        isPrimary: true,
        qualityScore: true,
        interviews: {
          where: {
            status: InterviewStatus.COMPLETED,
          },
          select: {
            id: true,
            endedAt: true,
          },
        },
      },
      orderBy: [{ isPrimary: 'desc' }, { lastUsedAt: 'desc' }],
    }),

    // Distinct role titles for filter options
    prisma.interview.findMany({
      where: {
        userId: user.id,
        status: InterviewStatus.COMPLETED,
      },
      select: {
        jobTitle: true,
      },
      distinct: ['jobTitle'],
      orderBy: { jobTitle: 'asc' },
    }),

    // Distinct seniorities for filter options
    prisma.interview.findMany({
      where: {
        userId: user.id,
        status: InterviewStatus.COMPLETED,
        seniority: { not: null },
      },
      select: {
        seniority: true,
      },
      distinct: ['seniority'],
      orderBy: { seniority: 'asc' },
    }),
  ]);

  // Calculate KPIs from filtered interviews
  const scores = filteredInterviews
    .filter((i) => i.score !== null)
    .map((i) => i.score as number);
  const durations = filteredInterviews
    .filter((i) => i.callDuration !== null)
    .map((i) => i.callDuration as number);

  const averageScore = scores.length > 0
    ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10
    : null;

  const averageDurationMinutes = durations.length > 0
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length / 60)
    : null;

  const passRate = scores.length > 0
    ? Math.round((scores.filter((s) => s >= 70).length / scores.length) * 100)
    : null;

  // Calculate score change (compare to previous period if date range provided)
  let scoreChange: number | null = null;
  if (filters.startDate && filters.endDate && averageScore !== null) {
    const { previousStart, previousEnd } = getPreviousPeriodRange(
      filters.startDate,
      filters.endDate
    );

    const previousWhereClause = buildInterviewWhereClause(user.id, {
      ...filters,
      startDate: previousStart,
      endDate: previousEnd,
    });

    const previousInterviews = await prisma.interview.findMany({
      where: previousWhereClause,
      select: { score: true },
    });

    const previousScores = previousInterviews
      .filter((i) => i.score !== null)
      .map((i) => i.score as number);

    if (previousScores.length > 0) {
      const previousAverage =
        previousScores.reduce((a, b) => a + b, 0) / previousScores.length;
      scoreChange = Math.round(((averageScore - previousAverage) / previousAverage) * 100);
    }
  }

  // Calculate interviews this month
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);
  const interviewsThisMonth = allCompletedInterviews.filter(
    (i) => i.endedAt && new Date(i.endedAt) >= startOfMonth
  ).length;

  // Calculate total spent
  const totalSpent = payments.reduce((sum, p) => sum + (p.amountUSD || 0), 0);

  // Build score evolution data
  const scoreEvolution: ScoreEvolutionPoint[] = filteredInterviews
    .filter((i) => i.score !== null && i.endedAt !== null)
    .map((i) => ({
      date: i.endedAt!.toISOString(),
      score: i.score as number,
      roleTitle: i.jobTitle,
      seniority: i.seniority,
    }))
    .reverse(); // Oldest first for charts

  // Build recent interviews list
  const recentInterviews: RecentInterview[] = filteredInterviews.slice(0, limit).map((i) => ({
    id: i.id,
    date: (i.endedAt || i.createdAt).toISOString(),
    roleTitle: i.jobTitle,
    companyName: i.companyName,
    seniority: i.seniority,
    resumeTitle: i.resumeDocument?.title || i.resumeFileName || null,
    resumeId: i.resumeId,
    durationMinutes: i.callDuration ? Math.round(i.callDuration / 60) : null,
    score: i.score,
    status: i.status,
  }));

  // Build resume utilization stats
  const resumeUtilization: ResumeUtilization[] = resumes.map((r) => {
    // Count filtered interviews for this resume
    const filteredInterviewCount = filteredInterviews.filter(
      (i) => i.resumeId === r.id
    ).length;

    return {
      id: r.id,
      title: r.title,
      fileName: r.fileName,
      createdAt: r.createdAt.toISOString(),
      lastUsedAt: r.lastUsedAt?.toISOString() || null,
      interviewCount: r.interviews.length,
      filteredInterviewCount,
      isPrimary: r.isPrimary,
      qualityScore: r.qualityScore,
    };
  });

  // Build filter options
  const filterOptions: FilterOptions = {
    roleTitles: distinctRoles.map((r) => r.jobTitle),
    seniorities: distinctSeniorities
      .filter((s) => s.seniority !== null)
      .map((s) => s.seniority as string),
    resumes: resumes.map((r) => ({ id: r.id, title: r.title })),
  };

  const response: CandidateDashboardResponse = {
    kpis: {
      totalInterviews: allCompletedInterviews.length,
      completedInterviews: filteredInterviews.length,
      averageScore,
      scoreChange,
      averageDurationMinutes,
      totalSpent: Math.round(totalSpent * 100) / 100,
      creditsRemaining: user.credits,
      interviewsThisMonth,
      passRate,
    },
    scoreEvolution,
    recentInterviews,
    resumes: resumeUtilization,
    filterOptions,
    filters: {
      startDate: filters.startDate?.toISOString() || null,
      endDate: filters.endDate?.toISOString() || null,
      roleTitle: filters.roleTitle || null,
      seniority: filters.seniority || null,
      resumeId: filters.resumeId || null,
    },
  };

  dashboardLogger.info('Dashboard data fetched successfully', {
    clerkId: clerkId.slice(0, 15),
    totalInterviews: response.kpis.totalInterviews,
    filteredInterviews: response.kpis.completedInterviews,
    resumeCount: response.resumes.length,
  });

  return response;
}

/**
 * Update resume's lastUsedAt when starting an interview
 */
export async function updateResumeLastUsed(resumeId: string): Promise<void> {
  try {
    await prisma.resumeDocument.update({
      where: { id: resumeId },
      data: { lastUsedAt: new Date() },
    });
    dashboardLogger.debug('Updated resume lastUsedAt', { resumeId: resumeId.slice(0, 8) });
  } catch (error) {
    dashboardLogger.error('Failed to update resume lastUsedAt', {
      resumeId: resumeId.slice(0, 8),
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * Get spending history by month
 */
export async function getSpendingHistory(
  clerkId: string,
  months = 6
): Promise<Array<{ month: string; amount: number }>> {
  const user = await prisma.user.findUnique({
    where: { clerkId },
    select: { id: true },
  });

  if (!user) {
    return [];
  }

  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - months);
  startDate.setDate(1);
  startDate.setHours(0, 0, 0, 0);

  const payments = await prisma.payment.findMany({
    where: {
      userId: user.id,
      status: 'APPROVED',
      createdAt: { gte: startDate },
    },
    select: {
      amountUSD: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  // Group by month
  const monthlySpending = new Map<string, number>();
  
  // Initialize all months with 0
  for (let i = 0; i < months; i++) {
    const date = new Date();
    date.setMonth(date.getMonth() - i);
    const monthKey = date.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
    monthlySpending.set(monthKey, 0);
  }

  // Sum payments by month
  payments.forEach((p) => {
    const monthKey = p.createdAt.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
    const current = monthlySpending.get(monthKey) || 0;
    monthlySpending.set(monthKey, current + (p.amountUSD || 0));
  });

  // Convert to array, oldest first
  return Array.from(monthlySpending.entries())
    .map(([month, amount]) => ({ month, amount: Math.round(amount * 100) / 100 }))
    .reverse();
}
