/**
 * Interview Resolver
 * 
 * Handles interviews list and interviewDetails queries.
 * 
 * @module graphql/resolvers/interviewResolver
 */

import { GraphQLContext } from '../context';
import * as analyticsService from '../../services/analyticsService';
import { apiLogger } from '../../utils/logger';

interface PaginationInput {
  page?: number;
  limit?: number;
}

interface InterviewFilters {
  status?: string;
  roleTitle?: string;
  seniority?: string;
  companyName?: string;
}

export const interviewResolver = {
  Query: {
    /**
     * Get paginated list of interviews
     */
    interviews: async (
      _parent: unknown,
      args: { pagination?: PaginationInput; filters?: InterviewFilters },
      context: GraphQLContext
    ) => {
      const { userId, prisma, requestId } = context;
      const { pagination = {}, filters = {} } = args;
      const page = pagination.page || 1;
      const limit = Math.min(pagination.limit || 20, 100);
      const skip = (page - 1) * limit;

      apiLogger.info('GraphQL: interviews query', {
        requestId,
        userId: userId?.slice(0, 15),
        page,
        limit,
      });

      try {
        // Build where clause
        const where: any = { userId };
        
        if (filters.status) {
          where.status = filters.status;
        }
        if (filters.roleTitle) {
          where.jobTitle = { contains: filters.roleTitle, mode: 'insensitive' };
        }
        if (filters.seniority) {
          where.seniority = filters.seniority;
        }
        if (filters.companyName) {
          where.companyName = { contains: filters.companyName, mode: 'insensitive' };
        }

        // Fetch interviews and count in parallel
        const [interviews, total] = await Promise.all([
          prisma.interview.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit,
            select: {
              id: true,
              jobTitle: true,
              companyName: true,
              status: true,
              score: true,
              callDuration: true,
              createdAt: true,
              endedAt: true,
            },
          }),
          prisma.interview.count({ where }),
        ]);

        const hasMore = skip + interviews.length < total;

        apiLogger.info('GraphQL: Interviews fetched', {
          requestId,
          count: interviews.length,
          total,
        });

        return {
          interviews: interviews.map(i => ({
            ...i,
            score: i.score ?? null,
            callDuration: i.callDuration ?? null,
            endedAt: i.endedAt ?? null,
          })),
          total,
          page,
          limit,
          hasMore,
        };
      } catch (error: any) {
        apiLogger.error('GraphQL: Interviews query failed', {
          requestId,
          error: error.message,
        });
        throw error;
      }
    },

    /**
     * Get complete interview details with all analytics
     * Single query replaces 4 separate REST calls
     */
    interviewDetails: async (
      _parent: unknown,
      args: { id: string },
      context: GraphQLContext
    ) => {
      const { userId, prisma, requestId } = context;
      const { id: interviewId } = args;

      apiLogger.info('GraphQL: interviewDetails query', {
        requestId,
        interviewId,
      });

      try {
        // Fetch interview with related data
        const interview = await prisma.interview.findFirst({
          where: {
            id: interviewId,
            userId,
          },
          include: {
            metrics: true,
            transcriptSegments: {
              orderBy: { segmentIndex: 'asc' },
            },
            session: true,
          },
        });

        if (!interview) {
          apiLogger.warn('GraphQL: Interview not found', { requestId, interviewId });
          return null;
        }

        // Build analytics data from session and metrics
        const analytics = interview.session ? {
          timelineData: interview.confidenceTimeline 
            ? (interview.confidenceTimeline as any[]).map((point: any) => ({
                timestamp: point.timestamp,
                confidence: point.value || point.confidence,
                tone: point.tone || null,
                pace: point.pace || null,
              }))
            : null,
          softSkills: interview.metrics.length > 0 ? {
            skills: interview.metrics.map(m => ({
              name: m.metricName,
              score: m.score,
              maxScore: m.maxScore,
              feedback: m.feedback,
            })),
            overallCommunication: interview.metrics
              .filter(m => m.category === 'communication')
              .reduce((sum, m) => sum + m.score, 0) / 
              (interview.metrics.filter(m => m.category === 'communication').length || 1),
            overallTechnical: interview.metrics
              .filter(m => m.category === 'technical')
              .reduce((sum, m) => sum + m.score, 0) / 
              (interview.metrics.filter(m => m.category === 'technical').length || 1),
          } : null,
          callDuration: interview.callDuration,
          wpmAverage: interview.wpmAverage,
          sentimentScore: interview.sentimentScore,
        } : null;

        // Build transcript segments
        const transcript = interview.transcriptSegments.map(seg => ({
          id: seg.id,
          speaker: seg.speaker,
          content: seg.content,
          startTime: seg.startTime,
          endTime: seg.endTime,
          sentimentScore: seg.sentimentScore,
          segmentIndex: seg.segmentIndex,
        }));

        // Get benchmark data
        let benchmark = null;
        if (interview.score && interview.jobTitle) {
          const benchmarkData = await analyticsService.getBenchmarkData(
            interviewId,
            interview.jobTitle,
            interview.score
          );
          
          benchmark = benchmarkData ? {
            hasData: true,
            message: null,
            data: benchmarkData,
          } : {
            hasData: false,
            message: 'Insufficient data for this role. Be the first to set the benchmark!',
            data: null,
          };
        } else {
          benchmark = {
            hasData: false,
            message: 'Interview not completed yet',
            data: null,
          };
        }

        // Get recommendations from stored data or generate
        let recommendations = null;
        const storedRecs = await prisma.studyRecommendation.findUnique({
          where: { interviewId },
        });
        
        if (storedRecs) {
          recommendations = {
            topics: storedRecs.topics as any[],
            weakAreas: storedRecs.weakAreas as any[],
            generatedAt: storedRecs.generatedAt,
          };
        }

        apiLogger.info('GraphQL: Interview details fetched', {
          requestId,
          interviewId,
          hasAnalytics: !!analytics,
          transcriptSegments: transcript.length,
          hasBenchmark: benchmark?.hasData,
        });

        return {
          interview: {
            id: interview.id,
            jobTitle: interview.jobTitle,
            companyName: interview.companyName,
            jobDescription: interview.jobDescription,
            seniority: interview.seniority,
            language: interview.language,
            status: interview.status,
            score: interview.score,
            callDuration: interview.callDuration,
            transcript: interview.transcript,
            feedbackText: interview.feedbackText,
            startedAt: interview.startedAt,
            endedAt: interview.endedAt,
            createdAt: interview.createdAt,
            updatedAt: interview.updatedAt,
          },
          analytics,
          transcript: transcript.length > 0 ? transcript : null,
          benchmark,
          recommendations,
        };
      } catch (error: any) {
        apiLogger.error('GraphQL: InterviewDetails query failed', {
          requestId,
          interviewId,
          error: error.message,
        });
        throw error;
      }
    },
  },
};
