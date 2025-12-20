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

// ========================================
// ADVANCED ANALYTICS - TYPES
// ========================================

export interface TimelineDataPoint {
  timestamp: number;
  confidence: number;
  tone: number;
  pace: number;
}

export interface SoftSkillsData {
  communication: number;
  problemSolving: number;
  technicalDepth: number;
  leadership: number;
  adaptability: number;
}

export interface BenchmarkData {
  userScore: number;
  globalAverage: number;
  percentile: number;
  roleTitle: string;
  totalCandidates: number;
  breakdown?: {
    communication: { user: number; average: number };
    problemSolving: { user: number; average: number };
    technicalDepth: { user: number; average: number };
    leadership: { user: number; average: number };
    adaptability: { user: number; average: number };
  };
}

export interface StudyTopic {
  id: string;
  topic: string;
  priority: 'high' | 'medium' | 'low';
  reason: string;
  resources?: string[];
  estimatedTime?: string;
}

export interface WeakArea {
  area: string;
  score: number;
  suggestion: string;
}

export interface TranscriptSegmentData {
  id: string;
  speaker: 'agent' | 'user';
  content: string;
  startTime: number;
  endTime: number;
  sentimentScore?: number;
}

// ========================================
// RETELL CALL ANALYSIS PARSER
// ========================================

/**
 * Parse Retell call_analysis object to extract sentiment and pace data
 */
export function parseRetellCallAnalysis(callAnalysis: any): {
  sentimentScore: number;
  wpmAverage: number;
  confidenceTimeline: TimelineDataPoint[];
  softSkills: SoftSkillsData;
} {
  dbLogger.info('Parsing Retell call analysis', { hasAnalysis: !!callAnalysis });
  
  const defaultResult = {
    sentimentScore: 70,
    wpmAverage: 120,
    confidenceTimeline: [],
    softSkills: {
      communication: 70,
      problemSolving: 70,
      technicalDepth: 70,
      leadership: 60,
      adaptability: 70
    }
  };
  
  if (!callAnalysis) return defaultResult;
  
  try {
    const sentimentScore = callAnalysis.user_sentiment 
      ? mapSentimentToScore(callAnalysis.user_sentiment) 
      : 70;
    const wpmAverage = callAnalysis.words_per_minute || 120;
    const confidenceTimeline = buildConfidenceTimeline(callAnalysis);
    const softSkills = extractSoftSkills(callAnalysis);
    
    return { sentimentScore, wpmAverage, confidenceTimeline, softSkills };
  } catch (error) {
    dbLogger.error('Failed to parse call analysis', { error });
    return defaultResult;
  }
}

function mapSentimentToScore(sentiment: string): number {
  const sentimentMap: Record<string, number> = {
    'very_positive': 95, 'positive': 80, 'neutral': 60, 'negative': 35, 'very_negative': 15
  };
  return sentimentMap[sentiment.toLowerCase()] || 60;
}

function buildConfidenceTimeline(callAnalysis: any): TimelineDataPoint[] {
  const timeline: TimelineDataPoint[] = [];
  
  if (callAnalysis.transcript_with_tool_calls) {
    const segments = callAnalysis.transcript_with_tool_calls;
    let lastTimestamp = 0;
    
    for (const segment of segments) {
      if (segment.role === 'user' && segment.words) {
        const segmentWpm = segment.words.length > 0 
          ? calculateSegmentWpm(segment.words) : 120;
        const timestamp = segment.words[0]?.start || lastTimestamp;
        
        timeline.push({
          timestamp,
          confidence: estimateConfidenceFromPace(segmentWpm),
          tone: mapSentimentToScore(segment.sentiment || 'neutral'),
          pace: normalizeWpm(segmentWpm)
        });
        
        lastTimestamp = timestamp + (segment.words.length / (segmentWpm / 60));
      }
    }
  }
  
  if (timeline.length === 0 && callAnalysis.call_duration_ms) {
    const duration = callAnalysis.call_duration_ms / 1000;
    const numPoints = Math.min(20, Math.floor(duration / 30));
    for (let i = 0; i < numPoints; i++) {
      timeline.push({
        timestamp: (i / numPoints) * duration,
        confidence: 60 + Math.random() * 30,
        tone: 50 + Math.random() * 40,
        pace: 40 + Math.random() * 40
      });
    }
  }
  
  return timeline;
}

function calculateSegmentWpm(words: any[]): number {
  if (words.length < 2) return 120;
  const startTime = words[0].start;
  const endTime = words[words.length - 1].end;
  const durationMinutes = (endTime - startTime) / 60;
  return durationMinutes > 0 ? words.length / durationMinutes : 120;
}

function estimateConfidenceFromPace(wpm: number): number {
  const optimal = 140;
  const deviation = Math.abs(wpm - optimal);
  return Math.max(40, Math.min(95, 90 - deviation * 0.3));
}

function normalizeWpm(wpm: number): number {
  return Math.max(0, Math.min(100, (wpm - 80) / 1.2));
}

function extractSoftSkills(callAnalysis: any): SoftSkillsData {
  const defaults: SoftSkillsData = {
    communication: 70, problemSolving: 70, technicalDepth: 70, leadership: 60, adaptability: 70
  };
  if (callAnalysis.custom_analysis?.soft_skills) {
    return { ...defaults, ...callAnalysis.custom_analysis.soft_skills };
  }
  return defaults;
}

// ========================================
// TRANSCRIPT SEGMENTATION
// ========================================

export async function createTranscriptSegments(
  interviewId: string,
  transcriptData: any
): Promise<TranscriptSegmentData[]> {
  dbLogger.info('Creating transcript segments', { interviewId });
  
  const segments: TranscriptSegmentData[] = [];
  
  if (!transcriptData?.transcript_with_tool_calls) {
    if (typeof transcriptData === 'string') {
      return parseTextTranscript(interviewId, transcriptData);
    }
    return segments;
  }
  
  const rawSegments = transcriptData.transcript_with_tool_calls;
  let segmentIndex = 0;
  
  for (const seg of rawSegments) {
    if (seg.role !== 'tool_calls') {
      const startTime = seg.words?.[0]?.start || segmentIndex * 30;
      const endTime = seg.words?.[seg.words?.length - 1]?.end || startTime + 30;
      
      const segment: TranscriptSegmentData = {
        id: `${interviewId}-${segmentIndex}`,
        speaker: seg.role === 'agent' ? 'agent' : 'user',
        content: seg.content || '',
        startTime,
        endTime,
        sentimentScore: seg.sentiment ? mapSentimentToScore(seg.sentiment) : undefined
      };
      
      segments.push(segment);
      
      await prisma.transcriptSegment.create({
        data: {
          interviewId,
          speaker: segment.speaker,
          content: segment.content,
          startTime: segment.startTime,
          endTime: segment.endTime,
          sentimentScore: segment.sentimentScore,
          segmentIndex
        }
      });
      
      segmentIndex++;
    }
  }
  
  return segments;
}

function parseTextTranscript(interviewId: string, text: string): TranscriptSegmentData[] {
  const segments: TranscriptSegmentData[] = [];
  const lines = text.split('\n').filter(l => l.trim());
  let currentTime = 0;
  const avgSegmentDuration = 15;
  
  lines.forEach((line, index) => {
    const isAgent = line.toLowerCase().includes('agent:') || line.toLowerCase().includes('interviewer:');
    const content = line.replace(/^(agent:|interviewer:|user:|candidate:)/i, '').trim();
    
    if (content) {
      segments.push({
        id: `${interviewId}-${index}`,
        speaker: isAgent ? 'agent' : 'user',
        content,
        startTime: currentTime,
        endTime: currentTime + avgSegmentDuration
      });
      currentTime += avgSegmentDuration;
    }
  });
  
  return segments;
}

export async function getTranscriptSegments(interviewId: string): Promise<TranscriptSegmentData[]> {
  const segments = await prisma.transcriptSegment.findMany({
    where: { interviewId },
    orderBy: { segmentIndex: 'asc' }
  });
  
  return segments.map(seg => ({
    id: seg.id,
    speaker: seg.speaker as 'agent' | 'user',
    content: seg.content,
    startTime: seg.startTime,
    endTime: seg.endTime,
    sentimentScore: seg.sentimentScore || undefined
  }));
}

// ========================================
// BENCHMARKING SERVICE
// ========================================

function normalizeRoleTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\b(senior|junior|lead|principal|staff)\b/gi, '')
    .replace(/\b(engineer|developer)\b/gi, 'engineer')
    .replace(/\s+/g, ' ')
    .trim();
}

function calculatePercentileFromDistribution(
  score: number, 
  distribution: { buckets: { min: number; max: number; count: number }[] }
): number {
  if (!distribution?.buckets || distribution.buckets.length === 0) {
    return Math.min(99, Math.max(1, score));
  }
  
  let belowCount = 0;
  let totalCount = 0;
  
  for (const bucket of distribution.buckets) {
    totalCount += bucket.count;
    if (bucket.max < score) {
      belowCount += bucket.count;
    } else if (bucket.min <= score && bucket.max >= score) {
      const bucketRatio = (score - bucket.min) / (bucket.max - bucket.min);
      belowCount += bucket.count * bucketRatio;
    }
  }
  
  return totalCount > 0 ? (belowCount / totalCount) * 100 : 50;
}

export async function getBenchmarkData(
  interviewId: string,
  roleTitle: string,
  userScore: number
): Promise<BenchmarkData | null> {
  dbLogger.info('Fetching benchmark data', { interviewId, roleTitle });
  
  try {
    const normalizedRole = normalizeRoleTitle(roleTitle);
    
    const benchmark = await prisma.rolePerformanceBenchmark.findUnique({
      where: { roleTitle: normalizedRole }
    });
    
    if (!benchmark) return null;
    
    const percentile = calculatePercentileFromDistribution(
      userScore, 
      benchmark.scoreDistribution as any
    );
    
    return {
      userScore,
      globalAverage: benchmark.globalAverageScore,
      percentile,
      roleTitle: benchmark.roleTitle,
      totalCandidates: benchmark.totalInterviews,
      breakdown: benchmark.avgCommunication ? {
        communication: { user: userScore * 0.25, average: benchmark.avgCommunication },
        problemSolving: { user: userScore * 0.25, average: benchmark.avgProblemSolving || 70 },
        technicalDepth: { user: userScore * 0.25, average: benchmark.avgTechnicalDepth || 70 },
        leadership: { user: userScore * 0.15, average: benchmark.avgLeadership || 60 },
        adaptability: { user: userScore * 0.1, average: benchmark.avgAdaptability || 70 }
      } : undefined
    };
  } catch (error) {
    dbLogger.error('Failed to get benchmark data', { error });
    return null;
  }
}

function calculateScoreDistribution(scores: number[]): { buckets: { min: number; max: number; count: number }[] } {
  const buckets = [
    { min: 0, max: 20, count: 0 },
    { min: 20, max: 40, count: 0 },
    { min: 40, max: 60, count: 0 },
    { min: 60, max: 80, count: 0 },
    { min: 80, max: 100, count: 0 }
  ];
  
  for (const score of scores) {
    for (const bucket of buckets) {
      if (score >= bucket.min && score < bucket.max) {
        bucket.count++;
        break;
      }
    }
  }
  
  return { buckets };
}

export async function recalculateRoleBenchmarks(): Promise<void> {
  dbLogger.info('Starting role benchmark recalculation');
  
  const roleStats = await prisma.interviewScoreHistory.groupBy({
    by: ['role'],
    _count: { role: true },
    _avg: { overallScore: true, communicationScore: true, confidenceScore: true },
    where: { overallScore: { not: null } }
  });
  
  for (const stat of roleStats) {
    const normalizedRole = normalizeRoleTitle(stat.role);
    
    const scores = await prisma.interviewScoreHistory.findMany({
      where: { role: stat.role },
      select: { overallScore: true },
      orderBy: { overallScore: 'asc' }
    });
    
    const distribution = calculateScoreDistribution(scores.map(s => s.overallScore));
    
    await prisma.rolePerformanceBenchmark.upsert({
      where: { roleTitle: normalizedRole },
      create: {
        roleTitle: normalizedRole,
        globalAverageScore: stat._avg.overallScore || 70,
        totalInterviews: stat._count.role,
        scoreDistribution: distribution,
        avgCommunication: stat._avg.communicationScore,
        avgAdaptability: 70,
        avgProblemSolving: 70,
        avgTechnicalDepth: 70,
        avgLeadership: 60,
        lastCalculatedAt: new Date()
      },
      update: {
        globalAverageScore: stat._avg.overallScore || 70,
        totalInterviews: stat._count.role,
        scoreDistribution: distribution,
        avgCommunication: stat._avg.communicationScore,
        lastCalculatedAt: new Date()
      }
    });
  }
  
  dbLogger.info('Role benchmark recalculation complete', { rolesProcessed: roleStats.length });
}

// ========================================
// AI RECOMMENDATION ENGINE
// ========================================

export async function generateStudyRecommendations(
  interviewId: string,
  transcript: string,
  callAnalysis: any,
  feedback: any
): Promise<{ topics: StudyTopic[]; weakAreas: WeakArea[] }> {
  dbLogger.info('Generating study recommendations', { interviewId });
  
  const defaultResult = { topics: [], weakAreas: [] };
  
  if (!process.env.ANTHROPIC_API_KEY) {
    dbLogger.warn('ANTHROPIC_API_KEY not set, skipping recommendations');
    return defaultResult;
  }
  
  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    
    const prompt = `You are an expert career coach analyzing a mock interview. Based on the interview data below, generate personalized study recommendations.

## Feedback Summary
- Overall Score: ${feedback?.overallScore || 'N/A'}
- Strengths: ${feedback?.strengths?.join(', ') || 'N/A'}
- Areas for Improvement: ${feedback?.improvements?.join(', ') || 'N/A'}
- Communication Score: ${feedback?.communicationScore || 'N/A'}
- Technical Score: ${feedback?.technicalScore || 'N/A'}
- Confidence Score: ${feedback?.confidenceScore || 'N/A'}

## Transcript Summary
${transcript?.substring(0, 3000) || 'Not available'}

Generate a JSON response with:
1. "topics": Array of 3-6 study topics with id, topic, priority ("high"/"medium"/"low"), reason, resources (array), estimatedTime
2. "weakAreas": Array of 2-4 weak areas with area, score (0-100), suggestion

Respond ONLY with valid JSON.`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    });
    
    const content = response.content[0];
    if (content.type !== 'text') return defaultResult;
    
    const jsonMatch = content.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return defaultResult;
    
    const parsed = JSON.parse(jsonMatch[0]);
    
    const result = {
      topics: (parsed.topics || []).map((t: any, i: number) => ({
        id: t.id || `topic-${i}`,
        topic: t.topic || 'Unknown Topic',
        priority: ['high', 'medium', 'low'].includes(t.priority) ? t.priority : 'medium',
        reason: t.reason || '',
        resources: Array.isArray(t.resources) ? t.resources : [],
        estimatedTime: t.estimatedTime
      })),
      weakAreas: (parsed.weakAreas || []).map((w: any) => ({
        area: w.area || 'Unknown Area',
        score: typeof w.score === 'number' ? w.score : 50,
        suggestion: w.suggestion || ''
      }))
    };
    
    await prisma.studyRecommendation.upsert({
      where: { interviewId },
      create: { interviewId, topics: result.topics, weakAreas: result.weakAreas },
      update: { topics: result.topics, weakAreas: result.weakAreas, generatedAt: new Date() }
    });
    
    return result;
  } catch (error) {
    dbLogger.error('Failed to generate recommendations', { error });
    return defaultResult;
  }
}

export async function getStudyRecommendations(
  interviewId: string
): Promise<{ topics: StudyTopic[]; weakAreas: WeakArea[] } | null> {
  const recommendation = await prisma.studyRecommendation.findUnique({
    where: { interviewId }
  });
  
  if (!recommendation) return null;
  
  return {
    topics: recommendation.topics as StudyTopic[],
    weakAreas: recommendation.weakAreas as WeakArea[]
  };
}

// ========================================
// ENHANCED DASHBOARD FILTERS
// ========================================

/**
 * Date range presets for dashboard filtering
 */
export type DateRangePreset = 'today' | 'last7days' | 'last30days' | 'last90days' | 'thisMonth' | 'lastMonth' | 'thisYear' | 'allTime' | 'custom';

export interface AdvancedFilters {
  dateRange: {
    preset?: DateRangePreset;
    startDate?: Date;
    endDate?: Date;
  };
  roles?: string[];
  companies?: string[];
  scoreRange?: {
    min?: number;
    max?: number;
  };
  sortBy?: 'date' | 'score' | 'duration' | 'company' | 'role';
  sortOrder?: 'asc' | 'desc';
}

export interface FilteredAnalyticsResult {
  interviews: InterviewSummary[];
  summary: {
    totalInterviews: number;
    avgScore: number;
    bestScore: number;
    worstScore: number;
    totalDuration: number;
    scoreImprovement: number; // vs previous period
  };
  charts: {
    scoreTimeSeries: TimeSeriesDataPoint[];
    scoresByRole: ScoreByRole[];
    scoresByCompany: ScoreByCompany[];
  };
}

export interface InterviewSummary {
  id: string;
  date: Date;
  role: string;
  company: string;
  score: number;
  duration: number;
  status: string;
}

export interface ComparisonResult {
  current: InterviewSummary;
  comparison: InterviewSummary | null;
  differences: {
    overallScore: number;
    duration: number;
    communicationScore?: number;
    technicalScore?: number;
    confidenceScore?: number;
  };
  improvements: string[];
  regressions: string[];
}

/**
 * Calculate date range from preset
 */
export function getDateRangeFromPreset(preset: DateRangePreset): { startDate: Date; endDate: Date } {
  const now = new Date();
  const endDate = new Date(now);
  let startDate: Date;
  
  switch (preset) {
    case 'today':
      startDate = new Date(now);
      startDate.setHours(0, 0, 0, 0);
      endDate.setHours(23, 59, 59, 999);
      break;
      
    case 'last7days':
      startDate = new Date(now);
      startDate.setDate(startDate.getDate() - 7);
      break;
      
    case 'last30days':
      startDate = new Date(now);
      startDate.setDate(startDate.getDate() - 30);
      break;
      
    case 'last90days':
      startDate = new Date(now);
      startDate.setDate(startDate.getDate() - 90);
      break;
      
    case 'thisMonth':
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
      
    case 'lastMonth':
      startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      endDate.setDate(0); // Last day of previous month
      break;
      
    case 'thisYear':
      startDate = new Date(now.getFullYear(), 0, 1);
      break;
      
    case 'allTime':
    default:
      startDate = new Date(0); // Beginning of time
      break;
  }
  
  return { startDate, endDate };
}

/**
 * Get filtered analytics with advanced filtering
 */
export async function getFilteredAnalytics(
  clerkId: string,
  filters: AdvancedFilters
): Promise<FilteredAnalyticsResult | null> {
  const user = await prisma.user.findUnique({
    where: { clerkId },
    select: { id: true }
  });
  
  if (!user) return null;
  
  // Build date range
  let startDate: Date | undefined;
  let endDate: Date | undefined;
  
  if (filters.dateRange.preset && filters.dateRange.preset !== 'custom') {
    const range = getDateRangeFromPreset(filters.dateRange.preset);
    startDate = range.startDate;
    endDate = range.endDate;
  } else if (filters.dateRange.startDate || filters.dateRange.endDate) {
    startDate = filters.dateRange.startDate;
    endDate = filters.dateRange.endDate;
  }
  
  // Build where clause for interviews
  const whereClause: any = {
    userId: user.id,
    status: 'COMPLETED'
  };
  
  if (startDate || endDate) {
    whereClause.createdAt = {};
    if (startDate) whereClause.createdAt.gte = startDate;
    if (endDate) whereClause.createdAt.lte = endDate;
  }
  
  if (filters.roles && filters.roles.length > 0) {
    whereClause.jobTitle = { in: filters.roles };
  }
  
  if (filters.companies && filters.companies.length > 0) {
    whereClause.companyName = { in: filters.companies };
  }
  
  if (filters.scoreRange) {
    whereClause.score = {};
    if (filters.scoreRange.min !== undefined) whereClause.score.gte = filters.scoreRange.min;
    if (filters.scoreRange.max !== undefined) whereClause.score.lte = filters.scoreRange.max;
  }
  
  // Build order by
  const orderBy: any = {};
  const sortBy = filters.sortBy || 'date';
  const sortOrder = filters.sortOrder || 'desc';
  
  switch (sortBy) {
    case 'score':
      orderBy.score = sortOrder;
      break;
    case 'duration':
      orderBy.callDuration = sortOrder;
      break;
    case 'company':
      orderBy.companyName = sortOrder;
      break;
    case 'role':
      orderBy.jobTitle = sortOrder;
      break;
    case 'date':
    default:
      orderBy.createdAt = sortOrder;
  }
  
  // Get interviews
  const interviews = await prisma.interview.findMany({
    where: whereClause,
    select: {
      id: true,
      createdAt: true,
      jobTitle: true,
      companyName: true,
      score: true,
      callDuration: true,
      status: true
    },
    orderBy
  });
  
  // Calculate summary
  const scores = interviews.map(i => i.score || 0).filter(s => s > 0);
  const totalDuration = interviews.reduce((sum, i) => sum + (i.callDuration || 0), 0);
  
  // Calculate improvement vs previous period
  let scoreImprovement = 0;
  if (startDate && endDate) {
    const periodLength = endDate.getTime() - startDate.getTime();
    const previousStart = new Date(startDate.getTime() - periodLength);
    const previousEnd = new Date(startDate.getTime() - 1);
    
    const previousInterviews = await prisma.interview.findMany({
      where: {
        userId: user.id,
        status: 'COMPLETED',
        createdAt: {
          gte: previousStart,
          lte: previousEnd
        }
      },
      select: { score: true }
    });
    
    const previousScores = previousInterviews.map(i => i.score || 0).filter(s => s > 0);
    const previousAvg = previousScores.length > 0 
      ? previousScores.reduce((a, b) => a + b, 0) / previousScores.length 
      : 0;
    const currentAvg = scores.length > 0 
      ? scores.reduce((a, b) => a + b, 0) / scores.length 
      : 0;
    
    scoreImprovement = previousAvg > 0 
      ? Math.round(((currentAvg - previousAvg) / previousAvg) * 100)
      : 0;
  }
  
  // Get chart data
  const [scoreTimeSeries, scoresByRole, scoresByCompany] = await Promise.all([
    getScoreTimeSeries(clerkId, 'daily', { startDate, endDate }),
    getScoresByRole(clerkId, { startDate, endDate }),
    getScoresByCompany(clerkId, { startDate, endDate })
  ]);
  
  return {
    interviews: interviews.map(i => ({
      id: i.id,
      date: i.createdAt,
      role: i.jobTitle,
      company: i.companyName,
      score: i.score || 0,
      duration: i.callDuration || 0,
      status: i.status
    })),
    summary: {
      totalInterviews: interviews.length,
      avgScore: scores.length > 0 
        ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10
        : 0,
      bestScore: scores.length > 0 ? Math.max(...scores) : 0,
      worstScore: scores.length > 0 ? Math.min(...scores) : 0,
      totalDuration,
      scoreImprovement
    },
    charts: {
      scoreTimeSeries,
      scoresByRole,
      scoresByCompany
    }
  };
}

/**
 * Compare two interviews
 */
export async function compareInterviews(
  clerkId: string,
  interviewId1: string,
  interviewId2: string
): Promise<ComparisonResult | null> {
  const user = await prisma.user.findUnique({
    where: { clerkId },
    select: { id: true }
  });
  
  if (!user) return null;
  
  // Get both interviews with score history
  const [interview1, interview2, scoreHistory1, scoreHistory2] = await Promise.all([
    prisma.interview.findFirst({
      where: { id: interviewId1, userId: user.id },
      select: {
        id: true,
        createdAt: true,
        jobTitle: true,
        companyName: true,
        score: true,
        callDuration: true,
        status: true
      }
    }),
    prisma.interview.findFirst({
      where: { id: interviewId2, userId: user.id },
      select: {
        id: true,
        createdAt: true,
        jobTitle: true,
        companyName: true,
        score: true,
        callDuration: true,
        status: true
      }
    }),
    prisma.interviewScoreHistory.findFirst({
      where: { interviewId: interviewId1 }
    }),
    prisma.interviewScoreHistory.findFirst({
      where: { interviewId: interviewId2 }
    })
  ]);
  
  if (!interview1) return null;
  
  const current: InterviewSummary = {
    id: interview1.id,
    date: interview1.createdAt,
    role: interview1.jobTitle,
    company: interview1.companyName,
    score: interview1.score || 0,
    duration: interview1.callDuration || 0,
    status: interview1.status
  };
  
  const comparison: InterviewSummary | null = interview2 ? {
    id: interview2.id,
    date: interview2.createdAt,
    role: interview2.jobTitle,
    company: interview2.companyName,
    score: interview2.score || 0,
    duration: interview2.callDuration || 0,
    status: interview2.status
  } : null;
  
  // Calculate differences
  const differences = {
    overallScore: comparison ? current.score - comparison.score : 0,
    duration: comparison ? current.duration - comparison.duration : 0,
    communicationScore: scoreHistory1 && scoreHistory2 
      ? (scoreHistory1.communicationScore || 0) - (scoreHistory2.communicationScore || 0)
      : undefined,
    technicalScore: scoreHistory1 && scoreHistory2
      ? (scoreHistory1.technicalScore || 0) - (scoreHistory2.technicalScore || 0)
      : undefined,
    confidenceScore: scoreHistory1 && scoreHistory2
      ? (scoreHistory1.confidenceScore || 0) - (scoreHistory2.confidenceScore || 0)
      : undefined
  };
  
  // Identify improvements and regressions
  const improvements: string[] = [];
  const regressions: string[] = [];
  
  if (differences.overallScore > 5) improvements.push('Overall score improved significantly');
  else if (differences.overallScore < -5) regressions.push('Overall score decreased');
  
  if (differences.communicationScore !== undefined) {
    if (differences.communicationScore > 5) improvements.push('Communication skills improved');
    else if (differences.communicationScore < -5) regressions.push('Communication score decreased');
  }
  
  if (differences.technicalScore !== undefined) {
    if (differences.technicalScore > 5) improvements.push('Technical responses improved');
    else if (differences.technicalScore < -5) regressions.push('Technical depth decreased');
  }
  
  if (differences.confidenceScore !== undefined) {
    if (differences.confidenceScore > 5) improvements.push('Confidence level increased');
    else if (differences.confidenceScore < -5) regressions.push('Confidence appeared lower');
  }
  
  if (differences.duration > 60) improvements.push('Provided more thorough responses');
  else if (differences.duration < -60) regressions.push('Interview was notably shorter');
  
  return {
    current,
    comparison,
    differences,
    improvements,
    regressions
  };
}

/**
 * Get interview progression (same role/company over time)
 */
export async function getInterviewProgression(
  clerkId: string,
  options: {
    role?: string;
    company?: string;
    limit?: number;
  } = {}
): Promise<{
  interviews: InterviewSummary[];
  trendLine: { date: string; score: number }[];
  averageImprovement: number;
}> {
  const { role, company, limit = 20 } = options;
  
  const user = await prisma.user.findUnique({
    where: { clerkId },
    select: { id: true }
  });
  
  if (!user) {
    return { interviews: [], trendLine: [], averageImprovement: 0 };
  }
  
  const whereClause: any = {
    userId: user.id,
    status: 'COMPLETED'
  };
  
  if (role) whereClause.jobTitle = role;
  if (company) whereClause.companyName = company;
  
  const interviews = await prisma.interview.findMany({
    where: whereClause,
    select: {
      id: true,
      createdAt: true,
      jobTitle: true,
      companyName: true,
      score: true,
      callDuration: true,
      status: true
    },
    orderBy: { createdAt: 'asc' },
    take: limit
  });
  
  const summaries: InterviewSummary[] = interviews.map(i => ({
    id: i.id,
    date: i.createdAt,
    role: i.jobTitle,
    company: i.companyName,
    score: i.score || 0,
    duration: i.callDuration || 0,
    status: i.status
  }));
  
  // Calculate trend line
  const trendLine = summaries.map(s => ({
    date: s.date.toISOString().split('T')[0],
    score: s.score
  }));
  
  // Calculate average improvement between consecutive interviews
  let totalImprovement = 0;
  let comparisons = 0;
  
  for (let i = 1; i < summaries.length; i++) {
    const improvement = summaries[i].score - summaries[i - 1].score;
    totalImprovement += improvement;
    comparisons++;
  }
  
  const averageImprovement = comparisons > 0 
    ? Math.round((totalImprovement / comparisons) * 10) / 10
    : 0;
  
  return {
    interviews: summaries,
    trendLine,
    averageImprovement
  };
}

/**
 * Get enhanced filter options with counts
 */
export async function getEnhancedFilterOptions(clerkId: string): Promise<{
  roles: { name: string; count: number }[];
  companies: { name: string; count: number }[];
  dateRange: { earliest: Date | null; latest: Date | null };
  scoreRange: { min: number; max: number };
}> {
  const user = await prisma.user.findUnique({
    where: { clerkId },
    select: { id: true }
  });
  
  if (!user) {
    return {
      roles: [],
      companies: [],
      dateRange: { earliest: null, latest: null },
      scoreRange: { min: 0, max: 100 }
    };
  }
  
  // Get roles with counts
  const roleGroups = await prisma.interview.groupBy({
    by: ['jobTitle'],
    where: { userId: user.id, status: 'COMPLETED' },
    _count: { id: true }
  });
  
  // Get companies with counts
  const companyGroups = await prisma.interview.groupBy({
    by: ['companyName'],
    where: { userId: user.id, status: 'COMPLETED' },
    _count: { id: true }
  });
  
  // Get date and score ranges
  const aggregate = await prisma.interview.aggregate({
    where: { userId: user.id, status: 'COMPLETED' },
    _min: { createdAt: true, score: true },
    _max: { createdAt: true, score: true }
  });
  
  return {
    roles: roleGroups
      .map(r => ({ name: r.jobTitle, count: r._count.id }))
      .sort((a, b) => b.count - a.count),
    companies: companyGroups
      .map(c => ({ name: c.companyName, count: c._count.id }))
      .sort((a, b) => b.count - a.count),
    dateRange: {
      earliest: aggregate._min.createdAt,
      latest: aggregate._max.createdAt
    },
    scoreRange: {
      min: aggregate._min.score || 0,
      max: aggregate._max.score || 100
    }
  };
}
