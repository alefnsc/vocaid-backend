/**
 * Post-Call Processing Service
 * 
 * Orchestrates all post-interview completion tasks:
 * - Fetch Retell transcript and call analysis
 * - Persist TranscriptSegment records
 * - Generate InterviewMetric records via OpenAI
 * - Generate StudyRecommendation via OpenAI
 * - Update Interview with final score and feedback
 * 
 * Designed to be called once per interview completion, idempotent.
 */

import { prisma, dbLogger } from './databaseService';
import { createTranscriptSegments, getTranscriptSegments, recordInterviewScore } from './analyticsService';
import OpenAI from 'openai';
import Retell from 'retell-sdk';
import { FeedbackGenerationService } from './feedbackGenerationService';
import { PDFGenerationService } from './pdfGenerationService';
import { storeFeedbackJson, storeFeedbackPdf } from './feedbackStorageService';
import { uploadFeedbackPdf, isAzureBlobEnabled } from './azureBlobService';

// ========================================
// TYPES
// ========================================

export interface PostCallResult {
  success: boolean;
  interviewId: string;
  transcriptSegmentsCount: number;
  metricsCount: number;
  hasStudyRecommendation: boolean;
  overallScore: number | null;
  error?: string;
}

interface RetellTranscriptSegment {
  role: 'agent' | 'user';
  content: string;
  words?: Array<{ word: string; start: number; end: number }>;
  sentiment?: string;
}

interface GeneratedMetrics {
  overallScore: number;
  categories: Array<{
    category: string;
    metricName: string;
    score: number;
    maxScore: number;
    feedback: string;
  }>;
}

interface GeneratedStudyPlan {
  topics: Array<{
    id: string;
    topic: string;
    priority: 'high' | 'medium' | 'low';
    reason: string;
    resources: string[];
    estimatedTime?: string;
  }>;
  weakAreas: Array<{
    area: string;
    score: number;
    suggestion: string;
  }>;
}

// ========================================
// OPENAI PROMPTS
// ========================================

const METRICS_SYSTEM_PROMPT = `You are an expert interview coach analyzing a mock interview. Based on the interview transcript, resume, and job description, generate performance metrics.

Return a JSON object with this exact structure:
{
  "overallScore": <number 0-100>,
  "categories": [
    {
      "category": "content",
      "metricName": "Content Quality",
      "score": <number 0-100>,
      "maxScore": 100,
      "feedback": "<specific feedback>"
    },
    {
      "category": "communication",
      "metricName": "Communication Skills",
      "score": <number 0-100>,
      "maxScore": 100,
      "feedback": "<specific feedback>"
    },
    {
      "category": "confidence",
      "metricName": "Confidence Level",
      "score": <number 0-100>,
      "maxScore": 100,
      "feedback": "<specific feedback>"
    },
    {
      "category": "technical",
      "metricName": "Technical Depth",
      "score": <number 0-100>,
      "maxScore": 100,
      "feedback": "<specific feedback>"
    }
  ]
}

Evaluate based on:
- Content: Relevance, depth, and accuracy of answers
- Communication: Clarity, structure, and articulation
- Confidence: Assertiveness, pace, and delivery
- Technical: Domain knowledge and problem-solving

Be constructive but honest. Provide actionable feedback.
Respond ONLY with valid JSON.`;

const STUDY_PLAN_SYSTEM_PROMPT = `You are an expert career coach. Based on the interview performance, generate a personalized study plan.

Return a JSON object with this exact structure:
{
  "topics": [
    {
      "id": "topic-1",
      "topic": "<topic name>",
      "priority": "high|medium|low",
      "reason": "<why this topic matters>",
      "resources": ["<resource 1>", "<resource 2>"],
      "estimatedTime": "<e.g., 2 hours>"
    }
  ],
  "weakAreas": [
    {
      "area": "<area name>",
      "score": <0-100>,
      "suggestion": "<how to improve>"
    }
  ]
}

Generate 3-6 study topics and 2-4 weak areas based on interview performance.
Respond ONLY with valid JSON.`;

// ========================================
// SERVICE CLASS
// ========================================

class PostCallProcessingService {
  private openai: OpenAI | null = null;
  private retell: Retell | null = null;
  private feedbackGenerator: FeedbackGenerationService | null = null;
  private pdfGenerator: PDFGenerationService;

  constructor() {
    if (process.env.OPENAI_API_KEY) {
      this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      this.feedbackGenerator = new FeedbackGenerationService(process.env.OPENAI_API_KEY);
    }
    if (process.env.RETELL_API_KEY) {
      this.retell = new Retell({ apiKey: process.env.RETELL_API_KEY });
    }

    this.pdfGenerator = new PDFGenerationService();
  }

  private normalizeLanguage(raw?: string | null): any {
    const base = (raw || 'en').toLowerCase().split('-')[0];
    const allowed = new Set(['en', 'es', 'pt', 'zh', 'hi', 'ja', 'ko', 'de', 'fr', 'it']);
    return allowed.has(base) ? base : 'en';
  }

  private normalizeSeniority(raw?: string | null): any {
    const value = (raw || 'mid').toLowerCase();
    const allowed = new Set([
      'intern',
      'junior',
      'mid',
      'senior',
      'staff',
      'principal',
      'manager',
      'director',
      'vp',
      'c-level',
    ]);
    if (allowed.has(value)) return value;
    if (value.includes('junior')) return 'junior';
    if (value.includes('senior')) return 'senior';
    if (value.includes('staff')) return 'staff';
    if (value.includes('principal')) return 'principal';
    if (value.includes('intern')) return 'intern';
    if (value.includes('manager')) return 'manager';
    if (value.includes('director')) return 'director';
    return 'mid';
  }

  private computeCallDurationMs(callDetails: any, interviewFallbackMs?: number | null): number {
    const fromTimestamps =
      callDetails?.end_timestamp && callDetails?.start_timestamp
        ? Number(callDetails.end_timestamp) - Number(callDetails.start_timestamp)
        : undefined;
    const durationMs =
      typeof fromTimestamps === 'number'
        ? fromTimestamps
        : typeof callDetails?.call_duration_ms === 'number'
          ? callDetails.call_duration_ms
          : typeof interviewFallbackMs === 'number'
            ? interviewFallbackMs
            : 0;
    return Math.max(0, durationMs);
  }

  /**
   * Main entry point - process interview after call ends
   * Idempotent: safe to call multiple times
   */
  async processInterview(
    interviewId: string,
    options?: {
      callData?: any;
    }
  ): Promise<PostCallResult> {
    const startTime = Date.now();
    dbLogger.info('Starting post-call processing', { interviewId });

    try {
      // 1. Load interview with resume
      const interview = await prisma.interview.findUnique({
        where: { id: interviewId },
        include: {
          resumeDocument: true,
          transcriptSegments: true,
          metrics: true,
          studyRecommendation: true,
          feedbackDocument: true,
          user: {
            select: {
              firstName: true,
              lastName: true,
            },
          },
        },
      });

      if (!interview) {
        throw new Error(`Interview not found: ${interviewId}`);
      }

      // 2. Check if already fully processed (idempotency)
      const alreadyProcessed =
        interview.transcriptSegments.length > 0 &&
        interview.metrics.length > 0 &&
        interview.studyRecommendation !== null &&
        !!interview.feedbackDocument?.contentJson &&
        !!interview.feedbackDocument?.pdfStorageKey;

      if (alreadyProcessed) {
        dbLogger.info('Interview already processed, skipping', { interviewId });
        return {
          success: true,
          interviewId,
          transcriptSegmentsCount: interview.transcriptSegments.length,
          metricsCount: interview.metrics.length,
          hasStudyRecommendation: true,
          overallScore: interview.score,
        };
      }

      // 3. Fetch Retell transcript if needed
      let transcriptText = interview.transcript || '';
      let transcriptData: any = null;

      if (options?.callData) {
        transcriptData = options.callData;
      } else if (interview.retellCallId && this.retell) {
        try {
          const callDetails = await this.retell.call.retrieve(interview.retellCallId);
          transcriptData = callDetails;
          
          // Extract transcript text from segments
          if ((callDetails as any).transcript_with_tool_calls) {
            transcriptText = (callDetails as any).transcript_with_tool_calls
              .filter((seg: any) => seg.role !== 'tool_calls')
              .map((seg: any) => `${seg.role}: ${seg.content}`)
              .join('\n');
          } else if ((callDetails as any).transcript) {
            transcriptText = (callDetails as any).transcript;
          }
        } catch (retellError: any) {
          dbLogger.warn('Failed to fetch Retell transcript, using stored', {
            interviewId,
            error: retellError.message,
          });
        }
      }

      // 4. Persist transcript segments if not already done
      let segmentsCount = interview.transcriptSegments.length;
      if (segmentsCount === 0 && transcriptData) {
        try {
          const callDurationMs = this.computeCallDurationMs(transcriptData, interview.callDuration);
          const segments = await createTranscriptSegments(interviewId, transcriptData, callDurationMs);
          segmentsCount = segments.length;
          dbLogger.info('Transcript segments created', { interviewId, count: segmentsCount });
        } catch (segmentError: any) {
          dbLogger.warn('Failed to create transcript segments', {
            interviewId,
            error: segmentError.message,
          });
        }
      }

      // Update call duration timestamps if present (best-effort)
      if (transcriptData) {
        const callDurationMs = this.computeCallDurationMs(transcriptData, interview.callDuration);
        const startedAt = transcriptData?.start_timestamp
          ? new Date(Number(transcriptData.start_timestamp))
          : undefined;
        const endedAt = transcriptData?.end_timestamp
          ? new Date(Number(transcriptData.end_timestamp))
          : undefined;

        try {
          await prisma.interview.update({
            where: { id: interviewId },
            data: {
              callDuration: callDurationMs || interview.callDuration || undefined,
              startedAt: startedAt || undefined,
              endedAt: endedAt || undefined,
            },
          });
        } catch (durationError: any) {
          dbLogger.warn('Failed to update interview duration/timestamps', {
            interviewId,
            error: durationError.message,
          });
        }
      }

      // 5. Get resume text
      const resumeText = interview.resumeDocument?.parsedText || '';

      // 6. Generate metrics via OpenAI if not already done
      let metricsCount = interview.metrics.length;
      let overallScore = interview.score;

      if (metricsCount === 0 && this.openai && transcriptText) {
        try {
          const metrics = await this.generateMetrics(
            transcriptText,
            resumeText,
            interview.jobDescription,
            interview.jobTitle,
            interview.seniority || 'mid'
          );

          // Persist metrics
          await prisma.interviewMetric.createMany({
            data: metrics.categories.map((m) => ({
              interviewId,
              category: m.category,
              metricName: m.metricName,
              score: m.score,
              maxScore: m.maxScore,
              feedback: m.feedback,
            })),
          });

          metricsCount = metrics.categories.length;
          overallScore = metrics.overallScore;

          // Update interview score
          await prisma.interview.update({
            where: { id: interviewId },
            data: { score: overallScore },
          });

          // Record score history (idempotent)
          try {
            await recordInterviewScore(
              interview.userId,
              interviewId,
              interview.jobTitle,
              interview.companyName,
              { overall: overallScore },
              interview.callDuration ?? undefined
            );
          } catch (scoreHistoryError: any) {
            // Non-blocking: log but don't fail the processing
            dbLogger.warn('Failed to record score history', {
              interviewId,
              error: scoreHistoryError.message,
            });
          }

          dbLogger.info('Metrics generated and saved', {
            interviewId,
            count: metricsCount,
            overallScore,
          });
        } catch (metricsError: any) {
          dbLogger.error('Failed to generate metrics', {
            interviewId,
            error: metricsError.message,
          });
        }
      }

      // 7. Generate study recommendation via OpenAI if not already done
      let hasStudyRecommendation = interview.studyRecommendation !== null;

      if (!hasStudyRecommendation && this.openai && transcriptText) {
        try {
          const studyPlan = await this.generateStudyPlan(
            transcriptText,
            resumeText,
            interview.jobDescription,
            interview.jobTitle
          );

          await prisma.studyRecommendation.upsert({
            where: { interviewId },
            create: {
              interviewId,
              topics: studyPlan.topics,
              weakAreas: studyPlan.weakAreas,
            },
            update: {
              topics: studyPlan.topics,
              weakAreas: studyPlan.weakAreas,
              generatedAt: new Date(),
            },
          });

          hasStudyRecommendation = true;
          dbLogger.info('Study recommendation generated', { interviewId });
        } catch (studyError: any) {
          dbLogger.error('Failed to generate study recommendation', {
            interviewId,
            error: studyError.message,
          });
        }
      }

      // 8. Generate structured feedback + PDF (canonical) if missing
      const hasFeedbackJson = !!interview.feedbackDocument?.contentJson;
      const hasFeedbackPdf = !!interview.feedbackDocument?.pdfStorageKey;

      if ((!hasFeedbackJson || !hasFeedbackPdf) && this.feedbackGenerator) {
        try {
          const segments = await getTranscriptSegments(interviewId);
          const transcriptSegments = segments.map((s) => ({
            role: s.speaker,
            content: s.content,
            timestamp: s.startTime,
            words: s.content.split(/\s+/).filter(Boolean).length,
          }));

          const callDurationMs = this.computeCallDurationMs(transcriptData, interview.callDuration);
          const language = this.normalizeLanguage(interview.language);
          const seniority = this.normalizeSeniority(interview.seniority);
          const candidateName = `${interview.user?.firstName || ''} ${interview.user?.lastName || ''}`
            .trim()
            .slice(0, 120);

          const wasInterrupted =
            callDurationMs > 0 ? callDurationMs < 60_000 : transcriptSegments.length < 6;

          const feedbackResult = await this.feedbackGenerator.generate({
            sessionId: interviewId,
            roleTitle: interview.jobTitle,
            seniority,
            language,
            jobDescription: interview.jobDescription,
            candidateName: candidateName || undefined,
            resumeUsed: !!interview.resumeDocument,
            transcript: transcriptSegments,
            durationSeconds: Math.floor(callDurationMs / 1000),
            wasInterrupted,
            interruptionReason:
              transcriptData?.end_call_reason || transcriptData?.disconnection_reason || undefined,
          });

          if (feedbackResult.success && feedbackResult.feedback && !hasFeedbackJson) {
            await storeFeedbackJson({
              interviewId,
              feedback: feedbackResult.feedback,
              generationTimeMs: feedbackResult.processingTimeMs,
            });
          }

          if (feedbackResult.success && feedbackResult.feedback && !hasFeedbackPdf) {
            const pdf = this.pdfGenerator.generate(feedbackResult.feedback, {
              locale: language,
              includeStudyPlan: true,
              includeTranscriptHighlights: true,
            });

            if (pdf.success && pdf.pdfBase64 && pdf.pageCount) {
              if (!isAzureBlobEnabled()) {
                dbLogger.warn('Azure Blob disabled; skipping feedback PDF upload', { interviewId });
              } else {
                const pdfBuffer = Buffer.from(pdf.pdfBase64, 'base64');
                const fileName = `vocaid-feedback-${interview.companyName}-${interview.jobTitle}.pdf`
                  .replace(/\s+/g, '_')
                  .slice(0, 180);

                const upload = await uploadFeedbackPdf(
                  interview.userId,
                  fileName,
                  pdfBuffer,
                  'application/pdf'
                );

                if (upload.success && upload.blobName) {
                  await storeFeedbackPdf({
                    interviewId,
                    pdfBuffer,
                    pageCount: pdf.pageCount,
                    locale: language,
                    includesStudyPlan: true,
                    includesHighlights: true,
                    storageKey: upload.blobName,
                  });
                } else {
                  dbLogger.warn('Feedback PDF upload failed', {
                    interviewId,
                    error: upload.error,
                  });
                }
              }
            } else {
              dbLogger.warn('PDF generation failed', {
                interviewId,
                error: (pdf as any).error,
              });
            }
          }
        } catch (feedbackError: any) {
          dbLogger.error('Failed to generate/store structured feedback', {
            interviewId,
            error: feedbackError.message,
          });
        }
      }

      const duration = Date.now() - startTime;
      dbLogger.info('Post-call processing completed', {
        interviewId,
        durationMs: duration,
        segmentsCount,
        metricsCount,
        hasStudyRecommendation,
        overallScore,
      });

      return {
        success: true,
        interviewId,
        transcriptSegmentsCount: segmentsCount,
        metricsCount,
        hasStudyRecommendation,
        overallScore,
      };
    } catch (error: any) {
      dbLogger.error('Post-call processing failed', {
        interviewId,
        error: error.message,
        stack: error.stack,
      });

      return {
        success: false,
        interviewId,
        transcriptSegmentsCount: 0,
        metricsCount: 0,
        hasStudyRecommendation: false,
        overallScore: null,
        error: error.message,
      };
    }
  }

  /**
   * Generate interview metrics via OpenAI
   */
  private async generateMetrics(
    transcript: string,
    resume: string,
    jobDescription: string,
    jobTitle: string,
    seniority: string
  ): Promise<GeneratedMetrics> {
    if (!this.openai) {
      throw new Error('OpenAI not configured');
    }

    const userPrompt = `## Interview Context
Role: ${jobTitle} (${seniority})

## Job Description
${jobDescription.substring(0, 2000)}

## Candidate Resume Summary
${resume.substring(0, 2000)}

## Interview Transcript
${transcript.substring(0, 8000)}

Analyze this interview and generate performance metrics.`;

    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: METRICS_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: 1000,
      response_format: { type: 'json_object' },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('Empty response from OpenAI');
    }

    const parsed = JSON.parse(content) as GeneratedMetrics;

    // Validate structure
    if (typeof parsed.overallScore !== 'number' || !Array.isArray(parsed.categories)) {
      throw new Error('Invalid metrics structure from OpenAI');
    }

    return parsed;
  }

  /**
   * Generate study plan via OpenAI
   */
  private async generateStudyPlan(
    transcript: string,
    resume: string,
    jobDescription: string,
    jobTitle: string
  ): Promise<GeneratedStudyPlan> {
    if (!this.openai) {
      throw new Error('OpenAI not configured');
    }

    const userPrompt = `## Interview Context
Role: ${jobTitle}

## Job Description
${jobDescription.substring(0, 1500)}

## Candidate Resume Summary
${resume.substring(0, 1500)}

## Interview Transcript
${transcript.substring(0, 6000)}

Based on this interview, generate a personalized study plan to help the candidate improve.`;

    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: STUDY_PLAN_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.5,
      max_tokens: 1500,
      response_format: { type: 'json_object' },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('Empty response from OpenAI');
    }

    const parsed = JSON.parse(content) as GeneratedStudyPlan;

    // Validate structure
    if (!Array.isArray(parsed.topics) || !Array.isArray(parsed.weakAreas)) {
      throw new Error('Invalid study plan structure from OpenAI');
    }

    return parsed;
  }

  /**
   * Get processing status for an interview (for polling)
   */
  async getProcessingStatus(interviewId: string): Promise<{
    status: 'pending' | 'processing' | 'completed' | 'partial';
    hasTranscript: boolean;
    hasMetrics: boolean;
    hasStudyPlan: boolean;
    overallScore: number | null;
  }> {
    const interview = await prisma.interview.findUnique({
      where: { id: interviewId },
      select: {
        score: true,
        status: true,
        _count: {
          select: {
            transcriptSegments: true,
            metrics: true,
          },
        },
        studyRecommendation: {
          select: { id: true },
        },
      },
    });

    if (!interview) {
      return {
        status: 'pending',
        hasTranscript: false,
        hasMetrics: false,
        hasStudyPlan: false,
        overallScore: null,
      };
    }

    const hasTranscript = interview._count.transcriptSegments > 0;
    const hasMetrics = interview._count.metrics > 0;
    const hasStudyPlan = interview.studyRecommendation !== null;

    let status: 'pending' | 'processing' | 'completed' | 'partial';
    if (hasTranscript && hasMetrics && hasStudyPlan) {
      status = 'completed';
    } else if (hasTranscript || hasMetrics || hasStudyPlan) {
      status = 'partial';
    } else if (interview.status === 'COMPLETED') {
      status = 'processing';
    } else {
      status = 'pending';
    }

    return {
      status,
      hasTranscript,
      hasMetrics,
      hasStudyPlan,
      overallScore: interview.score,
    };
  }
}

// Singleton export
export const postCallProcessingService = new PostCallProcessingService();
export default postCallProcessingService;
