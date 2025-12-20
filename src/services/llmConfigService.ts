/**
 * LLM Configuration Service
 * 
 * Maps user roles, seniority levels, and language preferences to LLM prompt configurations.
 * Enables customized interview experiences based on candidate profile.
 * 
 * @module services/llmConfigService
 */

import { dbLogger } from './databaseService';

// ========================================
// TYPES
// ========================================

export interface LLMConfig {
  promptTemplate: string;
  scoringRubric: string;
  questionComplexity: 'basic' | 'intermediate' | 'advanced' | 'expert';
  focusAreas: string[];
  language: string;
  maxQuestions: number;
  interviewDurationMinutes: number;
  complexityMultiplier: number;
}

export interface ResolveConfigParams {
  currentRole?: string;
  jobTitle: string;
  seniority?: string;
  language: string;
  companyName?: string;
}

// ========================================
// ROLE CONFIGURATIONS
// ========================================

interface RoleConfig {
  promptTemplate: string;
  scoringRubric: string;
  questionComplexity: 'basic' | 'intermediate' | 'advanced' | 'expert';
  focusAreas: string[];
  maxQuestions: number;
  interviewDurationMinutes: number;
}

const ROLE_CONFIGS: Record<string, RoleConfig> = {
  'Candidate': {
    promptTemplate: 'general_candidate',
    scoringRubric: 'general_behavioral',
    questionComplexity: 'intermediate',
    focusAreas: ['communication', 'problem_solving', 'motivation', 'teamwork'],
    maxQuestions: 8,
    interviewDurationMinutes: 15,
  },
  'Student': {
    promptTemplate: 'student_entry',
    scoringRubric: 'entry_level',
    questionComplexity: 'basic',
    focusAreas: ['learning_ability', 'projects', 'fundamentals', 'enthusiasm'],
    maxQuestions: 6,
    interviewDurationMinutes: 12,
  },
  'Junior Developer': {
    promptTemplate: 'junior_technical',
    scoringRubric: 'entry_level_technical',
    questionComplexity: 'basic',
    focusAreas: ['fundamentals', 'learning_ability', 'problem_solving', 'code_quality'],
    maxQuestions: 7,
    interviewDurationMinutes: 15,
  },
  'Mid-level Developer': {
    promptTemplate: 'mid_technical',
    scoringRubric: 'mid_level_technical',
    questionComplexity: 'intermediate',
    focusAreas: ['system_design_basics', 'code_review', 'debugging', 'collaboration'],
    maxQuestions: 8,
    interviewDurationMinutes: 18,
  },
  'Senior Developer': {
    promptTemplate: 'senior_technical',
    scoringRubric: 'senior_technical',
    questionComplexity: 'advanced',
    focusAreas: ['system_design', 'architecture', 'mentoring', 'technical_leadership'],
    maxQuestions: 8,
    interviewDurationMinutes: 20,
  },
  'Tech Lead': {
    promptTemplate: 'tech_lead',
    scoringRubric: 'technical_leadership',
    questionComplexity: 'advanced',
    focusAreas: ['team_leadership', 'architecture', 'decision_making', 'stakeholder_management'],
    maxQuestions: 8,
    interviewDurationMinutes: 22,
  },
  'Engineering Manager': {
    promptTemplate: 'engineering_manager',
    scoringRubric: 'engineering_management',
    questionComplexity: 'expert',
    focusAreas: ['people_management', 'team_building', 'roadmap_planning', 'cross_functional'],
    maxQuestions: 8,
    interviewDurationMinutes: 25,
  },
  'Product Manager': {
    promptTemplate: 'product_management',
    scoringRubric: 'pm_behavioral',
    questionComplexity: 'advanced',
    focusAreas: ['stakeholder_management', 'roadmap', 'metrics', 'prioritization', 'user_focus'],
    maxQuestions: 8,
    interviewDurationMinutes: 20,
  },
  'Data Analyst': {
    promptTemplate: 'data_analyst',
    scoringRubric: 'data_analytical',
    questionComplexity: 'intermediate',
    focusAreas: ['sql', 'data_visualization', 'statistical_analysis', 'storytelling'],
    maxQuestions: 8,
    interviewDurationMinutes: 18,
  },
  'Data Engineer': {
    promptTemplate: 'data_engineer',
    scoringRubric: 'data_engineering',
    questionComplexity: 'advanced',
    focusAreas: ['data_pipelines', 'etl', 'big_data', 'data_modeling'],
    maxQuestions: 8,
    interviewDurationMinutes: 20,
  },
  'Recruiter': {
    promptTemplate: 'recruiter',
    scoringRubric: 'hr_behavioral',
    questionComplexity: 'intermediate',
    focusAreas: ['talent_acquisition', 'candidate_experience', 'sourcing', 'employer_branding'],
    maxQuestions: 7,
    interviewDurationMinutes: 15,
  },
  'HR / People Ops': {
    promptTemplate: 'hr_people_ops',
    scoringRubric: 'hr_behavioral',
    questionComplexity: 'intermediate',
    focusAreas: ['employee_relations', 'policy', 'culture', 'compliance'],
    maxQuestions: 7,
    interviewDurationMinutes: 15,
  },
  'Other': {
    promptTemplate: 'general_candidate',
    scoringRubric: 'general_behavioral',
    questionComplexity: 'intermediate',
    focusAreas: ['communication', 'problem_solving', 'adaptability', 'teamwork'],
    maxQuestions: 8,
    interviewDurationMinutes: 15,
  },
};

// ========================================
// SENIORITY MODIFIERS
// ========================================

interface SeniorityModifier {
  complexityMultiplier: number;
  additionalFocusAreas: string[];
  questionCountModifier: number;
}

const SENIORITY_MODIFIERS: Record<string, SeniorityModifier> = {
  'Intern': {
    complexityMultiplier: 0.5,
    additionalFocusAreas: ['learning_potential', 'curiosity'],
    questionCountModifier: -2,
  },
  'Junior': {
    complexityMultiplier: 0.7,
    additionalFocusAreas: ['growth_mindset'],
    questionCountModifier: -1,
  },
  'Mid': {
    complexityMultiplier: 1.0,
    additionalFocusAreas: [],
    questionCountModifier: 0,
  },
  'Senior': {
    complexityMultiplier: 1.3,
    additionalFocusAreas: ['mentoring', 'code_review'],
    questionCountModifier: 0,
  },
  'Staff': {
    complexityMultiplier: 1.5,
    additionalFocusAreas: ['cross_team_impact', 'technical_strategy'],
    questionCountModifier: 1,
  },
  'Principal': {
    complexityMultiplier: 1.7,
    additionalFocusAreas: ['org_level_impact', 'innovation'],
    questionCountModifier: 1,
  },
  'Manager': {
    complexityMultiplier: 1.4,
    additionalFocusAreas: ['people_management', 'team_health'],
    questionCountModifier: 1,
  },
};

// ========================================
// CONFIG RESOLVER
// ========================================

/**
 * Resolves the LLM configuration based on user role, job title, seniority, and language.
 * This is called during interview registration to configure the AI interviewer.
 * 
 * @param params - User and interview context
 * @returns Complete LLM configuration
 */
export function resolveLLMConfig(params: ResolveConfigParams): LLMConfig {
  const { currentRole, jobTitle, seniority, language } = params;
  
  // Get base role config (fallback to 'Candidate' if not found)
  const roleKey = currentRole && ROLE_CONFIGS[currentRole] ? currentRole : 'Candidate';
  const roleConfig = ROLE_CONFIGS[roleKey];
  
  // Get seniority modifier (fallback to 'Mid' if not found)
  const seniorityKey = seniority && SENIORITY_MODIFIERS[seniority] ? seniority : 'Mid';
  const seniorityMod = SENIORITY_MODIFIERS[seniorityKey];
  
  // Combine focus areas
  const focusAreas = [
    ...roleConfig.focusAreas,
    ...seniorityMod.additionalFocusAreas,
  ];
  
  // Calculate max questions with modifier
  const maxQuestions = Math.max(5, roleConfig.maxQuestions + seniorityMod.questionCountModifier);
  
  // Adjust complexity based on seniority
  const complexityLevels: ('basic' | 'intermediate' | 'advanced' | 'expert')[] = 
    ['basic', 'intermediate', 'advanced', 'expert'];
  const baseComplexityIndex = complexityLevels.indexOf(roleConfig.questionComplexity);
  const adjustedComplexityIndex = Math.min(
    complexityLevels.length - 1,
    Math.round(baseComplexityIndex * seniorityMod.complexityMultiplier)
  );
  
  const config: LLMConfig = {
    promptTemplate: roleConfig.promptTemplate,
    scoringRubric: roleConfig.scoringRubric,
    questionComplexity: complexityLevels[adjustedComplexityIndex],
    focusAreas,
    language: language || 'en-US',
    maxQuestions,
    interviewDurationMinutes: roleConfig.interviewDurationMinutes,
    complexityMultiplier: seniorityMod.complexityMultiplier,
  };
  
  dbLogger.info('LLM config resolved', {
    inputRole: currentRole,
    inputSeniority: seniority,
    jobTitle,
    language,
    resolvedConfig: {
      promptTemplate: config.promptTemplate,
      questionComplexity: config.questionComplexity,
      maxQuestions: config.maxQuestions,
    },
  });
  
  return config;
}

/**
 * Get available roles for frontend dropdown
 */
export function getAvailableRoles(): string[] {
  return Object.keys(ROLE_CONFIGS);
}

/**
 * Get available seniority levels for frontend dropdown
 */
export function getAvailableSeniorityLevels(): string[] {
  return Object.keys(SENIORITY_MODIFIERS);
}

/**
 * Validate if a role is supported
 */
export function isValidRole(role: string): boolean {
  return role in ROLE_CONFIGS;
}

/**
 * Validate if a seniority level is supported
 */
export function isValidSeniority(seniority: string): boolean {
  return seniority in SENIORITY_MODIFIERS;
}
