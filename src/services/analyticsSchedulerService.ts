/**
 * Analytics Scheduler Service
 * 
 * Handles scheduled jobs for analytics computation:
 * - Global analytics snapshot generation
 * - Dashboard pre-computation
 * - Cache warming
 * 
 * Uses node-cron for scheduling when enabled.
 * 
 * @module services/analyticsSchedulerService
 */

import cron from 'node-cron';
import { PrismaClient } from '@prisma/client';
import { apiLogger } from '../utils/logger';
import redisService from './azureRedisService';

// ============================================
// CONFIGURATION
// ============================================

const config = {
  enabled: process.env.ANALYTICS_SCHEDULED_JOBS_ENABLED === 'true',
  snapshotCron: process.env.ANALYTICS_SNAPSHOT_CRON || '0 * * * *', // Every hour
  cacheTtlDashboard: parseInt(process.env.ANALYTICS_CACHE_TTL_DASHBOARD || '300', 10),
  cacheTtlGlobal: parseInt(process.env.ANALYTICS_CACHE_TTL_GLOBAL || '3600', 10),
};

// ============================================
// PRISMA CLIENT
// ============================================

const prisma = new PrismaClient();

// ============================================
// ANALYTICS COMPUTATION
// ============================================

interface GlobalAnalyticsData {
  computedAt: string;
  totalUsers: number;
  activeUsersLast7Days: number;
  activeUsersLast30Days: number;
  totalInterviews: number;
  interviewsLast7Days: number;
  interviewsLast30Days: number;
  averageScore: number | null;
  scoreDistribution: {
    excellent: number;  // >= 90
    good: number;       // >= 75
    average: number;    // >= 60
    needsWork: number;  // < 60
  };
  topRoles: Array<{ role: string; count: number }>;
  languageDistribution: Array<{ language: string; count: number }>;
  revenueMetrics: {
    totalCreditsUsed: number;
    creditsLast7Days: number;
    creditsLast30Days: number;
  };
}

/**
 * Compute global analytics snapshot
 * This is an expensive query - run on schedule, not on-demand
 */
async function computeGlobalAnalytics(): Promise<GlobalAnalyticsData> {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  apiLogger.info('[analytics-scheduler] Computing global analytics snapshot');

  try {
    // Run queries in parallel for efficiency
    const [
      totalUsers,
      activeUsers7Days,
      activeUsers30Days,
      totalInterviews,
      interviews7Days,
      interviews30Days,
      scoreStats,
      scoreDistribution,
      topRoles,
      languageDistribution,
      creditStats,
    ] = await Promise.all([
      // Total users
      prisma.user.count({
        where: { isActive: true },
      }),

      // Active users (last 7 days) - based on updatedAt or having interviews
      prisma.user.count({
        where: {
          isActive: true,
          OR: [
            { updatedAt: { gte: sevenDaysAgo } },
            { interviews: { some: { createdAt: { gte: sevenDaysAgo } } } },
          ],
        },
      }),

      // Active users (last 30 days)
      prisma.user.count({
        where: {
          isActive: true,
          OR: [
            { updatedAt: { gte: thirtyDaysAgo } },
            { interviews: { some: { createdAt: { gte: thirtyDaysAgo } } } },
          ],
        },
      }),

      // Total interviews
      prisma.interview.count({
        where: { status: 'COMPLETED' },
      }),

      // Interviews last 7 days
      prisma.interview.count({
        where: {
          status: 'COMPLETED',
          createdAt: { gte: sevenDaysAgo },
        },
      }),

      // Interviews last 30 days
      prisma.interview.count({
        where: {
          status: 'COMPLETED',
          createdAt: { gte: thirtyDaysAgo },
        },
      }),

      // Average score (using 'score' field from Interview model)
      prisma.interview.aggregate({
        where: {
          status: 'COMPLETED',
          score: { not: null },
        },
        _avg: { score: true },
      }),

      // Score distribution
      Promise.all([
        prisma.interview.count({
          where: { status: 'COMPLETED', score: { gte: 90 } },
        }),
        prisma.interview.count({
          where: { status: 'COMPLETED', score: { gte: 75, lt: 90 } },
        }),
        prisma.interview.count({
          where: { status: 'COMPLETED', score: { gte: 60, lt: 75 } },
        }),
        prisma.interview.count({
          where: { status: 'COMPLETED', score: { lt: 60 } },
        }),
      ]),

      // Top roles (top 10)
      prisma.interview.groupBy({
        by: ['jobTitle'],
        where: { status: 'COMPLETED' },
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
        take: 10,
      }),

      // Language distribution
      prisma.interview.groupBy({
        by: ['language'],
        where: { status: 'COMPLETED' },
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
      }),

      // Credit usage stats from CreditLedger (using SPEND type)
      Promise.all([
        prisma.creditLedger.aggregate({
          where: { type: 'SPEND' },
          _sum: { amount: true },
        }),
        prisma.creditLedger.aggregate({
          where: {
            type: 'SPEND',
            createdAt: { gte: sevenDaysAgo },
          },
          _sum: { amount: true },
        }),
        prisma.creditLedger.aggregate({
          where: {
            type: 'SPEND',
            createdAt: { gte: thirtyDaysAgo },
          },
          _sum: { amount: true },
        }),
      ]),
    ]);

    const snapshot: GlobalAnalyticsData = {
      computedAt: now.toISOString(),
      totalUsers,
      activeUsersLast7Days: activeUsers7Days,
      activeUsersLast30Days: activeUsers30Days,
      totalInterviews,
      interviewsLast7Days: interviews7Days,
      interviewsLast30Days: interviews30Days,
      averageScore: scoreStats._avg.score,
      scoreDistribution: {
        excellent: scoreDistribution[0],
        good: scoreDistribution[1],
        average: scoreDistribution[2],
        needsWork: scoreDistribution[3],
      },
      topRoles: topRoles.map((r) => ({
        role: r.jobTitle || 'Unknown',
        count: r._count.id,
      })),
      languageDistribution: languageDistribution.map((l) => ({
        language: l.language || 'en-US',
        count: l._count.id,
      })),
      revenueMetrics: {
        totalCreditsUsed: creditStats[0]._sum.amount ?? 0,
        creditsLast7Days: creditStats[1]._sum.amount ?? 0,
        creditsLast30Days: creditStats[2]._sum.amount ?? 0,
      },
    };

    // Cache the snapshot
    await redisService.set('analytics:global', snapshot, config.cacheTtlGlobal);

    // Store in database using GlobalAnalyticsSnapshot model
    // Uses upsert to maintain single record per snapshotType
    await prisma.globalAnalyticsSnapshot.upsert({
      where: { snapshotType: 'global_stats' },
      update: {
        snapshotData: snapshot as any,
        recordCount: totalInterviews,
        computedAt: now,
      },
      create: {
        snapshotType: 'global_stats',
        snapshotData: snapshot as any,
        recordCount: totalInterviews,
        computedAt: now,
      },
    });

    apiLogger.info('[analytics-scheduler] Global analytics snapshot computed', {
      totalUsers,
      totalInterviews,
      averageScore: scoreStats._avg.score,
    });

    return snapshot;
  } catch (error) {
    apiLogger.error('[analytics-scheduler] Failed to compute global analytics', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    throw error;
  }
}

/**
 * Get cached global analytics or compute if stale
 */
export async function getGlobalAnalytics(): Promise<GlobalAnalyticsData | null> {
  // Try cache first
  const cached = await redisService.get<GlobalAnalyticsData>('analytics:global');
  if (cached) {
    return cached;
  }

  // If scheduled jobs are enabled, don't compute on-demand
  // Wait for the next scheduled run
  if (config.enabled) {
    // Try to get from database
    const latest = await prisma.globalAnalyticsSnapshot.findUnique({
      where: { snapshotType: 'global_stats' },
    });

    if (latest) {
      const snapshot = latest.snapshotData as unknown as GlobalAnalyticsData;
      // Re-cache it
      await redisService.set('analytics:global', snapshot, config.cacheTtlGlobal);
      return snapshot;
    }

    return null;
  }

  // Compute on-demand if scheduled jobs are disabled
  return computeGlobalAnalytics();
}

// ============================================
// SCHEDULED JOBS
// ============================================

let snapshotJob: ReturnType<typeof cron.schedule> | null = null;

/**
 * Start scheduled analytics jobs
 */
export function startScheduledJobs(): void {
  if (!config.enabled) {
    apiLogger.info('[analytics-scheduler] Scheduled jobs are disabled');
    return;
  }

  // Validate cron expression
  if (!cron.validate(config.snapshotCron)) {
    apiLogger.error('[analytics-scheduler] Invalid cron expression', {
      cron: config.snapshotCron,
    });
    return;
  }

  // Schedule global analytics snapshot
  snapshotJob = cron.schedule(config.snapshotCron, async () => {
    apiLogger.info('[analytics-scheduler] Running scheduled global analytics snapshot');
    
    try {
      await computeGlobalAnalytics();
    } catch (error) {
      apiLogger.error('[analytics-scheduler] Scheduled job failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  apiLogger.info('[analytics-scheduler] Scheduled jobs started', {
    snapshotCron: config.snapshotCron,
  });

  // Run initial computation on startup
  setTimeout(async () => {
    try {
      apiLogger.info('[analytics-scheduler] Running initial analytics computation');
      await computeGlobalAnalytics();
    } catch (error) {
      apiLogger.error('[analytics-scheduler] Initial computation failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }, 5000); // 5 second delay after startup
}

/**
 * Stop scheduled jobs
 */
export function stopScheduledJobs(): void {
  if (snapshotJob) {
    snapshotJob.stop();
    snapshotJob = null;
    apiLogger.info('[analytics-scheduler] Scheduled jobs stopped');
  }
}

// ============================================
// INITIALIZATION
// ============================================

// Start jobs on module load if enabled
if (config.enabled) {
  // Delay startup to allow other services to initialize
  setTimeout(startScheduledJobs, 10000);
}

// Handle graceful shutdown
process.on('SIGTERM', stopScheduledJobs);
process.on('SIGINT', stopScheduledJobs);

export default {
  computeGlobalAnalytics,
  getGlobalAnalytics,
  startScheduledJobs,
  stopScheduledJobs,
};
