/**
 * Benchmark Resolver
 * 
 * Handles benchmarkByRole query with caching and fallback for insufficient data.
 * 
 * @module graphql/resolvers/benchmarkResolver
 */

import { GraphQLContext } from '../context';
import * as analyticsService from '../../services/analyticsService';
import * as analyticsCachingService from '../../services/analyticsCachingService';
import { apiLogger } from '../../utils/logger';

// Minimum interviews required to show meaningful benchmark
const MIN_INTERVIEWS_FOR_BENCHMARK = 5;

export const benchmarkResolver = {
  Query: {
    /**
     * Get benchmark data for a specific role
     * 
     * Returns hasData: false if insufficient data,
     * with a friendly message for the UI.
     */
    benchmarkByRole: async (
      _parent: unknown,
      args: { roleTitle: string; userScore?: number },
      context: GraphQLContext
    ) => {
      const { userId, prisma, requestId } = context;
      const { roleTitle, userScore } = args;

      apiLogger.info('GraphQL: benchmarkByRole query', {
        requestId,
        roleTitle,
        hasUserScore: userScore !== undefined,
      });

      try {
        // Normalize role title for consistent caching
        const normalizedRole = roleTitle.toLowerCase().trim();
        const cacheKey = `benchmark:${normalizedRole}`;

        // Check cache first
        const cached = await analyticsCachingService.getCachedAnalytics<any>(
          userId,
          cacheKey as any
        );

        if (cached) {
          apiLogger.debug('GraphQL: Benchmark cache hit', { requestId, roleTitle });
          return cached;
        }

        // Count interviews for this role; require minimum for a meaningful benchmark.
        const roleInterviews = await prisma.interviewScoreHistory.count({
          where: {
            OR: [
              { role: normalizedRole },
              {
                role: {
                  contains: roleTitle,
                  mode: 'insensitive',
                },
              },
            ],
          },
        });

        if (roleInterviews < MIN_INTERVIEWS_FOR_BENCHMARK) {
          const result = {
            hasData: false,
            message: `Be the first to set the benchmark for ${roleTitle}! Only ${roleInterviews} interview${roleInterviews === 1 ? '' : 's'} recorded so far.`,
            data: null,
          };

          // Cache the "no data" result briefly (5 minutes)
          await analyticsCachingService.setCachedAnalytics(
            userId,
            cacheKey as any,
            result,
            { ttlMs: 5 * 60 * 1000 }
          );

          apiLogger.info('GraphQL: Insufficient benchmark data', {
            requestId,
            roleTitle,
            interviewCount: roleInterviews,
          });

          return result;
        }

        const computed = await analyticsService.getBenchmarkData(
          requestId ?? 'benchmarkByRole',
          roleTitle,
          userScore ?? 0
        );

        // Very defensive fallback; should rarely happen given roleInterviews >= min.
        const data =
          computed ??
          {
            userScore: userScore ?? 0,
            globalAverage: 70,
            percentile: 50,
            roleTitle,
            totalCandidates: roleInterviews,
            breakdown: null,
          };

        const result = {
          hasData: true,
          message: null,
          data,
        };

        // Cache for 30 minutes
        await analyticsCachingService.setCachedAnalytics(
          userId,
          cacheKey as any,
          result,
          { ttlMs: 30 * 60 * 1000 }
        );

        apiLogger.info('GraphQL: Benchmark data computed', {
          requestId,
          roleTitle,
          totalCandidates: data.totalCandidates,
          percentile: data.percentile,
        });

        return result;
      } catch (error: any) {
        apiLogger.error('GraphQL: Benchmark query failed', {
          requestId,
          roleTitle,
          error: error.message,
        });
        throw error;
      }
    },
  },
};
