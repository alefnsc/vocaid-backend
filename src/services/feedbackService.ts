import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { feedbackLogger } from '../utils/logger';

/**
 * Feedback generation service using OpenAI with Gemini fallback
 */

export interface InterviewTranscript {
  role: 'agent' | 'user';
  content: string;
  timestamp?: number;
}

export interface FeedbackData {
  overall_rating: number; // 1-5
  strengths: string[];
  areas_for_improvement: string[];
  technical_skills_rating: number; // 1-5
  communication_skills_rating: number; // 1-5
  problem_solving_rating: number; // 1-5
  detailed_feedback: string;
  recommendations: string[];
  was_interrupted: boolean;
}

export interface CallStatus {
  end_call_reason?: string;
  disconnection_reason?: string;
  call_duration_ms?: number;
  call_status?: string;
}

export class FeedbackService {
  private openai: OpenAI;
  private gemini: GoogleGenerativeAI | null = null;
  private geminiApiKey: string | null = null;

  constructor(openaiApiKey: string, geminiApiKey?: string) {
    this.openai = new OpenAI({
      apiKey: openaiApiKey
    });
    
    // Initialize Gemini as fallback if API key is provided
    if (geminiApiKey) {
      this.gemini = new GoogleGenerativeAI(geminiApiKey);
      this.geminiApiKey = geminiApiKey;
      feedbackLogger.info('Gemini fallback initialized');
    }
  }

  /**
   * Normalize transcript to array format
   * Handles: string, array, or object with transcript property
   */
  private normalizeTranscript(transcript: any): InterviewTranscript[] {
    // If it's already an array, use it
    if (Array.isArray(transcript)) {
      return transcript.map(item => ({
        role: item.role || 'user',
        content: item.content || item.text || item.message || String(item),
        timestamp: item.timestamp || item.time || 0
      }));
    }

    // If it's a string (plain text transcript)
    if (typeof transcript === 'string') {
      // Try to parse as alternating agent/user conversation
      const lines = transcript.split('\n').filter(line => line.trim());
      return lines.map((line, index) => ({
        role: index % 2 === 0 ? 'agent' : 'user',
        content: line.replace(/^(Agent|User|AGENT|USER|Interviewer|Candidate):\s*/i, ''),
        timestamp: index
      }));
    }

    // If it's an object with a transcript property
    if (transcript && typeof transcript === 'object') {
      if (transcript.transcript) {
        return this.normalizeTranscript(transcript.transcript);
      }
      if (transcript.messages) {
        return this.normalizeTranscript(transcript.messages);
      }
      if (transcript.data) {
        return this.normalizeTranscript(transcript.data);
      }
    }

    // Fallback: empty array
    feedbackLogger.warn('Could not parse transcript format', { type: typeof transcript });
    return [];
  }

  /**
   * Check if the interview was interrupted/incomplete
   */
  private isInterviewInterrupted(callStatus?: CallStatus, transcriptLength?: number): boolean {
    if (!callStatus) return false;
    
    // Check for clear interruption signals
    const interruptedReasons = [
      'user_hangup',
      'user_disconnected',
      'agent_hangup',
      'inactivity',
      'max_duration_reached',
      'error',
      'connection_error',
      'network_error'
    ];
    
    const reason = (callStatus.end_call_reason || callStatus.disconnection_reason || '').toLowerCase();
    
    // If explicitly interrupted
    if (interruptedReasons.some(r => reason.includes(r))) {
      return true;
    }
    
    // If call was very short (less than 2 minutes) with few messages
    const durationMs = callStatus.call_duration_ms || 0;
    if (durationMs < 120000 && (transcriptLength || 0) < 6) {
      return true;
    }
    
    return false;
  }

  /**
   * Calculate penalty factor for interrupted interviews
   */
  private calculateInterruptionPenalty(callStatus?: CallStatus, transcriptLength?: number): number {
    if (!callStatus) return 1;
    
    const durationMs = callStatus.call_duration_ms || 0;
    const durationMinutes = durationMs / 60000;
    
    // Very short interviews (< 2 min) get significant penalty
    if (durationMinutes < 2) return 0.4;
    
    // Short interviews (2-5 min) get moderate penalty
    if (durationMinutes < 5) return 0.6;
    
    // Medium interviews (5-10 min) get small penalty
    if (durationMinutes < 10) return 0.8;
    
    // Also penalize if very few exchanges
    if ((transcriptLength || 0) < 6) return 0.5;
    if ((transcriptLength || 0) < 10) return 0.7;
    
    return 1;
  }

  /**
   * Generate comprehensive interview feedback
   */
  async generateFeedback(
    transcript: any, // Accept any format
    jobTitle: string,
    jobDescription: string,
    candidateName: string,
    callStatus?: CallStatus
  ): Promise<FeedbackData> {
    try {
      feedbackLogger.info('Generating feedback for interview', {
        jobTitle,
        candidateName,
        transcriptType: typeof transcript,
        isArray: Array.isArray(transcript),
        callStatus: callStatus
      });

      // Normalize transcript to array format
      const normalizedTranscript = this.normalizeTranscript(transcript);
      
      // Check if interview was interrupted
      const wasInterrupted = this.isInterviewInterrupted(callStatus, normalizedTranscript.length);
      const penaltyFactor = this.calculateInterruptionPenalty(callStatus, normalizedTranscript.length);
      
      feedbackLogger.info('Interview analysis', { 
        wasInterrupted,
        penaltyFactor,
        messageCount: normalizedTranscript.length,
        durationMs: callStatus?.call_duration_ms 
      });
      
      // Handle interrupted/incomplete interviews - provide minimal, honest feedback
      if (wasInterrupted && normalizedTranscript.length < 4) {
        feedbackLogger.warn('Interview was interrupted with minimal content', { 
          jobTitle, 
          candidateName,
          messageCount: normalizedTranscript.length 
        });
        return {
          overall_rating: 1,
          strengths: [],
          areas_for_improvement: [],
          technical_skills_rating: 1,
          communication_skills_rating: 1,
          problem_solving_rating: 1,
          detailed_feedback: 'Interview ended early. Unable to provide feedback.',
          recommendations: [],
          was_interrupted: true
        };
      }
      
      if (normalizedTranscript.length === 0) {
        feedbackLogger.warn('No transcript content available', { jobTitle, candidateName });
        return {
          overall_rating: 1,
          strengths: [],
          areas_for_improvement: [],
          technical_skills_rating: 1,
          communication_skills_rating: 1,
          problem_solving_rating: 1,
          detailed_feedback: 'No interview content recorded. Unable to provide feedback.',
          recommendations: [],
          was_interrupted: true
        };
      }

      feedbackLogger.info('Transcript normalized', { 
        messageCount: normalizedTranscript.length 
      });

      // Format transcript for analysis
      const formattedTranscript = normalizedTranscript
        .map(item => `${item.role.toUpperCase()}: ${item.content}`)
        .join('\n\n');

      // Add context about interview completeness
      const interviewContext = wasInterrupted 
        ? `\n\nIMPORTANT: This interview was INTERRUPTED or INCOMPLETE. The candidate ended the session early or there was a disconnection. Factor this into your evaluation - incomplete interviews should receive LOWER scores as we cannot fully assess the candidate's abilities. A short or interrupted interview cannot demonstrate the candidate's full potential.`
        : '';
      
      const durationContext = callStatus?.call_duration_ms 
        ? `\n\nInterview duration: ${Math.round(callStatus.call_duration_ms / 60000)} minutes`
        : '';

      const analysisPrompt = `You are an expert interview evaluator. Analyze this job interview and provide comprehensive feedback.

JOB TITLE: ${jobTitle}
JOB DESCRIPTION: ${jobDescription}
CANDIDATE: ${candidateName}
NUMBER OF EXCHANGES: ${normalizedTranscript.length}${durationContext}${interviewContext}

INTERVIEW TRANSCRIPT:
${formattedTranscript}

Provide detailed feedback in the following JSON format:
{
  "overall_rating": 1-5,
  "strengths": ["strength1", "strength2", ...],
  "areas_for_improvement": ["area1", "area2", ...],
  "technical_skills_rating": 1-5,
  "communication_skills_rating": 1-5,
  "problem_solving_rating": 1-5,
  "detailed_feedback": "comprehensive paragraph analyzing the interview",
  "recommendations": ["recommendation1", "recommendation2", ...]
}

CRITICAL REQUIREMENTS FOR areas_for_improvement:
- Each area MUST be UNIQUE and address a DIFFERENT aspect of the candidate's performance
- DO NOT repeat the same concept with different wording (e.g., "needs more examples" and "should provide concrete examples" are redundant)
- Focus on DISTINCT categories: technical knowledge gaps, communication style, specific missing skills, presentation issues, etc.
- Maximum 3-4 unique, actionable improvement areas
- If you cannot identify distinct areas, provide fewer items rather than redundant ones

CRITICAL REQUIREMENTS FOR strengths:
- Each strength MUST be UNIQUE and address a DIFFERENT positive aspect
- DO NOT repeat similar achievements or qualities with different phrasing
- Maximum 3-4 distinct strengths

Rate on scale of 1-5:
1 - Poor (very short interview, minimal responses, or interview was interrupted)
2 - Below Average (incomplete answers, interview cut short, limited demonstration of skills)
3 - Average (adequate responses but room for improvement)
4 - Good (solid performance with minor areas to improve)
5 - Excellent (comprehensive, detailed responses demonstrating clear expertise)

Be constructive, specific, and actionable in your feedback. Avoid redundancy at all costs.`;

      let feedback: any;
      
      try {
        // Try OpenAI first
        const response = await this.openai.chat.completions.create({
          model: 'gpt-4-turbo-preview',
          messages: [
            {
              role: 'system',
              content: 'You are an expert interview evaluator providing detailed, constructive feedback. Always respond with valid JSON only. CRITICAL: Never be redundant - each strength and each area for improvement must address a completely different aspect. If two items convey the same idea with different words, keep only one.'
            },
            {
              role: 'user',
              content: analysisPrompt
            }
          ],
          temperature: 0.5,
          max_tokens: 1500,
          response_format: { type: 'json_object' }
        });

        feedback = JSON.parse(response.choices[0].message.content || '{}');
        feedbackLogger.info('Feedback generated using OpenAI');
      } catch (openaiError: any) {
        feedbackLogger.warn('OpenAI failed, attempting Gemini fallback', { error: openaiError.message });
        
        // Try Gemini fallback
        if (this.gemini) {
          try {
            const model = this.gemini.getGenerativeModel({ model: 'gemini-1.5-flash' });
            
            const geminiPrompt = `You are an expert interview evaluator providing detailed, constructive feedback. Always respond with valid JSON only. CRITICAL: Never be redundant - each strength and each area for improvement must address a completely different aspect. If two items convey the same idea with different words, keep only one.

${analysisPrompt}

IMPORTANT: Respond ONLY with a valid JSON object, no markdown formatting, no code blocks, just pure JSON.`;

            const result = await model.generateContent(geminiPrompt);
            const responseText = result.response.text();
            
            // Clean up potential markdown formatting from Gemini
            const cleanedResponse = responseText
              .replace(/```json\n?/g, '')
              .replace(/```\n?/g, '')
              .trim();
            
            feedback = JSON.parse(cleanedResponse);
            feedbackLogger.info('Feedback generated using Gemini fallback');
          } catch (geminiError: any) {
            feedbackLogger.error('Gemini fallback also failed', { error: geminiError.message });
            throw new Error(`Both OpenAI and Gemini failed: OpenAI: ${openaiError.message}, Gemini: ${geminiError.message}`);
          }
        } else {
          throw openaiError; // Re-throw if no Gemini fallback available
        }
      }

      // Apply penalty factor for interrupted/short interviews
      const applyPenalty = (rating: number): number => {
        const penalized = Math.round(rating * penaltyFactor);
        return Math.max(1, Math.min(5, penalized)); // Ensure 1-5 range
      };

      // If interview was interrupted, ensure ratings reflect this
      const finalOverallRating = wasInterrupted 
        ? Math.min(applyPenalty(feedback.overall_rating || 3), 2) // Cap at 2 for interrupted
        : applyPenalty(feedback.overall_rating || 3);

      // Add interruption note to feedback if applicable
      let finalDetailedFeedback = feedback.detailed_feedback || 'Feedback generation in progress.';
      if (wasInterrupted) {
        finalDetailedFeedback = `**Note: This interview was interrupted or ended early, which limits the accuracy of this assessment.**\n\n${finalDetailedFeedback}\n\nWe recommend completing a full interview session for a more accurate evaluation of your skills and qualifications.`;
      }

      return {
        overall_rating: finalOverallRating,
        strengths: feedback.strengths || [],
        areas_for_improvement: wasInterrupted 
          ? ['Interview was not completed', ...(feedback.areas_for_improvement || [])]
          : (feedback.areas_for_improvement || []),
        technical_skills_rating: applyPenalty(feedback.technical_skills_rating || 3),
        communication_skills_rating: applyPenalty(feedback.communication_skills_rating || 3),
        problem_solving_rating: applyPenalty(feedback.problem_solving_rating || 3),
        detailed_feedback: finalDetailedFeedback,
        recommendations: wasInterrupted
          ? ['Complete a full interview session for accurate assessment', ...(feedback.recommendations || [])]
          : (feedback.recommendations || []),
        was_interrupted: wasInterrupted
      };
    } catch (error: any) {
      feedbackLogger.error('Error generating feedback', { error: error.message });
      throw new Error(`Failed to generate feedback: ${error.message}`);
    }
  }
}
