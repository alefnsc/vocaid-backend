/**
 * LinkedIn Profile Scoring Service
 * 
 * Scores LinkedIn profiles against role requirements using keyword matching.
 * Separate from resume scoring - uses LinkedIn-specific sections.
 * 
 * @module services/linkedinProfileScoringService
 */

import logger from '../utils/logger';
import { getRoleKeywords, getRoleByKey, RoleDefinition } from './roleCatalogService';

const scoringLogger = logger.child({ component: 'linkedin-profile-scoring' });

// ========================================
// INTERFACES
// ========================================

export interface LinkedInProfileData {
  id: string;
  name?: string | null;
  email?: string | null;
  headline?: string | null;
  rawSections?: RawSections | null;
}

export interface RawSections {
  about?: string;
  experience?: ExperienceEntry[];
  education?: EducationEntry[];
  certifications?: CertificationEntry[];
  skills?: string[];
  languages?: LanguageEntry[];
}

interface ExperienceEntry {
  title: string;
  company: string;
  location?: string;
  startDate?: string;
  endDate?: string;
  current?: boolean;
  description?: string;
}

interface EducationEntry {
  school: string;
  degree?: string;
  field?: string;
  startDate?: string;
  endDate?: string;
  description?: string;
}

interface CertificationEntry {
  name: string;
  issuer?: string;
  issueDate?: string;
  expirationDate?: string;
  credentialId?: string;
  credentialUrl?: string;
}

interface LanguageEntry {
  name: string;
  proficiency?: string;
}

export interface ScoringResult {
  score: number;
  provider: string;
  breakdown: ScoringBreakdown;
}

interface ScoringBreakdown {
  skillsMatch: {
    matched: string[];
    missing: string[];
    score: number;
  };
  experienceRelevance: {
    relevantRoles: string[];
    totalYears: number;
    score: number;
  };
  educationFit: {
    degrees: string[];
    relevantFields: string[];
    score: number;
  };
  certificationBonus: {
    relevant: string[];
    score: number;
  };
  overallNotes: string[];
}

// ========================================
// SCORING LOGIC
// ========================================

/**
 * Score a LinkedIn profile for a specific role
 */
export async function scoreLinkedInProfile(
  profile: LinkedInProfileData,
  roleKey: string
): Promise<ScoringResult> {
  scoringLogger.info('Scoring LinkedIn profile', {
    profileId: profile.id.slice(0, 8),
    roleKey
  });
  
  const rawSections = (profile.rawSections || {}) as RawSections;
  const roleKeywords = getRoleKeywords(roleKey);
  
  // Extract all searchable text
  const allText = extractAllText(profile, rawSections);
  
  // Calculate component scores
  const skillsMatch = calculateSkillsMatch(rawSections.skills || [], roleKeywords, allText);
  const experienceRelevance = calculateExperienceRelevance(rawSections.experience || [], roleKeywords);
  const educationFit = calculateEducationFit(rawSections.education || [], roleKey);
  const certificationBonus = calculateCertificationBonus(rawSections.certifications || [], roleKeywords);
  
  // Weighted overall score
  const overallScore = Math.round(
    skillsMatch.score * 0.35 +
    experienceRelevance.score * 0.40 +
    educationFit.score * 0.15 +
    certificationBonus.score * 0.10
  );
  
  const notes: string[] = [];
  if (skillsMatch.matched.length >= 5) notes.push('Strong skills alignment');
  if (experienceRelevance.totalYears >= 3) notes.push('Solid experience background');
  if (certificationBonus.relevant.length > 0) notes.push('Relevant certifications found');
  if (overallScore < 50) notes.push('Consider adding more role-specific keywords');
  
  return {
    score: Math.min(100, Math.max(0, overallScore)),
    provider: 'INTERNAL_KEYWORD',
    breakdown: {
      skillsMatch,
      experienceRelevance,
      educationFit,
      certificationBonus,
      overallNotes: notes
    }
  };
}

/**
 * Extract all searchable text from profile
 */
function extractAllText(profile: LinkedInProfileData, sections: RawSections): string {
  const parts: string[] = [];
  
  if (profile.headline) parts.push(profile.headline);
  if (sections.about) parts.push(sections.about);
  
  sections.experience?.forEach(exp => {
    parts.push(exp.title, exp.company);
    if (exp.description) parts.push(exp.description);
  });
  
  sections.education?.forEach(edu => {
    parts.push(edu.school);
    if (edu.degree) parts.push(edu.degree);
    if (edu.field) parts.push(edu.field);
    if (edu.description) parts.push(edu.description);
  });
  
  sections.certifications?.forEach(cert => {
    parts.push(cert.name);
    if (cert.issuer) parts.push(cert.issuer);
  });
  
  if (sections.skills) parts.push(...sections.skills);
  
  return parts.join(' ').toLowerCase();
}

/**
 * Calculate skills match score
 */
function calculateSkillsMatch(
  profileSkills: string[],
  roleKeywords: string[],
  allText: string
): { matched: string[]; missing: string[]; score: number } {
  const matched: string[] = [];
  const missing: string[] = [];
  
  const profileSkillsLower = profileSkills.map(s => s.toLowerCase());
  
  for (const keyword of roleKeywords) {
    const keywordLower = keyword.toLowerCase();
    const found = 
      profileSkillsLower.some(s => s.includes(keywordLower)) ||
      allText.includes(keywordLower);
    
    if (found) {
      matched.push(keyword);
    } else {
      missing.push(keyword);
    }
  }
  
  const score = roleKeywords.length > 0
    ? Math.round((matched.length / roleKeywords.length) * 100)
    : 50; // Default if no keywords defined
  
  return { matched, missing, score };
}

/**
 * Calculate experience relevance score
 */
function calculateExperienceRelevance(
  experience: ExperienceEntry[],
  roleKeywords: string[]
): { relevantRoles: string[]; totalYears: number; score: number } {
  const relevantRoles: string[] = [];
  let totalMonths = 0;
  
  for (const exp of experience) {
    const titleLower = exp.title.toLowerCase();
    const descLower = (exp.description || '').toLowerCase();
    
    // Check if role is relevant
    const isRelevant = roleKeywords.some(kw => 
      titleLower.includes(kw.toLowerCase()) || 
      descLower.includes(kw.toLowerCase())
    );
    
    if (isRelevant) {
      relevantRoles.push(exp.title);
    }
    
    // Estimate duration
    const months = estimateDurationMonths(exp.startDate, exp.endDate, exp.current);
    totalMonths += months;
  }
  
  const totalYears = Math.round(totalMonths / 12 * 10) / 10;
  
  // Score based on relevance ratio and experience depth
  const relevanceRatio = experience.length > 0 
    ? relevantRoles.length / experience.length 
    : 0;
  
  const experienceDepthScore = Math.min(100, totalYears * 10); // 10 points per year, max 100
  const relevanceScore = relevanceRatio * 100;
  
  const score = Math.round(relevanceScore * 0.6 + experienceDepthScore * 0.4);
  
  return { relevantRoles, totalYears, score };
}

/**
 * Calculate education fit score
 */
function calculateEducationFit(
  education: EducationEntry[],
  roleKey: string
): { degrees: string[]; relevantFields: string[]; score: number } {
  const degrees: string[] = [];
  const relevantFields: string[] = [];
  
  // Technical roles benefit from STEM degrees
  const technicalRoles = ['software_engineer', 'frontend_developer', 'backend_developer', 
    'fullstack_developer', 'devops_engineer', 'data_scientist', 'data_analyst', 
    'ml_engineer', 'ai_researcher'];
  
  const stemFields = ['computer science', 'software', 'engineering', 'mathematics', 
    'physics', 'statistics', 'data science', 'information technology'];
  
  for (const edu of education) {
    if (edu.degree) {
      degrees.push(edu.degree);
    }
    
    const fieldLower = (edu.field || '').toLowerCase();
    const degreeLower = (edu.degree || '').toLowerCase();
    
    if (technicalRoles.includes(roleKey)) {
      if (stemFields.some(f => fieldLower.includes(f) || degreeLower.includes(f))) {
        relevantFields.push(edu.field || edu.degree || edu.school);
      }
    } else {
      // For non-technical, any degree adds value
      if (edu.degree) {
        relevantFields.push(edu.degree);
      }
    }
  }
  
  // Score: base 50, +25 for any degree, +25 for relevant field
  let score = 50;
  if (degrees.length > 0) score += 25;
  if (relevantFields.length > 0) score += 25;
  
  return { degrees, relevantFields, score };
}

/**
 * Calculate certification bonus score
 */
function calculateCertificationBonus(
  certifications: CertificationEntry[],
  roleKeywords: string[]
): { relevant: string[]; score: number } {
  const relevant: string[] = [];
  
  for (const cert of certifications) {
    const certNameLower = cert.name.toLowerCase();
    const issuerLower = (cert.issuer || '').toLowerCase();
    
    const isRelevant = roleKeywords.some(kw => 
      certNameLower.includes(kw.toLowerCase()) || 
      issuerLower.includes(kw.toLowerCase())
    );
    
    if (isRelevant) {
      relevant.push(cert.name);
    }
  }
  
  // Score: 20 points per relevant cert, max 100
  const score = Math.min(100, relevant.length * 20);
  
  return { relevant, score };
}

/**
 * Estimate duration in months between two date strings
 */
function estimateDurationMonths(
  startDate?: string,
  endDate?: string,
  current?: boolean
): number {
  if (!startDate) return 12; // Default to 1 year if unknown
  
  try {
    const start = new Date(startDate);
    const end = current || !endDate ? new Date() : new Date(endDate);
    
    const months = (end.getFullYear() - start.getFullYear()) * 12 + 
                   (end.getMonth() - start.getMonth());
    
    return Math.max(1, months);
  } catch {
    return 12; // Default on parse error
  }
}
