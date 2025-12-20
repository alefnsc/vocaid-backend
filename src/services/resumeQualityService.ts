/**
 * Resume Quality Scoring Service
 * 
 * AI-driven resume analysis with metrics for:
 * - Keyword density and relevance
 * - Formatting and structure
 * - Impact statements (action verbs, quantified achievements)
 * - ATS compatibility
 * - Section completeness
 * 
 * @module services/resumeQualityService
 */

import OpenAI from 'openai';
import { feedbackLogger } from '../utils/logger';

// ========================================
// TYPES
// ========================================

export interface ResumeQualityMetrics {
  overallScore: number;              // 0-100
  breakdown: {
    keywordRelevance: number;        // 0-100 - How relevant keywords are to target job
    formatting: number;              // 0-100 - Structure, readability, ATS-friendliness
    impactStatements: number;        // 0-100 - Action verbs, quantified achievements
    completeness: number;            // 0-100 - Essential sections present
    clarity: number;                 // 0-100 - Clear, concise writing
  };
  insights: {
    strengths: string[];
    improvements: string[];
    missingKeywords: string[];
    actionVerbsUsed: string[];
    quantifiedAchievements: number;
  };
  atsCompatibility: {
    score: number;                   // 0-100
    issues: string[];
    recommendations: string[];
  };
  sections: {
    found: string[];
    missing: string[];
  };
}

export interface ResumeAnalysisRequest {
  resumeText: string;
  jobTitle?: string;
  jobDescription?: string;
  targetCompany?: string;
}

// ========================================
// SERVICE
// ========================================

export class ResumeQualityService {
  private openai: OpenAI;

  constructor(openaiApiKey: string) {
    this.openai = new OpenAI({
      apiKey: openaiApiKey
    });
  }

  /**
   * Analyze resume quality and return comprehensive metrics
   */
  async analyzeResume(request: ResumeAnalysisRequest): Promise<ResumeQualityMetrics> {
    const { resumeText, jobTitle, jobDescription, targetCompany } = request;

    feedbackLogger.info('Starting resume quality analysis', {
      hasJobTitle: !!jobTitle,
      hasJobDescription: !!jobDescription,
      resumeLength: resumeText.length
    });

    const systemPrompt = `You are an expert resume analyst and ATS (Applicant Tracking System) specialist. 
Analyze the provided resume and return a comprehensive quality assessment.

Your analysis should evaluate:
1. **Keyword Relevance** (0-100): How well the resume keywords match the target job/industry
2. **Formatting** (0-100): Structure, readability, consistent formatting, ATS compatibility
3. **Impact Statements** (0-100): Use of action verbs, quantified achievements (numbers, percentages, metrics)
4. **Completeness** (0-100): Presence of essential sections (contact, summary, experience, education, skills)
5. **Clarity** (0-100): Clear, concise, professional writing

Return your analysis as a valid JSON object with this exact structure:
{
  "overallScore": <number 0-100>,
  "breakdown": {
    "keywordRelevance": <number>,
    "formatting": <number>,
    "impactStatements": <number>,
    "completeness": <number>,
    "clarity": <number>
  },
  "insights": {
    "strengths": ["<strength 1>", "<strength 2>", ...],
    "improvements": ["<improvement 1>", "<improvement 2>", ...],
    "missingKeywords": ["<keyword 1>", "<keyword 2>", ...],
    "actionVerbsUsed": ["<verb 1>", "<verb 2>", ...],
    "quantifiedAchievements": <number of quantified achievements found>
  },
  "atsCompatibility": {
    "score": <number 0-100>,
    "issues": ["<issue 1>", "<issue 2>", ...],
    "recommendations": ["<recommendation 1>", "<recommendation 2>", ...]
  },
  "sections": {
    "found": ["<section 1>", "<section 2>", ...],
    "missing": ["<section 1>", "<section 2>", ...]
  }
}

Be specific and actionable in your feedback. Focus on practical improvements.`;

    const userPrompt = this.buildUserPrompt(resumeText, jobTitle, jobDescription, targetCompany);

    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' }
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('No response from OpenAI');
      }

      const metrics = JSON.parse(content) as ResumeQualityMetrics;
      
      feedbackLogger.info('Resume analysis completed', {
        overallScore: metrics.overallScore,
        atsScore: metrics.atsCompatibility?.score
      });

      return this.validateAndNormalize(metrics);
    } catch (error: any) {
      feedbackLogger.error('Failed to analyze resume', { error: error.message });
      throw new Error(`Resume analysis failed: ${error.message}`);
    }
  }

  /**
   * Quick resume scan for basic quality indicators
   * Faster than full analysis, good for initial screening
   */
  async quickScan(resumeText: string): Promise<{
    score: number;
    hasContactInfo: boolean;
    hasExperience: boolean;
    hasEducation: boolean;
    hasSkills: boolean;
    wordCount: number;
    estimatedReadTime: string;
  }> {
    const wordCount = resumeText.split(/\s+/).length;
    const lowerText = resumeText.toLowerCase();

    // Quick pattern matching for sections
    const hasContactInfo = /email|phone|@|linkedin/i.test(resumeText);
    const hasExperience = /experience|work history|employment/i.test(resumeText);
    const hasEducation = /education|degree|university|college|bachelor|master/i.test(resumeText);
    const hasSkills = /skills|technologies|proficiencies|competencies/i.test(resumeText);

    // Count action verbs
    const actionVerbs = ['led', 'managed', 'developed', 'created', 'implemented', 
      'designed', 'built', 'launched', 'increased', 'reduced', 'improved',
      'delivered', 'achieved', 'coordinated', 'executed', 'established'];
    const actionVerbCount = actionVerbs.filter(v => lowerText.includes(v)).length;

    // Count quantified achievements (numbers with context)
    const quantifiedPattern = /\d+[\s]*(percent|%|million|thousand|users|customers|team|projects|years)/gi;
    const quantifiedCount = (resumeText.match(quantifiedPattern) || []).length;

    // Calculate quick score
    let score = 50; // Base score
    if (hasContactInfo) score += 10;
    if (hasExperience) score += 15;
    if (hasEducation) score += 10;
    if (hasSkills) score += 10;
    score += Math.min(actionVerbCount * 2, 10);
    score += Math.min(quantifiedCount * 3, 15);

    // Penalize for too short or too long
    if (wordCount < 200) score -= 15;
    else if (wordCount > 1000) score -= 5;

    return {
      score: Math.min(100, Math.max(0, score)),
      hasContactInfo,
      hasExperience,
      hasEducation,
      hasSkills,
      wordCount,
      estimatedReadTime: wordCount < 300 ? '1-2 min' : wordCount < 600 ? '2-3 min' : '3-5 min'
    };
  }

  /**
   * Generate resume improvement suggestions based on job description
   */
  async generateImprovementSuggestions(
    resumeText: string,
    jobDescription: string
  ): Promise<{
    keywordGaps: string[];
    structureSuggestions: string[];
    contentSuggestions: string[];
    prioritizedActions: string[];
  }> {
    const systemPrompt = `You are a resume optimization expert. Compare the resume to the job description and provide specific, actionable improvement suggestions.

Return a JSON object with:
{
  "keywordGaps": ["keywords from job description missing in resume"],
  "structureSuggestions": ["formatting and structure improvements"],
  "contentSuggestions": ["content additions or modifications"],
  "prioritizedActions": ["top 3-5 most impactful changes, ordered by importance"]
}`;

    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Resume:\n${resumeText}\n\nJob Description:\n${jobDescription}` }
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' }
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('No response from OpenAI');
    }

    return JSON.parse(content);
  }

  // ========================================
  // PRIVATE HELPERS
  // ========================================

  private buildUserPrompt(
    resumeText: string,
    jobTitle?: string,
    jobDescription?: string,
    targetCompany?: string
  ): string {
    let prompt = `Analyze the following resume:\n\n${resumeText}`;

    if (jobTitle) {
      prompt += `\n\nTarget Job Title: ${jobTitle}`;
    }

    if (jobDescription) {
      prompt += `\n\nJob Description:\n${jobDescription}`;
    }

    if (targetCompany) {
      prompt += `\n\nTarget Company: ${targetCompany}`;
    }

    return prompt;
  }

  private validateAndNormalize(metrics: ResumeQualityMetrics): ResumeQualityMetrics {
    // Ensure all scores are within 0-100
    const clamp = (val: number) => Math.min(100, Math.max(0, val || 0));

    return {
      overallScore: clamp(metrics.overallScore),
      breakdown: {
        keywordRelevance: clamp(metrics.breakdown?.keywordRelevance),
        formatting: clamp(metrics.breakdown?.formatting),
        impactStatements: clamp(metrics.breakdown?.impactStatements),
        completeness: clamp(metrics.breakdown?.completeness),
        clarity: clamp(metrics.breakdown?.clarity),
      },
      insights: {
        strengths: metrics.insights?.strengths || [],
        improvements: metrics.insights?.improvements || [],
        missingKeywords: metrics.insights?.missingKeywords || [],
        actionVerbsUsed: metrics.insights?.actionVerbsUsed || [],
        quantifiedAchievements: metrics.insights?.quantifiedAchievements || 0,
      },
      atsCompatibility: {
        score: clamp(metrics.atsCompatibility?.score),
        issues: metrics.atsCompatibility?.issues || [],
        recommendations: metrics.atsCompatibility?.recommendations || [],
      },
      sections: {
        found: metrics.sections?.found || [],
        missing: metrics.sections?.missing || [],
      },
    };
  }
}

// ========================================
// SINGLETON INSTANCE
// ========================================

let resumeQualityService: ResumeQualityService | null = null;

export function getResumeQualityService(): ResumeQualityService {
  if (!resumeQualityService) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is required for resume quality analysis');
    }
    resumeQualityService = new ResumeQualityService(apiKey);
  }
  return resumeQualityService;
}

export default ResumeQualityService;
