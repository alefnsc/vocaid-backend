import OpenAI from 'openai';
import { feedbackLogger } from '../utils/logger';

/**
 * Feedback generation service using OpenAI
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
}

export class FeedbackService {
  private openai: OpenAI;

  constructor(apiKey: string) {
    this.openai = new OpenAI({
      apiKey: apiKey
    });
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
   * Generate comprehensive interview feedback
   */
  async generateFeedback(
    transcript: any, // Accept any format
    jobTitle: string,
    jobDescription: string,
    candidateName: string
  ): Promise<FeedbackData> {
    try {
      feedbackLogger.info('Generating feedback for interview', {
        jobTitle,
        candidateName,
        transcriptType: typeof transcript,
        isArray: Array.isArray(transcript)
      });

      // Normalize transcript to array format
      const normalizedTranscript = this.normalizeTranscript(transcript);
      
      if (normalizedTranscript.length === 0) {
        feedbackLogger.warn('No transcript content available', { jobTitle, candidateName });
        return {
          overall_rating: 3,
          strengths: ['Completed the interview process'],
          areas_for_improvement: ['More detailed responses would help evaluation'],
          technical_skills_rating: 3,
          communication_skills_rating: 3,
          problem_solving_rating: 3,
          detailed_feedback: 'The interview was completed but the transcript was not available for detailed analysis. Please try again or contact support if this issue persists.',
          recommendations: ['Consider retaking the interview for a more accurate assessment']
        };
      }

      feedbackLogger.info('Transcript normalized', { 
        messageCount: normalizedTranscript.length 
      });

      // Format transcript for analysis
      const formattedTranscript = normalizedTranscript
        .map(item => `${item.role.toUpperCase()}: ${item.content}`)
        .join('\n\n');

      const analysisPrompt = `You are an expert interview evaluator. Analyze this job interview and provide comprehensive feedback.

JOB TITLE: ${jobTitle}
JOB DESCRIPTION: ${jobDescription}
CANDIDATE: ${candidateName}

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

Rate on scale of 1-5:
1 - Poor
2 - Below Average
3 - Average
4 - Good
5 - Excellent

Be constructive, specific, and actionable in your feedback.`;

      const response = await this.openai.chat.completions.create({
        model: 'gpt-4-turbo-preview',
        messages: [
          {
            role: 'system',
            content: 'You are an expert interview evaluator providing detailed, constructive feedback. Always respond with valid JSON only.'
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

      const feedback = JSON.parse(response.choices[0].message.content || '{}');

      return {
        overall_rating: feedback.overall_rating || 3,
        strengths: feedback.strengths || [],
        areas_for_improvement: feedback.areas_for_improvement || [],
        technical_skills_rating: feedback.technical_skills_rating || 3,
        communication_skills_rating: feedback.communication_skills_rating || 3,
        problem_solving_rating: feedback.problem_solving_rating || 3,
        detailed_feedback: feedback.detailed_feedback || 'Feedback generation in progress.',
        recommendations: feedback.recommendations || []
      };
    } catch (error: any) {
      feedbackLogger.error('Error generating feedback', { error: error.message });
      throw new Error(`Failed to generate feedback: ${error.message}`);
    }
  }
}
