/**
 * Performance Chat Service
 * AI-powered interview performance analysis using Google Gemini (primary) and OpenAI (fallback)
 * 
 * Features:
 * - Contextual performance chat based on interview transcripts
 * - Role and company filtering
 * - Chat session management
 * - Automatic fallback to OpenAI if Gemini fails
 */

import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
import OpenAI from 'openai';
import { prisma, dbLogger } from './databaseService';
import { getScoresByRole, getScoresByCompany, getAvailableFilters } from './analyticsService';

// ========================================
// CONFIGURATION
// ========================================

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-pro';
const OPENAI_MODEL = process.env.OPENAI_CHAT_MODEL || 'gpt-4o';
const MAX_CONTEXT_TOKENS = 100000; // Leave room for response
const MAX_INTERVIEWS_IN_CONTEXT = 10;

// LLM Provider enum
type LLMProvider = 'gemini' | 'openai';

// ========================================
// SYSTEM PROMPT - VOCAID HR INTELLIGENCE CHAT
// ========================================

const PERFORMANCE_ANALYST_PROMPT = `You are "Vocaid HR Intelligence Chat", a context-aware assistant that supports BOTH:
(1) HR FAQ Concierge (employee support via knowledge base) and
(2) Interview Performance Analyst (recruiter/hiring team insights via interview context).

## PRIMARY GOAL
Provide accurate, actionable answers using application context and approved knowledge sources, and continuously propose small, safe feature upgrades based on missing context or repeated user needs.

## OPERATING MODES
Auto-select one mode per message (or ask 1 clarifying question if ambiguous):

### A) FAQ MODE
Triggers: policies, benefits, payroll timing, leave, internal processes, "how do I…", credits, billing, technical issues
- Provide clear, helpful answers about Vocaid's features
- Guide users through troubleshooting steps  
- Reference the FAQ knowledge base provided
- If policy not found → offer escalation

### B) INTERVIEW INSIGHTS MODE
Triggers: candidate performance, scorecards, rubrics, transcript analysis, follow-ups, improvements
- Analyze interview transcripts to identify patterns in responses
- Produce evidence-based insights with competency score breakdown
- Identify what was covered vs missed
- Show strong/weak signals tied to rubric anchors
- Recommend follow-ups for next round
- Suggest interview kit improvements
- Support multi-language interviews and summaries

## FIRST STEP (ALWAYS)
Load and use "application context" before answering.
Application context includes:
- User role and organization
- Knowledge base sources (policy docs, SOPs)
- Interview Kit (job title, level, competencies, questions, rubrics, weights)
- Candidate profile, resume, job description (if available)
- Interview session data (transcript, timestamps, scores, reviewer notes)
- Language preferences (user and candidate)

If context is missing, ask ONLY for the minimum missing detail OR proceed with clearly stated assumptions.

## SAFETY, FAIRNESS, AND PRIVACY (HARD RULES)
- Never invent policy. In FAQ mode, if you cannot retrieve a supporting source, say so and offer escalation.
- Never ask about protected characteristics (race, religion, health, disability, pregnancy, sexual orientation, age, family status). Do not score on these or infer them.
- Keep outputs job-relevant and evidence-based.
- Do not reveal confidential or cross-tenant information.
- Hiring decisions belong to humans. Provide recommendations with rationale, not "final decisions".

## SCORE INTERPRETATION
- 0-40: Needs significant improvement - focus on fundamentals
- 40-60: Developing skills - specific areas to focus on
- 60-80: Good performance - minor refinements needed
- 80-100: Excellent - focus on edge cases and advanced topics

## FAQ MODE BEHAVIOR
1. Retrieve relevant KB sections for the question
2. Answer clearly and concisely
3. Provide official reference: doc title + section
4. Offer next best action:
   - start workflow (if supported)
   - open ticket / escalate (if unmapped, conflicting, or sensitive)

## INTERVIEW INSIGHTS MODE BEHAVIOR
1. Identify the interview kit and rubric (job title/level/competencies/weights)
2. Analyze transcript and produce:
   - Competency score breakdown (1-5 or 0-100) aligned to rubric anchors
   - Evidence bullets with short quotes + timestamps
   - Coverage gaps: what was not tested
   - Risks/unknowns: what needs verification
   - Next-round follow-ups (neutral, non-coaching)
3. Provide "Kit Improvement Suggestions" when relevant:
   - unclear questions, missing competencies, biased wording, timebox issues
4. If resume/JD is available:
   - Resume-to-rubric alignment (what matches, what needs probing)
   - Suggested targeted questions based on gaps (still job-relevant)

## MULTI-LANGUAGE SUPPORT
- Detect the user's language and respond in it by default
- If candidate responses are in a different language, provide:
  - translated summary + original-language quote snippets
  - scoring based on content, not fluency, unless the role explicitly requires that language

## OUTPUT FORMAT (BEAUTIFIED, CONSISTENT)
Use this structure in your responses:

**📋 Answer / Insight**
[Your main response here]

**📊 Evidence** (when applicable)
[KB citations, transcript quotes with timestamps, or data points]

**⚡ Actions** (when applicable)
[What actions can be taken: Export Scorecard, Open Ticket, Generate Follow-ups, etc.]

**➡️ Next Step**
[One helpful follow-up question or recommended action]

**💡 Upgrade Suggestion** (only when useful)
[Small, safe feature upgrade idea based on missing context or user needs]

## ESCALATION RULES
Escalate if:
- Policy not found / conflicting
- Sensitive employee issue (harassment, threats, investigations)
- User requests exceptions or legal/medical advice
- Interview data missing but user needs a decision-critical answer

## PRODUCT DISCOVERY ENGINE
When helpful, propose 1-3 incremental enhancements:
- "Upgrade idea"
- "Why it helps"
- "What context/data is needed"
Examples:
- Resume upload + parsing
- Company/job-title templates & benchmarking
- Multi-language auto-translation + bilingual scorecards
- Kit versioning + A/B testing for question quality

## TONE
Professional, empathetic, concise. Typography-first (minimal emojis in body). Focus on next steps.

## FAQ KNOWLEDGE BASE:
{{FAQ_CONTEXT}}

## REMEMBER
If you didn't retrieve supporting context, say what's missing and either:
- ask a minimal question, or
- offer escalation, or
- provide a safe "best-effort draft" clearly labeled as an assumption.`;

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
// LLM CLIENT INITIALIZATION
// ========================================

/**
 * Initialize Gemini client
 */
function getGeminiClient(): GoogleGenerativeAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    dbLogger.warn('GEMINI_API_KEY is not set, will use fallback provider');
    return null;
  }
  return new GoogleGenerativeAI(apiKey);
}

/**
 * Initialize OpenAI client
 */
function getOpenAIClient(): OpenAI | null {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    dbLogger.warn('OPENAI_API_KEY is not set');
    return null;
  }
  return new OpenAI({ apiKey });
}

/**
 * Determine which LLM provider to use
 */
function getAvailableProvider(): LLMProvider {
  if (process.env.GEMINI_API_KEY) {
    return 'gemini';
  }
  if (process.env.OPENAI_API_KEY) {
    return 'openai';
  }
  throw new Error('No LLM API key configured. Set either GEMINI_API_KEY or OPENAI_API_KEY');
}

// ========================================
// CONTEXT BUILDING
// ========================================

/**
 * Build performance context for a user
 */
export async function buildPerformanceContext(
  userId: string,
  filters: ChatContext = {}
): Promise<PerformanceContext> {
  // Get user's UUID
  const user = await prisma.user.findUnique({
    where: { id: userId },
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
    getScoresByRole(userId, { limit: 10 }),
    getScoresByCompany(userId, { limit: 10 }),
    getAvailableFilters(userId)
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
 * Format context for LLM
 */
function formatContextForLLM(context: PerformanceContext): string {
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
  userId: string,
  filters: ChatContext = {}
): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
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
// GEMINI CHAT COMPLETION
// ========================================

/**
 * Get chat completion from Gemini
 */
async function getGeminiCompletion(
  systemPrompt: string,
  messages: ChatMessage[],
  userMessage: string
): Promise<{ content: string; usage: { inputTokens: number; outputTokens: number } }> {
  const genAI = getGeminiClient();
  if (!genAI) {
    throw new Error('Gemini client not available');
  }

  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    systemInstruction: systemPrompt,
    safetySettings: [
      {
        category: HarmCategory.HARM_CATEGORY_HARASSMENT,
        threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
      },
      {
        category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
        threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
      },
      {
        category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
        threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
      },
      {
        category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
        threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
      },
    ],
    generationConfig: {
      maxOutputTokens: 4096,
      temperature: 0.7,
    },
  });

  // Build chat history
  const history = messages.map(m => ({
    role: m.role === 'user' ? 'user' as const : 'model' as const,
    parts: [{ text: m.content }]
  }));

  const chat = model.startChat({ history });

  const result = await chat.sendMessage(userMessage);
  const response = result.response;

  const content = response.text();
  const usageMetadata = response.usageMetadata;

  return {
    content,
    usage: {
      inputTokens: usageMetadata?.promptTokenCount || 0,
      outputTokens: usageMetadata?.candidatesTokenCount || 0
    }
  };
}

// ========================================
// OPENAI CHAT COMPLETION (FALLBACK)
// ========================================

/**
 * Get chat completion from OpenAI (fallback)
 */
async function getOpenAICompletion(
  systemPrompt: string,
  messages: ChatMessage[],
  userMessage: string
): Promise<{ content: string; usage: { inputTokens: number; outputTokens: number } }> {
  const openai = getOpenAIClient();
  if (!openai) {
    throw new Error('OpenAI client not available');
  }

  const openaiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...messages.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content
    })),
    { role: 'user', content: userMessage }
  ];

  const response = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages: openaiMessages,
    max_tokens: 4096,
    temperature: 0.7
  });

  const content = response.choices[0]?.message?.content || '';

  return {
    content,
    usage: {
      inputTokens: response.usage?.prompt_tokens || 0,
      outputTokens: response.usage?.completion_tokens || 0
    }
  };
}

// ========================================
// UNIFIED CHAT COMPLETION
// ========================================

/**
 * Default FAQ context if not provided from frontend
 * Organized by category for HR Intelligence Chat
 */
const DEFAULT_FAQ_CONTEXT = `
## BILLING & CREDITS
Q: How do credits work?
A: Each mock interview costs 1 credit. Credits never expire and can be purchased in packages. You receive free trial credits when you sign up.

Q: How do I purchase more credits?
A: Navigate to the Credits page from your dashboard. We offer packages: Starter (5 credits), Professional (15 credits), and Enterprise (50 credits). Payment is processed securely via MercadoPago.

Q: Can I get a refund?
A: Credits are non-refundable once purchased. However, if you experience technical issues during an interview, please contact support and we will review your case.

Q: What payment methods are accepted?
A: We accept credit cards, debit cards, and local payment methods via MercadoPago. Payment processing is secure and PCI-compliant.

## HOW VOCAID WORKS
Q: How does Vocaid work?
A: Vocaid uses AI to simulate realistic job interviews. You upload your resume, select a target role and company, then have a voice conversation with our AI interviewer. After the interview, you receive detailed feedback and a performance score.

Q: What happens during an interview?
A: Once you start an interview, you will be connected to our AI interviewer via voice. The AI asks role-specific questions based on your resume and target position. Speak naturally - it is a conversational experience. Interviews typically last 10-15 minutes.

Q: How is my score calculated?
A: Your score (0-100) is based on: Technical Knowledge (relevant skills and concepts), Communication (clarity, structure, conciseness), Confidence (tone, pacing, assertiveness), and Overall Performance (how well you would perform in a real interview).

Q: What does the scorecard show?
A: The scorecard provides a competency breakdown with scores for each evaluated area, specific quotes from your responses as evidence, areas of strength, and targeted improvement suggestions.

## TROUBLESHOOTING
Q: The AI cannot hear me / Audio issues
A: Make sure your browser has microphone permissions enabled. Use Chrome or Edge for best compatibility. Check that your microphone is selected in system settings. Try using headphones to avoid echo. Ensure you are in a quiet environment.

Q: My interview disconnected or froze
A: Network issues can cause disconnections. Ensure you have a stable internet connection (Wi-Fi or wired). If the interview fails, your credit will typically be restored automatically. Contact support if this does not happen within 24 hours.

Q: Supported browsers
A: Vocaid works best on Google Chrome (recommended), Microsoft Edge, and Safari (latest version). Firefox may have limited audio support. Always use the latest browser version.

Q: Video not working / Camera issues
A: Vocaid currently uses voice-only interviews. No camera access is required. If you are being asked for camera permissions, please refresh the page or clear your browser cache.

## FEATURES & CUSTOMIZATION
Q: Can I practice for specific companies?
A: Yes! When setting up an interview, enter the company name. Our AI tailors questions based on the company's known interview style, values, and technical requirements.

Q: What roles can I practice for?
A: Vocaid supports all professional roles: Software Engineering, Data Science, Product Management, Design, Marketing, Sales, Finance, HR, Operations, and more. Just enter your target job title.

Q: Can I review past interviews?
A: Yes, go to your Dashboard and click on any completed interview to see the full transcript, feedback, and performance breakdown. You can track your progress over time.

Q: Can I practice in different languages?
A: Yes, Vocaid supports multiple languages including English, Spanish, Portuguese, French, German, Italian, Japanese, and Chinese. Select your preferred language during interview setup.

Q: Can I upload my resume?
A: Yes, you can upload your resume during interview setup. The AI uses your resume to personalize questions based on your experience and target the relevant skills for your desired role.

## ACCOUNT & PRIVACY
Q: How is my data protected?
A: Your data is encrypted and stored securely. We never share your interview recordings or transcripts with third parties. You can request data deletion at any time.

Q: Can I delete my interview history?
A: Yes, you can delete individual interviews from your Dashboard. For complete account deletion, please contact support.

## INTERVIEW INSIGHTS (For Hiring Teams)
Q: How do I analyze candidate performance?
A: Ask about any interview by saying "Analyze my [role] interview at [company]" or "How did I do in my latest interview?" The AI will provide competency breakdowns, evidence-based insights, and improvement suggestions.

Q: What metrics are tracked?
A: We track overall score, technical knowledge, communication skills, confidence level, response quality, and progression over time. All metrics are based on evidence from the interview transcript.

Q: How can I compare interviews?
A: Ask "Compare my last two interviews" or "Show my progress over time" to see how your performance has changed across different practice sessions.
`;

/**
 * Get chat completion with automatic fallback and FAQ context
 */
export async function getChatCompletion(
  userId: string,
  message: string,
  sessionId?: string,
  filters: ChatContext = {},
  faqContext?: string
): Promise<{ message: string; sessionId: string; category: 'performance' | 'support' }> {
  // Build context
  const context = await buildPerformanceContext(userId, filters);
  const contextText = formatContextForLLM(context);
  
  // Inject FAQ context into system prompt
  const faqToInject = faqContext || DEFAULT_FAQ_CONTEXT;
  const basePrompt = PERFORMANCE_ANALYST_PROMPT.replace('{{FAQ_CONTEXT}}', faqToInject);
  const systemPrompt = `${basePrompt}\n\n${contextText}`;

  // Detect message category for response metadata
  const supportKeywords = ['credit', 'billing', 'payment', 'refund', 'audio', 'microphone', 'browser', 'error', 'how does', 'how do i', 'troubleshoot', 'purchase', 'buy', 'price', 'cost'];
  const messageLower = message.toLowerCase();
  const category: 'performance' | 'support' = supportKeywords.some(k => messageLower.includes(k)) 
    ? 'support' 
    : 'performance';

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
  const activeSessionId = sessionId || await createChatSession(userId, filters);

  // Save user message
  await saveChatMessage(activeSessionId, 'user', message, { category });

  let provider: LLMProvider = getAvailableProvider();
  let assistantMessage: string;
  let usage: { inputTokens: number; outputTokens: number };

  try {
    // Try primary provider (Gemini)
    if (provider === 'gemini') {
      try {
        const result = await getGeminiCompletion(systemPrompt, previousMessages, message);
        assistantMessage = result.content;
        usage = result.usage;
        
        dbLogger.info('Chat completion generated via Gemini', {
          sessionId: activeSessionId,
          category,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens
        });
      } catch (geminiError: any) {
        dbLogger.warn('Gemini completion failed, falling back to OpenAI', {
          error: geminiError.message,
          sessionId: activeSessionId
        });
        
        // Fallback to OpenAI
        if (!process.env.OPENAI_API_KEY) {
          throw geminiError; // Re-throw if no fallback available
        }
        
        provider = 'openai';
        const result = await getOpenAICompletion(systemPrompt, previousMessages, message);
        assistantMessage = result.content;
        usage = result.usage;
        
        dbLogger.info('Chat completion generated via OpenAI (fallback)', {
          sessionId: activeSessionId,
          category,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens
        });
      }
    } else {
      // Use OpenAI directly
      const result = await getOpenAICompletion(systemPrompt, previousMessages, message);
      assistantMessage = result.content;
      usage = result.usage;
      
      dbLogger.info('Chat completion generated via OpenAI', {
        sessionId: activeSessionId,
        category,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens
      });
    }

    // Save assistant message
    await saveChatMessage(activeSessionId, 'assistant', assistantMessage, {
      provider,
      category,
      model: provider === 'gemini' ? GEMINI_MODEL : OPENAI_MODEL,
      usage
    });

    return { 
      message: assistantMessage, 
      sessionId: activeSessionId,
      category 
    };
  } catch (error: any) {
    dbLogger.error('Chat completion failed', {
      error: error.message,
      sessionId: activeSessionId,
      provider
    });
    throw new Error('Failed to generate response. Please try again.');
  }
}

/**
 * Stream chat completion (for real-time UI updates)
 * Note: Uses Gemini streaming with OpenAI fallback
 */
export async function streamChatCompletion(
  userId: string,
  message: string,
  onChunk: (chunk: string) => void,
  sessionId?: string,
  filters: ChatContext = {}
): Promise<string> {
  // Build context
  const context = await buildPerformanceContext(userId, filters);
  const contextText = formatContextForLLM(context);
  const systemPrompt = `${PERFORMANCE_ANALYST_PROMPT}\n\n${contextText}`;

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
  const activeSessionId = sessionId || await createChatSession(userId, filters);

  // Save user message
  await saveChatMessage(activeSessionId, 'user', message);

  let provider: LLMProvider = getAvailableProvider();
  let fullResponse = '';

  try {
    if (provider === 'gemini') {
      try {
        fullResponse = await streamGeminiCompletion(systemPrompt, previousMessages, message, onChunk);
      } catch (geminiError: any) {
        dbLogger.warn('Gemini streaming failed, falling back to OpenAI', {
          error: geminiError.message,
          sessionId: activeSessionId
        });
        
        if (!process.env.OPENAI_API_KEY) {
          throw geminiError;
        }
        
        provider = 'openai';
        fullResponse = await streamOpenAICompletion(systemPrompt, previousMessages, message, onChunk);
      }
    } else {
      fullResponse = await streamOpenAICompletion(systemPrompt, previousMessages, message, onChunk);
    }

    // Save complete assistant message
    await saveChatMessage(activeSessionId, 'assistant', fullResponse, {
      provider,
      model: provider === 'gemini' ? GEMINI_MODEL : OPENAI_MODEL
    });

    return fullResponse;
  } catch (error: any) {
    dbLogger.error('Chat stream failed', {
      error: error.message,
      sessionId: activeSessionId,
      provider
    });
    throw new Error('Failed to generate response. Please try again.');
  }
}

/**
 * Stream completion from Gemini
 */
async function streamGeminiCompletion(
  systemPrompt: string,
  messages: ChatMessage[],
  userMessage: string,
  onChunk: (chunk: string) => void
): Promise<string> {
  const genAI = getGeminiClient();
  if (!genAI) {
    throw new Error('Gemini client not available');
  }

  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    systemInstruction: systemPrompt,
    safetySettings: [
      {
        category: HarmCategory.HARM_CATEGORY_HARASSMENT,
        threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
      },
      {
        category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
        threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
      },
      {
        category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
        threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
      },
      {
        category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
        threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
      },
    ],
    generationConfig: {
      maxOutputTokens: 4096,
      temperature: 0.7,
    },
  });

  const history = messages.map(m => ({
    role: m.role === 'user' ? 'user' as const : 'model' as const,
    parts: [{ text: m.content }]
  }));

  const chat = model.startChat({ history });

  const result = await chat.sendMessageStream(userMessage);

  let fullResponse = '';
  for await (const chunk of result.stream) {
    const text = chunk.text();
    fullResponse += text;
    onChunk(text);
  }

  return fullResponse;
}

/**
 * Stream completion from OpenAI
 */
async function streamOpenAICompletion(
  systemPrompt: string,
  messages: ChatMessage[],
  userMessage: string,
  onChunk: (chunk: string) => void
): Promise<string> {
  const openai = getOpenAIClient();
  if (!openai) {
    throw new Error('OpenAI client not available');
  }

  const openaiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...messages.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content
    })),
    { role: 'user', content: userMessage }
  ];

  const stream = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages: openaiMessages,
    max_tokens: 4096,
    temperature: 0.7,
    stream: true
  });

  let fullResponse = '';
  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content || '';
    if (text) {
      fullResponse += text;
      onChunk(text);
    }
  }

  return fullResponse;
}

// ========================================
// QUICK INSIGHTS
// ========================================

/**
 * Generate quick performance insights without chat context
 */
export async function generateQuickInsights(userId: string): Promise<string> {
  const context = await buildPerformanceContext(userId);
  
  if (context.aggregatedMetrics.totalInterviews === 0) {
    return "You haven't completed any interviews yet. Start a practice interview to get personalized insights!";
  }

  const prompt = `Based on this user's interview data, provide 3-5 brief, actionable insights to help them improve. Be specific and encouraging.

${formatContextForLLM(context)}

Format your response as bullet points, each starting with an emoji that represents the insight type (💪 for strengths, 📈 for improvement areas, 💡 for tips).`;

  let provider: LLMProvider = getAvailableProvider();

  try {
    if (provider === 'gemini') {
      try {
        const genAI = getGeminiClient();
        if (!genAI) throw new Error('Gemini not available');
        
        const model = genAI.getGenerativeModel({
          model: GEMINI_MODEL,
          generationConfig: { maxOutputTokens: 1024, temperature: 0.7 }
        });
        
        const result = await model.generateContent(prompt);
        return result.response.text();
      } catch (geminiError: any) {
        dbLogger.warn('Gemini quick insights failed, falling back to OpenAI', { 
          error: geminiError.message 
        });
        
        if (!process.env.OPENAI_API_KEY) throw geminiError;
        provider = 'openai';
      }
    }
    
    // OpenAI fallback or primary
    const openai = getOpenAIClient();
    if (!openai) throw new Error('OpenAI not available');
    
    const response = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1024,
      temperature: 0.7
    });
    
    return response.choices[0]?.message?.content || 'Unable to generate insights.';
  } catch (error: any) {
    dbLogger.error('Quick insights generation failed', { error: error.message });
    return 'Unable to generate insights at this time. Please try again later.';
  }
}

/**
 * Get user's chat sessions
 */
export async function getUserChatSessions(userId: string, limit = 10) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
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
