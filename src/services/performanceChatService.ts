/**
 * Performance Chat Service
 * AI-powered interview performance analysis using Anthropic Claude
 * 
 * Features:
 * - Contextual performance chat based on interview transcripts
 * - Role and company filtering
 * - Chat session management
 * - Streaming responses
 */

import Anthropic from '@anthropic-ai/sdk';
import { prisma, dbLogger } from './databaseService';
import { getScoresByRole, getScoresByCompany, getAvailableFilters } from './analyticsService';

// ========================================
// CONFIGURATION
// ========================================

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022';
const MAX_CONTEXT_TOKENS = 100000; // Leave room for response
const MAX_INTERVIEWS_IN_CONTEXT = 10;

// ========================================
// SYSTEM PROMPT
// ========================================

const PERFORMANCE_ANALYST_PROMPT = `You are a professional interview performance analyst for Voxly, an AI-powered mock interview platform. Your role is to help users understand and improve their interview performance based on their historical interview data.

## Your Capabilities:
1. Analyze interview transcripts to identify patterns in responses
2. Provide specific, actionable feedback on communication style
3. Identify technical knowledge gaps based on role requirements
4. Compare performance across different roles and companies
5. Track improvement trends over time
6. Suggest targeted practice areas

## Context You Have Access To:
- Interview transcripts (AI interviewer and user responses)
- Performance scores (overall, technical, communication, confidence)
- Role and company information for each interview
- Historical score progression

## Response Guidelines:
1. Be specific and cite examples from transcripts when possible
2. Use encouraging but honest language
3. Provide actionable next steps
4. Acknowledge improvement when evident
5. Keep responses concise but comprehensive
6. Use bullet points for clarity
7. When discussing specific interviews, reference them by role and company

## Score Interpretation:
- 0-40: Needs significant improvement - focus on fundamentals
- 40-60: Developing skills - specific areas to focus on
- 60-80: Good performance - minor refinements needed
- 80-100: Excellent - focus on edge cases and advanced topics

## Your Approach:
1. First, understand what the user is asking about
2. Look through the provided interview context for relevant data
3. Identify patterns and specific examples
4. Provide clear, actionable insights
5. End with specific recommendations

When the user asks about their performance, analyze the provided context and give personalized, data-driven insights. If they ask about a specific role or company, focus your analysis on relevant interviews.

Remember: You're here to help the user improve. Be supportive but honest.`;

// ========================================
// TYPES
// ========================================

export interface ChatContext {
  roleFilter?: string;
  companyFilter?: string;
  interviewIds?: string[];
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface InterviewContext {
  id: string;
  role: string;
  company: string;
  score: number | null;
  date: string;
  transcript: string | null;
  feedbackText: string | null;
  duration: number | null;
}

export interface PerformanceContext {
  interviews: InterviewContext[];
  aggregatedMetrics: {
    totalInterviews: number;
    avgScore: number;
    scoresByRole: { role: string; avgScore: number; count: number }[];
    scoresByCompany: { company: string; avgScore: number; count: number }[];
  };
  filters: {
    roles: string[];
    companies: string[];
  };
}

// ========================================
// CONTEXT BUILDING
// ========================================

/**
 * Build performance context for a user
 */
export async function buildPerformanceContext(
  clerkId: string,
  filters: ChatContext = {}
): Promise<PerformanceContext> {
  // Get user's UUID
  const user = await prisma.user.findUnique({
    where: { clerkId },
    select: { id: true }
  });

  if (!user) {
    throw new Error('User not found');
  }

  // Build where clause for interviews
  const where: any = {
    userId: user.id,
    status: 'COMPLETED'
  };

  if (filters.roleFilter) {
    where.jobTitle = { contains: filters.roleFilter, mode: 'insensitive' };
  }

  if (filters.companyFilter) {
    where.companyName = { contains: filters.companyFilter, mode: 'insensitive' };
  }

  if (filters.interviewIds && filters.interviewIds.length > 0) {
    where.id = { in: filters.interviewIds };
  }

  // Get interviews with transcripts
  const interviews = await prisma.interview.findMany({
    where,
    select: {
      id: true,
      jobTitle: true,
      companyName: true,
      score: true,
      createdAt: true,
      transcript: true,
      feedbackText: true,
      callDuration: true
    },
    orderBy: { createdAt: 'desc' },
    take: MAX_INTERVIEWS_IN_CONTEXT
  });

  // Get aggregated metrics
  const [scoresByRole, scoresByCompany, availableFilters] = await Promise.all([
    getScoresByRole(clerkId, { limit: 10 }),
    getScoresByCompany(clerkId, { limit: 10 }),
    getAvailableFilters(clerkId)
  ]);

  // Calculate overall stats
  const totalInterviews = interviews.length;
  const avgScore = totalInterviews > 0
    ? interviews.reduce((sum, i) => sum + (i.score || 0), 0) / totalInterviews
    : 0;

  const interviewContexts: InterviewContext[] = interviews.map(interview => ({
    id: interview.id,
    role: interview.jobTitle,
    company: interview.companyName,
    score: interview.score,
    date: interview.createdAt.toISOString().split('T')[0],
    transcript: interview.transcript,
    feedbackText: interview.feedbackText,
    duration: interview.callDuration
  }));

  return {
    interviews: interviewContexts,
    aggregatedMetrics: {
      totalInterviews,
      avgScore: Math.round(avgScore * 10) / 10,
      scoresByRole: scoresByRole.map(s => ({ 
        role: s.role, 
        avgScore: s.avgScore, 
        count: s.count 
      })),
      scoresByCompany: scoresByCompany.map(s => ({ 
        company: s.company, 
        avgScore: s.avgScore, 
        count: s.count 
      }))
    },
    filters: availableFilters
  };
}

/**
 * Format context for Claude
 */
function formatContextForClaude(context: PerformanceContext): string {
  let contextText = '## User Interview Performance Data\n\n';

  // Aggregated metrics
  contextText += '### Overall Performance Summary\n';
  contextText += `- Total Completed Interviews: ${context.aggregatedMetrics.totalInterviews}\n`;
  contextText += `- Average Score: ${context.aggregatedMetrics.avgScore}/100\n\n`;

  // Scores by role
  if (context.aggregatedMetrics.scoresByRole.length > 0) {
    contextText += '### Performance by Role\n';
    for (const role of context.aggregatedMetrics.scoresByRole) {
      contextText += `- ${role.role}: ${role.avgScore}/100 (${role.count} interviews)\n`;
    }
    contextText += '\n';
  }

  // Scores by company
  if (context.aggregatedMetrics.scoresByCompany.length > 0) {
    contextText += '### Performance by Company\n';
    for (const company of context.aggregatedMetrics.scoresByCompany) {
      contextText += `- ${company.company}: ${company.avgScore}/100 (${company.count} interviews)\n`;
    }
    contextText += '\n';
  }

  // Individual interviews with transcripts
  contextText += '### Interview Details\n\n';
  
  for (const interview of context.interviews) {
    contextText += `#### Interview: ${interview.role} at ${interview.company}\n`;
    contextText += `- Date: ${interview.date}\n`;
    contextText += `- Score: ${interview.score !== null ? `${interview.score}/100` : 'N/A'}\n`;
    contextText += `- Duration: ${interview.duration ? `${Math.round(interview.duration / 60)} minutes` : 'N/A'}\n`;
    
    if (interview.feedbackText) {
      contextText += `\nFeedback Summary:\n${interview.feedbackText.substring(0, 2000)}\n`;
    }
    
    if (interview.transcript) {
      // Truncate transcript if too long
      const transcriptPreview = interview.transcript.length > 5000
        ? interview.transcript.substring(0, 5000) + '... [transcript truncated]'
        : interview.transcript;
      contextText += `\nTranscript:\n${transcriptPreview}\n`;
    }
    
    contextText += '\n---\n\n';
  }

  return contextText;
}

// ========================================
// CHAT SESSION MANAGEMENT
// ========================================

/**
 * Create a new chat session
 */
export async function createChatSession(
  clerkId: string,
  filters: ChatContext = {}
): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { clerkId },
    select: { id: true }
  });

  if (!user) {
    throw new Error('User not found');
  }

  const session = await prisma.chatSession.create({
    data: {
      userId: user.id,
      roleFilter: filters.roleFilter,
      companyFilter: filters.companyFilter,
      isActive: true
    }
  });

  dbLogger.info('Chat session created', { 
    sessionId: session.id, 
    userId: user.id 
  });

  return session.id;
}

/**
 * Get chat session with messages
 */
export async function getChatSession(sessionId: string) {
  return prisma.chatSession.findUnique({
    where: { id: sessionId },
    include: {
      messages: {
        orderBy: { createdAt: 'asc' }
      }
    }
  });
}

/**
 * Save a message to a chat session
 */
export async function saveChatMessage(
  sessionId: string,
  role: 'user' | 'assistant',
  content: string,
  metadata?: Record<string, any>
) {
  return prisma.chatMessage.create({
    data: {
      sessionId,
      role,
      content,
      metadata
    }
  });
}

/**
 * Close a chat session
 */
export async function closeChatSession(sessionId: string) {
  return prisma.chatSession.update({
    where: { id: sessionId },
    data: { isActive: false }
  });
}

// ========================================
// CHAT COMPLETION
// ========================================

/**
 * Initialize Anthropic client
 */
function getAnthropicClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }
  return new Anthropic({ apiKey });
}

/**
 * Get chat completion from Claude
 */
export async function getChatCompletion(
  clerkId: string,
  message: string,
  sessionId?: string,
  filters: ChatContext = {}
): Promise<string> {
  const anthropic = getAnthropicClient();

  // Build context
  const context = await buildPerformanceContext(clerkId, filters);
  const contextText = formatContextForClaude(context);

  // Get previous messages if session exists
  let previousMessages: ChatMessage[] = [];
  if (sessionId) {
    const session = await getChatSession(sessionId);
    if (session) {
      previousMessages = session.messages.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content
      }));
    }
  }

  // Create session if not exists
  const activeSessionId = sessionId || await createChatSession(clerkId, filters);

  // Save user message
  await saveChatMessage(activeSessionId, 'user', message);

  // Build messages array for Claude
  const messages: Anthropic.MessageParam[] = [
    ...previousMessages.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content
    })),
    {
      role: 'user',
      content: message
    }
  ];

  try {
    const response = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 4096,
      system: `${PERFORMANCE_ANALYST_PROMPT}\n\n${contextText}`,
      messages
    });

    // Extract text from response
    const assistantMessage = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map(block => block.text)
      .join('\n');

    // Save assistant message
    await saveChatMessage(activeSessionId, 'assistant', assistantMessage, {
      model: ANTHROPIC_MODEL,
      usage: response.usage
    });

    dbLogger.info('Chat completion generated', {
      sessionId: activeSessionId,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens
    });

    return assistantMessage;
  } catch (error: any) {
    dbLogger.error('Chat completion failed', {
      error: error.message,
      sessionId: activeSessionId
    });
    throw new Error('Failed to generate response. Please try again.');
  }
}

/**
 * Stream chat completion from Claude (for real-time UI updates)
 */
export async function streamChatCompletion(
  clerkId: string,
  message: string,
  onChunk: (chunk: string) => void,
  sessionId?: string,
  filters: ChatContext = {}
): Promise<string> {
  const anthropic = getAnthropicClient();

  // Build context
  const context = await buildPerformanceContext(clerkId, filters);
  const contextText = formatContextForClaude(context);

  // Get previous messages if session exists
  let previousMessages: ChatMessage[] = [];
  if (sessionId) {
    const session = await getChatSession(sessionId);
    if (session) {
      previousMessages = session.messages.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content
      }));
    }
  }

  // Create session if not exists
  const activeSessionId = sessionId || await createChatSession(clerkId, filters);

  // Save user message
  await saveChatMessage(activeSessionId, 'user', message);

  // Build messages array
  const messages: Anthropic.MessageParam[] = [
    ...previousMessages.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content
    })),
    {
      role: 'user',
      content: message
    }
  ];

  let fullResponse = '';

  try {
    const stream = await anthropic.messages.stream({
      model: ANTHROPIC_MODEL,
      max_tokens: 4096,
      system: `${PERFORMANCE_ANALYST_PROMPT}\n\n${contextText}`,
      messages
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && 
          event.delta.type === 'text_delta') {
        const chunk = event.delta.text;
        fullResponse += chunk;
        onChunk(chunk);
      }
    }

    // Save complete assistant message
    await saveChatMessage(activeSessionId, 'assistant', fullResponse);

    return fullResponse;
  } catch (error: any) {
    dbLogger.error('Chat stream failed', {
      error: error.message,
      sessionId: activeSessionId
    });
    throw new Error('Failed to generate response. Please try again.');
  }
}

// ========================================
// QUICK INSIGHTS
// ========================================

/**
 * Generate quick performance insights without chat context
 */
export async function generateQuickInsights(clerkId: string): Promise<string> {
  const context = await buildPerformanceContext(clerkId);
  
  if (context.aggregatedMetrics.totalInterviews === 0) {
    return "You haven't completed any interviews yet. Start a practice interview to get personalized insights!";
  }

  const anthropic = getAnthropicClient();

  const prompt = `Based on this user's interview data, provide 3-5 brief, actionable insights to help them improve. Be specific and encouraging.

${formatContextForClaude(context)}

Format your response as bullet points, each starting with an emoji that represents the insight type (💪 for strengths, 📈 for improvement areas, 💡 for tips).`;

  try {
    const response = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    });

    return response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map(block => block.text)
      .join('\n');
  } catch (error: any) {
    dbLogger.error('Quick insights generation failed', { error: error.message });
    return 'Unable to generate insights at this time. Please try again later.';
  }
}

/**
 * Get user's chat sessions
 */
export async function getUserChatSessions(clerkId: string, limit = 10) {
  const user = await prisma.user.findUnique({
    where: { clerkId },
    select: { id: true }
  });

  if (!user) {
    return [];
  }

  return prisma.chatSession.findMany({
    where: { userId: user.id },
    include: {
      messages: {
        take: 1,
        orderBy: { createdAt: 'desc' }
      },
      _count: {
        select: { messages: true }
      }
    },
    orderBy: { updatedAt: 'desc' },
    take: limit
  });
}
