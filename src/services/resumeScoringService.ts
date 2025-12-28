/**
 * Resume Scoring Service
 * 
 * Provider-agnostic ATS-style scoring service.
 * Supports multiple scoring providers with a unified interface.
 * 
 * Providers:
 * - AFFINDA: External ATS parser/matcher
 * - TEXTKERNEL: External resume parser
 * - INTERNAL_KEYWORD: Internal keyword matching
 * - INTERNAL_INTERVIEW_OUTCOME: Derived from interview performance
 * 
 * @module services/resumeScoringService
 */

import { PrismaClient, ResumeScoreProvider } from '@prisma/client';
import logger from '../utils/logger';

const prisma = new PrismaClient();
const scoringLogger = logger.child({ component: 'resume-scoring' });

// ========================================
// INTERFACES
// ========================================

export interface ParsedResumeData {
  candidateName?: string;
  email?: string;
  phone?: string;
  location?: string;
  currentTitle?: string;
  yearsOfExperience?: number;
  skills: string[];
  education: Array<{
    institution: string;
    degree?: string;
    field?: string;
    year?: number;
  }>;
  experience: Array<{
    company: string;
    title: string;
    duration?: string;
    highlights: string[];
  }>;
  certifications: string[];
  languages: string[];
}

export interface ScoreBreakdown {
  skillsMatch: number;       // 0-100
  experienceMatch: number;   // 0-100
  educationMatch: number;    // 0-100
  keywordMatch: number;      // 0-100
  overallFit: number;        // 0-100
  details?: {
    matchedSkills: string[];
    missingSkills: string[];
    experienceYears: number;
    relevantExperience: string[];
  };
}

export interface ScoringResult {
  score: number;             // 0-100
  provider: ResumeScoreProvider;
  breakdown: ScoreBreakdown;
  computedAt: Date;
}

export interface ResumeParsingProvider {
  parse(fileBase64: string, mimeType: string): Promise<ParsedResumeData>;
}

export interface ResumeScoringProvider {
  score(
    parsedData: ParsedResumeData,
    roleTitle: string,
    jobDescription?: string
  ): Promise<ScoringResult>;
}

// ========================================
// ROLE KEYWORDS DATABASE
// Common keywords expected for different roles
// ========================================

const ROLE_KEYWORDS: Record<string, string[]> = {
  'software engineer': [
    'javascript', 'typescript', 'python', 'java', 'react', 'node.js', 'sql',
    'git', 'agile', 'rest api', 'testing', 'ci/cd', 'docker', 'aws',
    'algorithm', 'data structure', 'oop', 'design patterns', 'microservices'
  ],
  'product manager': [
    'product roadmap', 'user research', 'agile', 'scrum', 'stakeholder',
    'metrics', 'kpi', 'a/b testing', 'user stories', 'prioritization',
    'market analysis', 'competitive analysis', 'product strategy', 'mvp'
  ],
  'data analyst': [
    'sql', 'python', 'excel', 'tableau', 'power bi', 'statistics',
    'data visualization', 'reporting', 'analytics', 'etl', 'dashboard',
    'business intelligence', 'data mining', 'regression', 'forecasting'
  ],
  'data scientist': [
    'python', 'machine learning', 'tensorflow', 'pytorch', 'statistics',
    'sql', 'pandas', 'numpy', 'scikit-learn', 'deep learning', 'nlp',
    'computer vision', 'feature engineering', 'model deployment', 'a/b testing'
  ],
  'ux designer': [
    'figma', 'sketch', 'user research', 'wireframe', 'prototype',
    'usability testing', 'information architecture', 'design system',
    'interaction design', 'user journey', 'accessibility', 'responsive design'
  ],
  'marketing manager': [
    'digital marketing', 'seo', 'sem', 'social media', 'content marketing',
    'email marketing', 'analytics', 'campaign', 'brand', 'lead generation',
    'marketing automation', 'crm', 'roi', 'conversion optimization'
  ],
  'project manager': [
    'project planning', 'agile', 'scrum', 'pmp', 'risk management',
    'stakeholder management', 'budget', 'timeline', 'resource allocation',
    'jira', 'gantt chart', 'milestone', 'deliverable', 'change management'
  ],
  'devops engineer': [
    'docker', 'kubernetes', 'aws', 'gcp', 'azure', 'terraform',
    'ci/cd', 'jenkins', 'ansible', 'linux', 'monitoring', 'prometheus',
    'grafana', 'infrastructure as code', 'automation', 'scripting'
  ]
};

// Seniority level expectations
const SENIORITY_EXPERIENCE: Record<string, { min: number; max: number }> = {
  'intern': { min: 0, max: 1 },
  'junior': { min: 0, max: 2 },
  'mid': { min: 2, max: 5 },
  'senior': { min: 5, max: 10 },
  'staff': { min: 8, max: 15 },
  'principal': { min: 10, max: 25 }
};

// ========================================
// INTERNAL KEYWORD SCORING PROVIDER
// ========================================

export class InternalKeywordScoringProvider implements ResumeScoringProvider {
  async score(
    parsedData: ParsedResumeData,
    roleTitle: string,
    _jobDescription?: string
  ): Promise<ScoringResult> {
    const normalizedRole = roleTitle.toLowerCase().trim();
    
    // Get keywords for this role (or use generic tech keywords)
    const roleKeywords = this.findMatchingRoleKeywords(normalizedRole);
    
    // Extract all text from resume for matching
    const resumeText = this.extractAllText(parsedData).toLowerCase();
    const resumeSkills = parsedData.skills.map(s => s.toLowerCase());
    
    // Calculate skill match
    const matchedSkills: string[] = [];
    const missingSkills: string[] = [];
    
    for (const keyword of roleKeywords) {
      const keywordLower = keyword.toLowerCase();
      if (resumeText.includes(keywordLower) || resumeSkills.some(s => s.includes(keywordLower))) {
        matchedSkills.push(keyword);
      } else {
        missingSkills.push(keyword);
      }
    }
    
    const skillsMatchScore = roleKeywords.length > 0 
      ? (matchedSkills.length / roleKeywords.length) * 100 
      : 50;
    
    // Calculate experience match
    const experienceYears = parsedData.yearsOfExperience || this.estimateExperience(parsedData);
    const experienceScore = this.calculateExperienceScore(experienceYears, normalizedRole);
    
    // Calculate education match (simpler scoring)
    const educationScore = parsedData.education.length > 0 ? 70 : 40;
    
    // Calculate keyword density in experience descriptions
    const relevantExperience = this.findRelevantExperience(parsedData.experience, roleKeywords);
    const keywordScore = Math.min(100, (relevantExperience.length / Math.max(parsedData.experience.length, 1)) * 100);
    
    // Calculate overall score (weighted average)
    const overallScore = Math.round(
      skillsMatchScore * 0.40 +
      experienceScore * 0.30 +
      educationScore * 0.15 +
      keywordScore * 0.15
    );
    
    const breakdown: ScoreBreakdown = {
      skillsMatch: Math.round(skillsMatchScore),
      experienceMatch: Math.round(experienceScore),
      educationMatch: Math.round(educationScore),
      keywordMatch: Math.round(keywordScore),
      overallFit: overallScore,
      details: {
        matchedSkills,
        missingSkills,
        experienceYears,
        relevantExperience: relevantExperience.map(e => e.title)
      }
    };
    
    return {
      score: overallScore,
      provider: 'INTERNAL_KEYWORD' as ResumeScoreProvider,
      breakdown,
      computedAt: new Date()
    };
  }
  
  private findMatchingRoleKeywords(roleTitle: string): string[] {
    // Try exact match first
    if (ROLE_KEYWORDS[roleTitle]) {
      return ROLE_KEYWORDS[roleTitle];
    }
    
    // Try partial match
    for (const [role, keywords] of Object.entries(ROLE_KEYWORDS)) {
      if (roleTitle.includes(role) || role.includes(roleTitle)) {
        return keywords;
      }
    }
    
    // Default generic keywords
    return [
      'communication', 'teamwork', 'problem-solving', 'leadership',
      'project management', 'analytical', 'detail-oriented'
    ];
  }
  
  private extractAllText(data: ParsedResumeData): string {
    const parts = [
      data.currentTitle || '',
      ...data.skills,
      ...data.experience.flatMap(e => [e.title, e.company, ...e.highlights]),
      ...data.education.map(e => `${e.degree || ''} ${e.field || ''} ${e.institution}`),
      ...data.certifications
    ];
    return parts.join(' ');
  }
  
  private estimateExperience(data: ParsedResumeData): number {
    // Estimate from experience entries
    return Math.min(data.experience.length * 2, 15);
  }
  
  private calculateExperienceScore(years: number, roleTitle: string): number {
    // Extract seniority from role title if present
    const seniority = this.extractSeniority(roleTitle);
    const expected = SENIORITY_EXPERIENCE[seniority] || { min: 2, max: 8 };
    
    if (years >= expected.min && years <= expected.max) {
      return 100;
    } else if (years < expected.min) {
      return Math.max(30, 100 - (expected.min - years) * 15);
    } else {
      return Math.max(50, 100 - (years - expected.max) * 5);
    }
  }
  
  private extractSeniority(roleTitle: string): string {
    const lower = roleTitle.toLowerCase();
    for (const seniority of Object.keys(SENIORITY_EXPERIENCE)) {
      if (lower.includes(seniority)) {
        return seniority;
      }
    }
    return 'mid';
  }
  
  private findRelevantExperience(
    experience: ParsedResumeData['experience'],
    keywords: string[]
  ): ParsedResumeData['experience'] {
    return experience.filter(exp => {
      const expText = `${exp.title} ${exp.company} ${exp.highlights.join(' ')}`.toLowerCase();
      return keywords.some(k => expText.includes(k.toLowerCase()));
    });
  }
}

// ========================================
// INTERNAL INTERVIEW OUTCOME SCORING
// ========================================

export class InternalInterviewOutcomeScoringProvider implements ResumeScoringProvider {
  async score(
    _parsedData: ParsedResumeData,
    roleTitle: string,
    _jobDescription?: string
  ): Promise<ScoringResult> {
    // This provider scores based on actual interview outcomes
    // It should be called with the resumeId to look up past interviews
    
    // For now, return a placeholder - the actual implementation
    // would query interview scores for this resume/role combination
    
    return {
      score: 50, // Neutral score when no interview data
      provider: 'INTERNAL_INTERVIEW_OUTCOME' as ResumeScoreProvider,
      breakdown: {
        skillsMatch: 50,
        experienceMatch: 50,
        educationMatch: 50,
        keywordMatch: 50,
        overallFit: 50
      },
      computedAt: new Date()
    };
  }
  
  /**
   * Calculate score based on interview outcomes for a specific resume
   */
  async scoreFromInterviews(
    resumeId: string,
    roleTitle: string
  ): Promise<ScoringResult | null> {
    try {
      // Get interviews that used this resume and match the role
      const interviews = await prisma.interview.findMany({
        where: {
          resumeId,
          jobTitle: {
            contains: roleTitle,
            mode: 'insensitive'
          },
          status: 'COMPLETED',
          score: { not: null }
        },
        select: {
          score: true,
          createdAt: true
        },
        orderBy: { createdAt: 'desc' },
        take: 10 // Last 10 interviews
      });
      
      if (interviews.length === 0) {
        return null;
      }
      
      // Calculate weighted average (more recent = higher weight)
      let totalWeight = 0;
      let weightedSum = 0;
      
      interviews.forEach((interview, index) => {
        const weight = 1 / (index + 1); // Decreasing weight for older interviews
        weightedSum += (interview.score || 0) * weight;
        totalWeight += weight;
      });
      
      const averageScore = Math.round(weightedSum / totalWeight);
      
      return {
        score: averageScore,
        provider: 'INTERNAL_INTERVIEW_OUTCOME' as ResumeScoreProvider,
        breakdown: {
          skillsMatch: averageScore,
          experienceMatch: averageScore,
          educationMatch: averageScore,
          keywordMatch: averageScore,
          overallFit: averageScore,
          details: {
            matchedSkills: [],
            missingSkills: [],
            experienceYears: 0,
            relevantExperience: [`Based on ${interviews.length} interview(s)`]
          }
        },
        computedAt: new Date()
      };
    } catch (error: any) {
      scoringLogger.error('Failed to score from interviews', { error: error.message });
      return null;
    }
  }
}

// ========================================
// AFFINDA PROVIDER PLACEHOLDER
// ========================================

export class AffindaScoringProvider implements ResumeScoringProvider {
  private apiKey?: string;
  
  constructor() {
    this.apiKey = process.env.AFFINDA_API_KEY;
  }
  
  async score(
    parsedData: ParsedResumeData,
    roleTitle: string,
    jobDescription?: string
  ): Promise<ScoringResult> {
    if (!this.apiKey) {
      scoringLogger.warn('Affinda API key not configured, falling back to internal scoring');
      const fallback = new InternalKeywordScoringProvider();
      return fallback.score(parsedData, roleTitle, jobDescription);
    }
    
    // TODO: Implement actual Affinda API call
    // For now, fall back to internal scoring
    const fallback = new InternalKeywordScoringProvider();
    const result = await fallback.score(parsedData, roleTitle, jobDescription);
    
    return {
      ...result,
      provider: 'AFFINDA' as ResumeScoreProvider
    };
  }
}

// ========================================
// TEXTKERNEL PROVIDER PLACEHOLDER
// ========================================

export class TextkernelScoringProvider implements ResumeScoringProvider {
  private apiKey?: string;
  
  constructor() {
    this.apiKey = process.env.TEXTKERNEL_API_KEY;
  }
  
  async score(
    parsedData: ParsedResumeData,
    roleTitle: string,
    jobDescription?: string
  ): Promise<ScoringResult> {
    if (!this.apiKey) {
      scoringLogger.warn('Textkernel API key not configured, falling back to internal scoring');
      const fallback = new InternalKeywordScoringProvider();
      return fallback.score(parsedData, roleTitle, jobDescription);
    }
    
    // TODO: Implement actual Textkernel API call
    // For now, fall back to internal scoring
    const fallback = new InternalKeywordScoringProvider();
    const result = await fallback.score(parsedData, roleTitle, jobDescription);
    
    return {
      ...result,
      provider: 'TEXTKERNEL' as ResumeScoreProvider
    };
  }
}

// ========================================
// SCORING SERVICE
// ========================================

// Cache TTL in milliseconds (24 hours)
const SCORE_CACHE_TTL = 24 * 60 * 60 * 1000;

/**
 * Get the appropriate scoring provider based on configuration
 */
function getScoringProvider(): ResumeScoringProvider {
  const provider = process.env.RESUME_SCORING_PROVIDER || 'internal';
  
  switch (provider.toLowerCase()) {
    case 'affinda':
      return new AffindaScoringProvider();
    case 'textkernel':
      return new TextkernelScoringProvider();
    case 'internal':
    default:
      return new InternalKeywordScoringProvider();
  }
}

/**
 * Score a resume against a role title
 */
export async function scoreResume(
  resumeId: string,
  roleTitle: string,
  forceRefresh: boolean = false
): Promise<ScoringResult | null> {
  try {
    // Check for cached score
    if (!forceRefresh) {
      const cached = await prisma.resumeScore.findFirst({
        where: {
          resumeId,
          roleTitle: { equals: roleTitle, mode: 'insensitive' },
          computedAt: { gt: new Date(Date.now() - SCORE_CACHE_TTL) }
        },
        orderBy: { computedAt: 'desc' }
      });
      
      if (cached) {
        scoringLogger.debug('Using cached score', { resumeId: resumeId.slice(0, 8), roleTitle });
        return {
          score: cached.score,
          provider: cached.provider as ResumeScoreProvider,
          breakdown: cached.breakdown as unknown as ScoreBreakdown,
          computedAt: cached.computedAt
        };
      }
    }
    
    // Get resume data
    const resume = await prisma.resumeDocument.findUnique({
      where: { id: resumeId },
      select: {
        parsedMetadata: true,
        parsedText: true,
        base64Data: true,
        mimeType: true
      }
    });
    
    if (!resume) {
      scoringLogger.warn('Resume not found', { resumeId: resumeId.slice(0, 8) });
      return null;
    }
    
    // Parse resume if not already parsed
    let parsedData: ParsedResumeData;
    
    if (resume.parsedMetadata) {
      parsedData = resume.parsedMetadata as unknown as ParsedResumeData;
    } else {
      // Basic parsing from text
      parsedData = {
        skills: extractSkillsFromText(resume.parsedText || ''),
        education: [],
        experience: [],
        certifications: [],
        languages: []
      };
    }
    
    // Score using configured provider
    const provider = getScoringProvider();
    const result = await provider.score(parsedData, roleTitle);
    
    // Also try interview outcome scoring
    const outcomeProvider = new InternalInterviewOutcomeScoringProvider();
    const outcomeResult = await outcomeProvider.scoreFromInterviews(resumeId, roleTitle);
    
    // Blend scores if we have interview data
    let finalResult = result;
    if (outcomeResult && outcomeResult.score !== 50) {
      finalResult = {
        ...result,
        score: Math.round(result.score * 0.6 + outcomeResult.score * 0.4),
        breakdown: {
          ...result.breakdown,
          overallFit: Math.round(result.breakdown.overallFit * 0.6 + outcomeResult.breakdown.overallFit * 0.4)
        }
      };
    }
    
    // Cache the result
    await prisma.resumeScore.upsert({
      where: {
        resumeId_roleTitle_provider: {
          resumeId,
          roleTitle,
          provider: finalResult.provider
        }
      },
      update: {
        score: finalResult.score,
        breakdown: finalResult.breakdown as any,
        computedAt: new Date()
      },
      create: {
        resumeId,
        roleTitle,
        score: finalResult.score,
        provider: finalResult.provider,
        breakdown: finalResult.breakdown as any,
        computedAt: new Date()
      }
    });
    
    scoringLogger.info('Resume scored', {
      resumeId: resumeId.slice(0, 8),
      roleTitle,
      score: finalResult.score,
      provider: finalResult.provider
    });
    
    return finalResult;
  } catch (error: any) {
    scoringLogger.error('Failed to score resume', { error: error.message });
    return null;
  }
}

/**
 * Get all scores for a resume
 */
export async function getResumeScores(resumeId: string): Promise<ScoringResult[]> {
  try {
    const scores = await prisma.resumeScore.findMany({
      where: { resumeId },
      orderBy: { computedAt: 'desc' }
    });
    
    return scores.map(s => ({
      score: s.score,
      provider: s.provider as ResumeScoreProvider,
      breakdown: s.breakdown as unknown as ScoreBreakdown,
      computedAt: s.computedAt
    }));
  } catch (error: any) {
    scoringLogger.error('Failed to get resume scores', { error: error.message });
    return [];
  }
}

/**
 * Simple skill extraction from text
 */
function extractSkillsFromText(text: string): string[] {
  const commonSkills = [
    'javascript', 'typescript', 'python', 'java', 'react', 'node.js', 'sql',
    'git', 'docker', 'aws', 'agile', 'scrum', 'communication', 'leadership',
    'project management', 'data analysis', 'machine learning', 'excel',
    'powerpoint', 'word', 'presentation', 'teamwork', 'problem-solving'
  ];
  
  const textLower = text.toLowerCase();
  return commonSkills.filter(skill => textLower.includes(skill));
}

export default {
  scoreResume,
  getResumeScores,
  InternalKeywordScoringProvider,
  InternalInterviewOutcomeScoringProvider,
  AffindaScoringProvider,
  TextkernelScoringProvider
};
