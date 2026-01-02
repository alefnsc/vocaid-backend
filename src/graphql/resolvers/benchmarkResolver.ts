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
      const { clerkId, prisma, requestId } = context;
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
          clerkId,
          cacheKey as any
        );

        if (cached) {
          apiLogger.debug('GraphQL: Benchmark cache hit', { requestId, roleTitle });
          return cached;
        }

        // Look up benchmark from database
        const benchmark = await prisma.rolePerformanceBenchmark.findUnique({
          where: { roleTitle: normalizedRole },
        });

        // Check if we have enough data
        if (!benchmark || benchmark.totalInterviews < MIN_INTERVIEWS_FOR_BENCHMARK) {
          // Try to count interviews for this role
          const roleInterviews = await prisma.interviewScoreHistory.count({
            where: {
              role: {
                contains: roleTitle,
                mode: 'insensitive',
              },
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
              clerkId,
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

          // Trigger background computation
          analyticsService.recalculateRoleBenchmarks().catch(err => {
            apiLogger.error('Background benchmark recalculation failed', { error: err.message });
          });

          // Return partial data while computing
          const avgScore = await prisma.interviewScoreHistory.aggregate({
            where: {
              role: {
                contains: roleTitle,
                mode: 'insensitive',
              },
            },
            _avg: { overallScore: true },
            _count: true,
          });

          const result = {
            hasData: true,
            message: null,
            data: {
              userScore: userScore ?? 0,
              globalAverage: avgScore._avg.overallScore ?? 70,
              percentile: 50, // Default to median until computed
              roleTitle,
              totalCandidates: avgScore._count,
              breakdown: null,
            },
          };

          return result;
        }

        // Calculate percentile (simple linear interpolation)
        const score = userScore ?? 0;
        const scoreDistribution = benchmark.scoreDistribution as any;
        let percentile = 50;
        
        if (scoreDistribution?.buckets) {
          let belowCount = 0;
          let totalCount = 0;
          
          for (const bucket of scoreDistribution.buckets) {
            totalCount += bucket.count;
            if (bucket.max < score) {
              belowCount += bucket.count;
            } else if (bucket.min <= score && bucket.max >= score) {
              const bucketRatio = (score - bucket.min) / (bucket.max - bucket.min);
              belowCount += bucket.count * bucketRatio;
            }
          }
          
          percentile = totalCount > 0 ? (belowCount / totalCount) * 100 : 50;
        }

        const result = {
          hasData: true,
          message: null,
          data: {
            userScore: userScore ?? 0,
            globalAverage: benchmark.globalAverageScore,
            percentile,
            roleTitle: benchmark.roleTitle,
            totalCandidates: benchmark.totalInterviews,
            breakdown: benchmark.avgCommunication ? {
              communication: {
                user: (userScore ?? 0) * 0.25,
                average: benchmark.avgCommunication,
              },
              problemSolving: {
                user: (userScore ?? 0) * 0.25,
                average: benchmark.avgProblemSolving ?? 70,
              },
              technicalDepth: {
                user: (userScore ?? 0) * 0.25,
                average: benchmark.avgTechnicalDepth ?? 70,
              },
              leadership: {
                user: (userScore ?? 0) * 0.15,
                average: benchmark.avgLeadership ?? 60,
              },
              adaptability: {
                user: (userScore ?? 0) * 0.1,
                average: benchmark.avgAdaptability ?? 70,
              },
            } : null,
          },
        };

        // Cache for 30 minutes
        await analyticsCachingService.setCachedAnalytics(
          clerkId,
          cacheKey as any,
          result,
          { ttlMs: 30 * 60 * 1000 }
        );

        apiLogger.info('GraphQL: Benchmark data fetched', {
          requestId,
          roleTitle,
          totalCandidates: benchmark.totalInterviews,
          percentile,
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
