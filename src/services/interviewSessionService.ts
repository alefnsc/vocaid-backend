/**
 * Interview Session Service
 * 
 * Manages detailed metrics logging for interview calls.
 * Tracks timing, token usage, costs, and quality signals.
 * 
 * @module services/interviewSessionService
 */

import { PrismaClient, InterviewEndReason } from '@prisma/client';
import { wsLogger } from '../utils/logger';

const prisma = new PrismaClient();

// ========================================
// TYPES
// ========================================

export interface CreateSessionParams {
  interviewId: string;
  retellCallId?: string;
  retellAgentId?: string;
  language: string;
  roleTitle: string;
  seniority?: string;
  roleCountry?: string;
}

export interface UpdateSessionTimingParams {
  callStartedAt?: Date;
  firstAgentUtteranceAt?: Date;
  callEndedAt?: Date;
  timeToFirstToken?: number;
  timeToFirstAudio?: number;
}

export interface UpdateSessionTokensParams {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
  llmModel?: string;
  llmProvider?: string;
}

export interface UpdateSessionMetricsParams {
  transcriptLength?: number;
  totalTurns?: number;
  agentTurns?: number;
  userTurns?: number;
  avgResponseLatency?: number;
  clarificationTurns?: number;
  silenceCount?: number;
}

export interface FinalizeSessionParams {
  endReason: InterviewEndReason;
  completionRate?: number;
  retellDurationSec?: number;
  retellDisconnectReason?: string;
}

// OpenAI Pricing (GPT-4o as of Dec 2024)
const OPENAI_PRICING = {
  'gpt-4o': { promptPer1k: 0.0025, completionPer1k: 0.01 },
  'gpt-4o-mini': { promptPer1k: 0.00015, completionPer1k: 0.0006 },
  'gpt-4-turbo': { promptPer1k: 0.01, completionPer1k: 0.03 },
  'gpt-4': { promptPer1k: 0.03, completionPer1k: 0.06 },
  'gpt-3.5-turbo': { promptPer1k: 0.0005, completionPer1k: 0.0015 },
};

// ========================================
// SERVICE FUNCTIONS
// ========================================

/**
 * Create a new interview session for metrics tracking
 */
export async function createInterviewSession(params: CreateSessionParams) {
  wsLogger.info('Creating interview session for metrics', {
    interviewId: params.interviewId,
    language: params.language,
    roleTitle: params.roleTitle,
  });

  try {
    const session = await prisma.interviewSession.create({
      data: {
        interviewId: params.interviewId,
        retellCallId: params.retellCallId,
        retellAgentId: params.retellAgentId,
        language: params.language,
        roleTitle: params.roleTitle,
        seniority: params.seniority,
        roleCountry: params.roleCountry,
        callStartedAt: new Date(),
      },
    });

    wsLogger.info('Interview session created', { sessionId: session.id });
    return session;
  } catch (error: any) {
    wsLogger.error('Failed to create interview session', { 
      error: error.message,
      interviewId: params.interviewId,
    });
    throw error;
  }
}

/**
 * Get or create session by interview ID
 */
export async function getOrCreateSession(params: CreateSessionParams) {
  const existing = await prisma.interviewSession.findUnique({
    where: { interviewId: params.interviewId },
  });

  if (existing) {
    return existing;
  }

  return createInterviewSession(params);
}

/**
 * Update session timing metrics
 */
export async function updateSessionTiming(
  interviewId: string,
  params: UpdateSessionTimingParams
) {
  wsLogger.debug('Updating session timing', { interviewId, params });

  try {
    return await prisma.interviewSession.update({
      where: { interviewId },
      data: params,
    });
  } catch (error: any) {
    wsLogger.error('Failed to update session timing', { 
      error: error.message,
      interviewId,
    });
    throw error;
  }
}

/**
 * Update session token usage (accumulative)
 */
export async function updateSessionTokens(
  interviewId: string,
  params: UpdateSessionTokensParams
) {
  wsLogger.debug('Updating session tokens', { interviewId, tokens: params.totalTokens });

  try {
    // Get current session to accumulate tokens
    const session = await prisma.interviewSession.findUnique({
      where: { interviewId },
    });

    if (!session) {
      wsLogger.warn('Session not found for token update', { interviewId });
      return null;
    }

    const newPromptTokens = (session.promptTokens || 0) + (params.promptTokens || 0);
    const newCompletionTokens = (session.completionTokens || 0) + (params.completionTokens || 0);
    const newTotalTokens = newPromptTokens + newCompletionTokens;

    // Calculate cost based on model
    const model = params.llmModel || session.llmModel || 'gpt-4o';
    const pricing = OPENAI_PRICING[model as keyof typeof OPENAI_PRICING] || OPENAI_PRICING['gpt-4o'];
    const cost = (newPromptTokens / 1000 * pricing.promptPer1k) + 
                 (newCompletionTokens / 1000 * pricing.completionPer1k);

    return await prisma.interviewSession.update({
      where: { interviewId },
      data: {
        promptTokens: newPromptTokens,
        completionTokens: newCompletionTokens,
        totalTokens: newTotalTokens,
        estimatedCostUsd: cost,
        llmModel: params.llmModel || session.llmModel,
        llmProvider: params.llmProvider || session.llmProvider || 'openai',
      },
    });
  } catch (error: any) {
    wsLogger.error('Failed to update session tokens', { 
      error: error.message,
      interviewId,
    });
    throw error;
  }
}

/**
 * Update session metrics (transcript, turns, etc.)
 */
export async function updateSessionMetrics(
  interviewId: string,
  params: UpdateSessionMetricsParams
) {
  wsLogger.debug('Updating session metrics', { interviewId });

  try {
    return await prisma.interviewSession.update({
      where: { interviewId },
      data: params,
    });
  } catch (error: any) {
    wsLogger.error('Failed to update session metrics', { 
      error: error.message,
      interviewId,
    });
    throw error;
  }
}

/**
 * Record first agent utterance timestamp
 */
export async function recordFirstAgentUtterance(interviewId: string) {
  wsLogger.info('Recording first agent utterance', { interviewId });

  try {
    const session = await prisma.interviewSession.findUnique({
      where: { interviewId },
    });

    if (!session) {
      wsLogger.warn('Session not found for first utterance', { interviewId });
      return null;
    }

    // Only update if not already set
    if (session.firstAgentUtteranceAt) {
      return session;
    }

    const now = new Date();
    const timeToFirst = session.callStartedAt 
      ? now.getTime() - session.callStartedAt.getTime()
      : null;

    return await prisma.interviewSession.update({
      where: { interviewId },
      data: {
        firstAgentUtteranceAt: now,
        timeToFirstAudio: timeToFirst,
      },
    });
  } catch (error: any) {
    wsLogger.error('Failed to record first utterance', { 
      error: error.message,
      interviewId,
    });
    throw error;
  }
}

/**
 * Increment clarification turn counter
 */
export async function incrementClarificationTurns(interviewId: string) {
  try {
    const session = await prisma.interviewSession.findUnique({
      where: { interviewId },
    });

    if (!session) return null;

    return await prisma.interviewSession.update({
      where: { interviewId },
      data: {
        clarificationTurns: (session.clarificationTurns || 0) + 1,
      },
    });
  } catch (error: any) {
    wsLogger.error('Failed to increment clarification turns', { 
      error: error.message,
      interviewId,
    });
    return null;
  }
}

/**
 * Increment silence counter
 */
export async function incrementSilenceCount(interviewId: string) {
  try {
    const session = await prisma.interviewSession.findUnique({
      where: { interviewId },
    });

    if (!session) return null;

    return await prisma.interviewSession.update({
      where: { interviewId },
      data: {
        silenceCount: (session.silenceCount || 0) + 1,
      },
    });
  } catch (error: any) {
    wsLogger.error('Failed to increment silence count', { 
      error: error.message,
      interviewId,
    });
    return null;
  }
}

/**
 * Finalize session with end reason and completion rate
 */
export async function finalizeSession(
  interviewId: string,
  params: FinalizeSessionParams
) {
  wsLogger.info('Finalizing interview session', { 
    interviewId, 
    endReason: params.endReason,
  });

  try {
    const session = await prisma.interviewSession.findUnique({
      where: { interviewId },
    });

    if (!session) {
      wsLogger.warn('Session not found for finalization', { interviewId });
      return null;
    }

    return await prisma.interviewSession.update({
      where: { interviewId },
      data: {
        callEndedAt: new Date(),
        endReason: params.endReason,
        completionRate: params.completionRate,
        retellDurationSec: params.retellDurationSec,
        retellDisconnectReason: params.retellDisconnectReason,
      },
    });
  } catch (error: any) {
    wsLogger.error('Failed to finalize session', { 
      error: error.message,
      interviewId,
    });
    throw error;
  }
}

/**
 * Get session by interview ID
 */
export async function getSessionByInterviewId(interviewId: string) {
  return prisma.interviewSession.findUnique({
    where: { interviewId },
  });
}

/**
 * Get session by Retell call ID
 */
export async function getSessionByRetellCallId(retellCallId: string) {
  return prisma.interviewSession.findFirst({
    where: { retellCallId },
  });
}

/**
 * Get aggregated session metrics for a user
 */
export async function getUserSessionMetrics(userId: string) {
  const result = await prisma.$queryRaw<Array<{
    total_sessions: bigint;
    completed_sessions: bigint;
    avg_duration_sec: number;
    total_tokens: bigint;
    total_cost_usd: number;
    avg_completion_rate: number;
    languages_used: string[];
  }>>`
    SELECT 
      COUNT(*) as total_sessions,
      COUNT(*) FILTER (WHERE end_reason = 'COMPLETED') as completed_sessions,
      AVG(retell_duration_sec) as avg_duration_sec,
      SUM(total_tokens) as total_tokens,
      SUM(estimated_cost_usd) as total_cost_usd,
      AVG(completion_rate) as avg_completion_rate,
      ARRAY_AGG(DISTINCT language) as languages_used
    FROM interview_sessions iss
    JOIN interviews i ON iss.interview_id = i.id
    WHERE i.user_id = ${userId}::uuid
  `;

  return result[0] || null;
}

export default {
  createInterviewSession,
  getOrCreateSession,
  updateSessionTiming,
  updateSessionTokens,
  updateSessionMetrics,
  recordFirstAgentUtterance,
  incrementClarificationTurns,
  incrementSilenceCount,
  finalizeSession,
  getSessionByInterviewId,
  getSessionByRetellCallId,
  getUserSessionMetrics,
};
