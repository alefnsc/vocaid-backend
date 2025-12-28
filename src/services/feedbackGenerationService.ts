/**
 * Feedback Generation Service v1.0
 * 
 * Generates structured, evidence-based interview feedback using OpenAI
 * with layered prompting, validation, and role-specific scoring.
 */

import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import {
  StructuredFeedback,
  SessionMetadata,
  CompetencyScore,
  StrengthItem,
  ImprovementItem,
  InterviewHighlight,
  CommunicationAnalysis,
  StudyPlanItem,
  NextSessionGoal,
  DataQualityWarning,
  FeedbackValidationResult,
  CompetencyKey,
  Seniority,
  SupportedLanguage,
  TranscriptEvidence
} from '../types/feedback';
import {
  getCompetencyWeights,
  getSeniorityExpectations,
  COMPETENCY_ANCHORS,
  calculateWeightedScore
} from '../types/rubrics';
import logger from '../utils/logger';

// ============================================
// CONFIGURATION
// ============================================

const CURRENT_PROMPT_VERSION = 'v1.0.0';
const CURRENT_SCHEMA_VERSION = '1.0';
const DEFAULT_MODEL = 'gpt-4-turbo-preview';
const FEEDBACK_TEMPERATURE = 0.3; // Lower for consistency
const MAX_TOKENS = 4000;

// ============================================
// TYPES
// ============================================

export interface TranscriptSegment {
  role: 'agent' | 'user';
  content: string;
  timestamp?: number;
  words?: number;
}

export interface InterviewContext {
  sessionId: string;
  roleTitle: string;
  seniority: Seniority;
  language: SupportedLanguage;
  jobDescription?: string;
  candidateName?: string;
  resumeSkills?: string[];
  resumeUsed: boolean;
  transcript: TranscriptSegment[];
  durationSeconds: number;
  wasInterrupted: boolean;
  interruptionReason?: string;
  retellAnalytics?: {
    wordsPerMinute?: number;
    fillerWordCount?: number;
    silenceDuration?: number;
  };
}

export interface GenerationResult {
  success: boolean;
  feedback?: StructuredFeedback;
  error?: string;
  processingTimeMs: number;
}

// ============================================
// PROMPT TEMPLATES
// ============================================

function getSystemPrompt(language: SupportedLanguage): string {
  return `You are an expert interview evaluator with decades of experience in technical hiring.
Your role is to provide detailed, evidence-based feedback that helps candidates improve.

CRITICAL RULES:
1. ALWAYS respond with valid JSON matching the exact schema provided.
2. ALWAYS cite evidence using transcript timestamps. If no evidence exists, say "No specific evidence found."
3. NEVER fabricate technologies, skills, or experiences not mentioned in the transcript.
4. NEVER be generic - every piece of feedback must be specific to THIS interview.
5. NEVER repeat the same feedback point in different sections.
6. Score based on demonstrated behavior, not assumptions.
7. Be constructive and actionable - tell candidates exactly how to improve.
8. Adjust expectations based on seniority level provided.
9. Generate all text content in ${language === 'en' ? 'English' : getLanguageName(language)}.
10. Use a professional but encouraging tone.

SCORING PRINCIPLES:
- 0: Not assessed / No evidence
- 1: Significantly below expectations
- 2: Below expectations
- 3: Meets expectations for level
- 4: Exceeds expectations
- 5: Exceptional / Role model

When in doubt, default to a score of 3 and explain what additional evidence would be needed.`;
}

function getDeveloperPrompt(
  roleTitle: string,
  seniority: Seniority,
  competencyWeights: Partial<Record<CompetencyKey, number>>
): string {
  const expectations = getSeniorityExpectations(seniority);
  
  return `ROLE CONTEXT: ${roleTitle} at ${seniority} level

SENIORITY EXPECTATIONS:
- Minimum expected score: ${expectations.minScore}/100
- Technical depth expected: ${expectations.depthExpected}
- Leadership required: ${expectations.leadershipRequired ? 'Yes' : 'No'}
- System design required: ${expectations.systemDesignRequired ? 'Yes' : 'No'}
- Communication standard: ${expectations.communicationStandard}
- Primary focus areas: ${expectations.focusAreas.join(', ')}

COMPETENCY WEIGHTS FOR SCORING:
${Object.entries(competencyWeights)
  .map(([key, weight]) => `- ${key}: ${Math.round((weight || 0) * 100)}%`)
  .join('\n')}

SCORING ANCHORS:
${Object.entries(COMPETENCY_ANCHORS)
  .filter(([key]) => competencyWeights[key as CompetencyKey])
  .map(([key, anchors]) => {
    const a3 = anchors.find(a => a.score === 3);
    const a5 = anchors.find(a => a.score === 5);
    return `${key}:
  - Score 3 (Competent): ${a3?.indicators.join('; ')}
  - Score 5 (Expert): ${a5?.indicators.join('; ')}`;
  })
  .join('\n')}`;
}

function getUserPrompt(context: InterviewContext): string {
  const transcriptText = context.transcript
    .map((seg, i) => {
      const speaker = seg.role === 'agent' ? 'Interviewer' : 'Candidate';
      const ts = seg.timestamp ? `[${formatTimestamp(seg.timestamp)}]` : `[${i + 1}]`;
      return `${ts} ${speaker}: ${seg.content}`;
    })
    .join('\n\n');

  const resumeInfo = context.resumeUsed && context.resumeSkills?.length
    ? `\nRESUME SKILLS: ${context.resumeSkills.join(', ')}`
    : '\nRESUME: Not provided';

  const analyticsInfo = context.retellAnalytics
    ? `\nSPEECH ANALYTICS:
- Words per minute: ${context.retellAnalytics.wordsPerMinute || 'N/A'}
- Filler words detected: ${context.retellAnalytics.fillerWordCount || 0}
- Total silence: ${context.retellAnalytics.silenceDuration || 0}s`
    : '';

  return `INTERVIEW CONTEXT:
Role: ${context.roleTitle}
Seniority: ${context.seniority}
Duration: ${Math.round(context.durationSeconds / 60)} minutes
Total exchanges: ${context.transcript.length}
Was interrupted: ${context.wasInterrupted}${context.interruptionReason ? ` (${context.interruptionReason})` : ''}
${resumeInfo}
${analyticsInfo}

JOB DESCRIPTION:
${context.jobDescription || 'Not provided'}

TRANSCRIPT:
${transcriptText}

---

Analyze this interview and provide structured feedback following the JSON schema exactly.
Pay special attention to:
1. Evidence-based scoring with timestamp citations
2. Specific, actionable improvement suggestions
3. A prioritized study plan with time estimates
4. Communication coaching based on speech patterns
5. Measurable goals for the next session`;
}

function getOutputSchema(): string {
  return `{
  "executiveSummary": "string (2-3 sentences summarizing performance)",
  "overallScore": "number (0-100)",
  "scoreConfidence": { "lower": "number", "upper": "number" },
  "competencies": [
    {
      "key": "technical_knowledge|problem_solving|communication|system_design|behavioral|leadership|cultural_fit|domain_expertise",
      "name": "string (localized name)",
      "score": "number (0-5)",
      "confidence": "number (0-1)",
      "explanation": "string",
      "evidence": [
        { "timestamp": "number (seconds)", "quote": "string", "speaker": "candidate|interviewer", "context": "string" }
      ],
      "improvementTips": ["string"]
    }
  ],
  "strengths": [
    {
      "title": "string",
      "description": "string",
      "evidence": [{ "timestamp": "number", "quote": "string", "speaker": "string" }],
      "competency": "string (competency key)"
    }
  ],
  "improvements": [
    {
      "title": "string",
      "why": "string",
      "howToImprove": "string",
      "timeToAddress": "string (e.g., '2-4 weeks')",
      "evidence": [{ "timestamp": "number", "quote": "string", "speaker": "string" }],
      "competency": "string",
      "priority": "1|2|3"
    }
  ],
  "highlights": [
    {
      "type": "strong_answer|weak_answer|key_moment",
      "timestamp": "number",
      "question": "string",
      "response": "string",
      "analysis": "string",
      "competency": "string"
    }
  ],
  "communication": {
    "overallScore": "number (0-5)",
    "pace": { "wpm": "number", "assessment": "too_slow|good|too_fast", "recommendation": "string" },
    "fillerWords": { "count": "number", "examples": ["string"], "frequency": "low|moderate|high", "recommendation": "string" },
    "clarity": { "score": "number (0-5)", "assessment": "string", "examples": [] },
    "structure": { "score": "number (0-5)", "assessment": "string", "usedFrameworks": ["string"] },
    "technicalVocabulary": { "score": "number (0-5)", "assessment": "string", "misusedTerms": [] }
  },
  "studyPlan": [
    {
      "topic": "string",
      "rationale": "string",
      "priority": "1|2|3",
      "estimatedHours": "number",
      "exercises": ["string"],
      "competency": "string"
    }
  ],
  "nextSessionGoals": [
    { "goal": "string", "metric": "string", "target": "string" }
  ],
  "warnings": [
    { "code": "incomplete_transcript|short_interview|missing_audio|language_mismatch|no_resume", "message": "string", "severity": "info|warning|error" }
  ]
}`;
}

// ============================================
// HELPER FUNCTIONS
// ============================================

function formatTimestamp(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function getLanguageName(code: SupportedLanguage): string {
  const names: Record<SupportedLanguage, string> = {
    en: 'English',
    es: 'Spanish',
    pt: 'Portuguese',
    zh: 'Chinese',
    hi: 'Hindi',
    ja: 'Japanese',
    ko: 'Korean',
    de: 'German',
    fr: 'French',
    it: 'Italian'
  };
  return names[code] || 'English';
}

function detectDataQualityIssues(context: InterviewContext): DataQualityWarning[] {
  const warnings: DataQualityWarning[] = [];
  
  if (context.transcript.length < 5) {
    warnings.push({
      code: 'incomplete_transcript',
      message: 'Transcript has fewer than 5 exchanges. Feedback may be limited.',
      severity: 'warning'
    });
  }
  
  if (context.durationSeconds < 180) {
    warnings.push({
      code: 'short_interview',
      message: 'Interview was less than 3 minutes. Assessment may not be comprehensive.',
      severity: 'warning'
    });
  }
  
  if (!context.resumeUsed) {
    warnings.push({
      code: 'no_resume',
      message: 'No resume was provided. Skills assessment based on interview only.',
      severity: 'info'
    });
  }
  
  return warnings;
}

// ============================================
// VALIDATION
// ============================================

export function validateFeedback(feedback: any): FeedbackValidationResult {
  const errors: FeedbackValidationResult['errors'] = [];
  const warnings: FeedbackValidationResult['warnings'] = [];
  
  // Required fields
  if (!feedback.executiveSummary) {
    errors.push({ path: 'executiveSummary', message: 'Missing executive summary', code: 'REQUIRED' });
  }
  
  if (typeof feedback.overallScore !== 'number' || feedback.overallScore < 0 || feedback.overallScore > 100) {
    errors.push({ path: 'overallScore', message: 'Overall score must be 0-100', code: 'RANGE' });
  }
  
  // Competencies validation
  if (!Array.isArray(feedback.competencies) || feedback.competencies.length === 0) {
    errors.push({ path: 'competencies', message: 'At least one competency required', code: 'REQUIRED' });
  } else {
    feedback.competencies.forEach((c: any, i: number) => {
      if (typeof c.score !== 'number' || c.score < 0 || c.score > 5) {
        errors.push({ path: `competencies[${i}].score`, message: 'Score must be 0-5', code: 'RANGE' });
      }
      if (!c.evidence || c.evidence.length === 0) {
        warnings.push({ path: `competencies[${i}].evidence`, message: 'No evidence provided for competency' });
      }
    });
  }
  
  // Strengths validation
  if (!Array.isArray(feedback.strengths) || feedback.strengths.length < 3) {
    warnings.push({ path: 'strengths', message: 'Expected at least 3 strengths' });
  }
  
  // Improvements validation
  if (!Array.isArray(feedback.improvements) || feedback.improvements.length < 3) {
    warnings.push({ path: 'improvements', message: 'Expected at least 3 improvement areas' });
  }
  
  // Study plan validation
  if (!Array.isArray(feedback.studyPlan) || feedback.studyPlan.length === 0) {
    warnings.push({ path: 'studyPlan', message: 'Study plan is empty' });
  }
  
  return {
    isValid: errors.length === 0,
    errors,
    warnings
  };
}

// ============================================
// MAIN SERVICE CLASS
// ============================================

export class FeedbackGenerationService {
  private openai: OpenAI;
  private model: string;
  
  constructor(apiKey?: string, model?: string) {
    this.openai = new OpenAI({ apiKey: apiKey || process.env.OPENAI_API_KEY });
    this.model = model || DEFAULT_MODEL;
  }
  
  /**
   * Generate structured feedback for an interview session
   */
  async generate(context: InterviewContext): Promise<GenerationResult> {
    const startTime = Date.now();
    const requestId = uuidv4();
    
    logger.info('Starting feedback generation', {
      requestId,
      sessionId: context.sessionId,
      roleTitle: context.roleTitle,
      seniority: context.seniority,
      transcriptLength: context.transcript.length
    });
    
    try {
      // Pre-flight checks
      const warnings = detectDataQualityIssues(context);
      if (warnings.some(w => w.severity === 'error')) {
        return {
          success: false,
          error: warnings.find(w => w.severity === 'error')?.message || 'Data quality error',
          processingTimeMs: Date.now() - startTime
        };
      }
      
      // Get role-specific weights
      const competencyWeights = getCompetencyWeights(context.roleTitle);
      
      // Build prompts
      const systemPrompt = getSystemPrompt(context.language);
      const developerPrompt = getDeveloperPrompt(context.roleTitle, context.seniority, competencyWeights);
      const userPrompt = getUserPrompt(context);
      const outputSchema = getOutputSchema();
      
      // Call OpenAI
      const response = await this.openai.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'system', content: `DEVELOPER CONTEXT:\n${developerPrompt}` },
          { role: 'user', content: userPrompt },
          { role: 'user', content: `OUTPUT JSON SCHEMA (respond with exactly this structure):\n${outputSchema}` }
        ],
        temperature: FEEDBACK_TEMPERATURE,
        max_tokens: MAX_TOKENS,
        response_format: { type: 'json_object' }
      });
      
      // Parse response
      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('Empty response from LLM');
      }
      
      const rawFeedback = JSON.parse(content);
      
      // Validate
      const validation = validateFeedback(rawFeedback);
      if (!validation.isValid) {
        logger.warn('Feedback validation failed', {
          requestId,
          errors: validation.errors
        });
        // Try to fix common issues
        rawFeedback.warnings = [...(rawFeedback.warnings || []), ...warnings];
      }
      
      // Build final structured feedback
      const feedback: StructuredFeedback = {
        schemaVersion: CURRENT_SCHEMA_VERSION as '1.0',
        promptVersion: CURRENT_PROMPT_VERSION,
        model: this.model,
        generatedAt: new Date().toISOString(),
        session: {
          sessionId: context.sessionId,
          roleTitle: context.roleTitle,
          seniority: context.seniority,
          language: context.language,
          resumeUsed: context.resumeUsed,
          interviewDuration: context.durationSeconds,
          totalExchanges: context.transcript.length,
          interviewDate: new Date().toISOString(),
          wasInterrupted: context.wasInterrupted,
          interruptionReason: context.interruptionReason
        },
        overallScore: rawFeedback.overallScore,
        scoreConfidence: rawFeedback.scoreConfidence,
        executiveSummary: rawFeedback.executiveSummary,
        competencies: rawFeedback.competencies || [],
        strengths: rawFeedback.strengths || [],
        improvements: rawFeedback.improvements || [],
        highlights: rawFeedback.highlights || [],
        communication: rawFeedback.communication || {
          overallScore: 3,
          pace: { wpm: 120, assessment: 'good' },
          fillerWords: { count: 0, examples: [], frequency: 'low' },
          clarity: { score: 3, assessment: 'Adequate clarity' },
          structure: { score: 3, assessment: 'Basic structure', usedFrameworks: [] },
          technicalVocabulary: { score: 3, assessment: 'Appropriate vocabulary' }
        },
        studyPlan: rawFeedback.studyPlan || [],
        nextSessionGoals: rawFeedback.nextSessionGoals || [],
        warnings: [...warnings, ...(rawFeedback.warnings || [])]
      };
      
      // Recalculate overall score using weights if competencies are present
      if (feedback.competencies.length > 0) {
        const competencyScores: Record<CompetencyKey, number> = {} as any;
        feedback.competencies.forEach(c => {
          competencyScores[c.key] = c.score;
        });
        const calculatedScore = calculateWeightedScore(competencyScores, context.roleTitle);
        
        // Use calculated score if significantly different
        if (Math.abs(calculatedScore - feedback.overallScore) > 10) {
          logger.info('Adjusting overall score based on weighted calculation', {
            requestId,
            original: feedback.overallScore,
            calculated: calculatedScore
          });
          feedback.overallScore = calculatedScore;
        }
      }
      
      logger.info('Feedback generation completed', {
        requestId,
        sessionId: context.sessionId,
        overallScore: feedback.overallScore,
        competencyCount: feedback.competencies.length,
        warningCount: feedback.warnings.length,
        processingTimeMs: Date.now() - startTime
      });
      
      return {
        success: true,
        feedback,
        processingTimeMs: Date.now() - startTime
      };
      
    } catch (error: any) {
      logger.error('Feedback generation failed', {
        requestId,
        sessionId: context.sessionId,
        error: error.message,
        stack: error.stack
      });
      
      return {
        success: false,
        error: error.message || 'Unknown error during feedback generation',
        processingTimeMs: Date.now() - startTime
      };
    }
  }
}

// ============================================
// SINGLETON EXPORT
// ============================================

export const feedbackGenerationService = new FeedbackGenerationService();
