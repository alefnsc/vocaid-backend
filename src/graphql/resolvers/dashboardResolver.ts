/**
 * Dashboard Resolver
 * 
 * Handles dashboardData query with caching via AnalyticsCache.
 * 
 * @module graphql/resolvers/dashboardResolver
 */

import { GraphQLContext } from '../context';
import * as candidateDashboardService from '../../services/candidateDashboardService';
import * as analyticsCachingService from '../../services/analyticsCachingService';
import { apiLogger } from '../../utils/logger';

interface DashboardFilters {
  startDate?: string;
  endDate?: string;
  roleTitle?: string;
  seniority?: string;
  resumeId?: string;
  limit?: number;
}

export const dashboardResolver = {
  Query: {
    /**
     * Get dashboard data for authenticated user
     * Uses AnalyticsCache for performance
     */
    dashboardData: async (
      _parent: unknown,
      args: { filters?: DashboardFilters },
      context: GraphQLContext
    ) => {
      const { clerkId, requestId } = context;
      const { filters = {} } = args;

      apiLogger.info('GraphQL: dashboardData query', {
        requestId,
        clerkId: clerkId.slice(0, 15),
        hasFilters: Object.keys(filters).length > 0,
      });

      try {
        // Check cache first (only for unfiltered requests)
        const hasFilters = Object.values(filters).some(v => v !== undefined);
        
        if (!hasFilters) {
          const cached = await analyticsCachingService.getCachedAnalytics(
            clerkId,
            'dashboard' as any
          );
          
          if (cached) {
            apiLogger.debug('GraphQL: Dashboard cache hit', { requestId });
            return cached;
          }
        }

        // Build service filters
        const serviceFilters = {
          startDate: filters.startDate ? new Date(filters.startDate) : undefined,
          endDate: filters.endDate ? new Date(filters.endDate) : undefined,
          roleTitle: filters.roleTitle,
          seniority: filters.seniority,
          resumeId: filters.resumeId,
        };

        const dashboard = await candidateDashboardService.getCandidateDashboard(
          clerkId,
          serviceFilters,
          filters.limit || 10
        );

        if (!dashboard) {
          apiLogger.warn('GraphQL: User not found for dashboard', { requestId, clerkId });
          throw new Error('User not found');
        }

        // Transform to GraphQL shape (matching CandidateDashboardResponse)
        const result = {
          kpis: {
            totalInterviews: dashboard.kpis?.totalInterviews ?? 0,
            completedInterviews: dashboard.kpis?.completedInterviews ?? 0,
            averageScore: dashboard.kpis?.averageScore ?? null,
            scoreChange: dashboard.kpis?.scoreChange ?? null,
            averageDurationMinutes: dashboard.kpis?.averageDurationMinutes ?? null,
            totalSpent: dashboard.kpis?.totalSpent ?? 0,
            creditsRemaining: dashboard.kpis?.creditsRemaining ?? 0,
            interviewsThisMonth: dashboard.kpis?.interviewsThisMonth ?? 0,
            passRate: dashboard.kpis?.passRate ?? null,
          },
          scoreEvolution: (dashboard.scoreEvolution || []).map((point) => ({
            date: point.date,
            score: point.score,
            roleTitle: point.roleTitle,
            seniority: point.seniority || null,
          })),
          recentInterviews: (dashboard.recentInterviews || []).map((interview) => ({
            id: interview.id,
            date: interview.date,
            roleTitle: interview.roleTitle,
            companyName: interview.companyName,
            seniority: interview.seniority || null,
            resumeTitle: interview.resumeTitle || null,
            resumeId: interview.resumeId || null,
            durationMinutes: interview.durationMinutes || null,
            score: interview.score ?? null,
            status: interview.status,
          })),
          resumes: (dashboard.resumes || []).map((resume) => ({
            id: resume.id,
            title: resume.title,
            fileName: resume.fileName,
            createdAt: resume.createdAt,
            lastUsedAt: resume.lastUsedAt || null,
            interviewCount: resume.interviewCount,
            filteredInterviewCount: resume.filteredInterviewCount,
            isPrimary: resume.isPrimary,
            qualityScore: resume.qualityScore,
          })),
          filterOptions: {
            roleTitles: dashboard.filterOptions?.roleTitles || [],
            seniorities: dashboard.filterOptions?.seniorities || [],
            resumes: (dashboard.filterOptions?.resumes || []).map((r) => ({
              id: r.id,
              title: r.title,
            })),
          },
          filters: {
            startDate: dashboard.filters?.startDate || null,
            endDate: dashboard.filters?.endDate || null,
            roleTitle: dashboard.filters?.roleTitle || null,
            seniority: dashboard.filters?.seniority || null,
            resumeId: dashboard.filters?.resumeId || null,
          },
        };

        // Cache unfiltered results
        if (!hasFilters) {
          await analyticsCachingService.setCachedAnalytics(
            clerkId,
            'dashboard' as any,
            result
          );
        }

        apiLogger.info('GraphQL: Dashboard data fetched', {
          requestId,
          interviewCount: result.recentInterviews.length,
        });

        return result;
      } catch (error: any) {
        apiLogger.error('GraphQL: Dashboard query failed', {
          requestId,
          error: error.message,
        });
        throw error;
      }
    },
  },

  Mutation: {
    /**
     * Force refresh dashboard (invalidate cache)
     */
    refreshDashboard: async (
      _parent: unknown,
      _args: unknown,
      context: GraphQLContext
    ) => {
      const { clerkId, requestId } = context;

      apiLogger.info('GraphQL: refreshDashboard mutation', { requestId });

      // Invalidate cache
      await analyticsCachingService.invalidateUserCache(clerkId);

      // Fetch fresh data
      const dashboard = await candidateDashboardService.getCandidateDashboard(
        clerkId,
        {},
        10
      );

      if (!dashboard) {
        throw new Error('User not found');
      }

      // Return same shape as query
      return {
        kpis: dashboard.kpis || {},
        scoreEvolution: dashboard.scoreEvolution || [],
        recentInterviews: dashboard.recentInterviews || [],
        resumes: dashboard.resumes || [],
        filterOptions: dashboard.filterOptions || {},
        filters: dashboard.filters || {},
      };
    },
  },
};
