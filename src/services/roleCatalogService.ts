/**
 * Role Catalog Service
 * 
 * Provides a canonical role catalog keyed by roleKey, grouped by industry.
 * Industries are seeded from FIELD_PROMPTS (engineering, marketing, ai, 
 * agriculture, physics, dataScience, general).
 * 
 * This ensures consistent role naming across:
 * - Resume ATS scoring
 * - LinkedIn profile scoring
 * - Interview creation
 * - Dashboard filtering/benchmarks
 * 
 * @module services/roleCatalogService
 */

import { FIELD_PROMPTS } from '../prompts/fieldPrompts';

// ========================================
// INTERFACES
// ========================================

export interface RoleDefinition {
  roleKey: string;
  displayName: string;
  industry: string;
  keywords: string[];
  synonyms: string[];
  seniorityLevels: string[];
}

export interface IndustryGroup {
  industryKey: string;
  displayName: string;
  roles: RoleDefinition[];
}

// ========================================
// ROLE CATALOG
// ========================================

/**
 * Canonical role definitions grouped by industry
 * Industry keys match FIELD_PROMPTS keys for consistency
 */
const ROLE_CATALOG: Record<string, RoleDefinition[]> = {
  engineering: [
    {
      roleKey: 'software_engineer',
      displayName: 'Software Engineer',
      industry: 'engineering',
      keywords: ['javascript', 'typescript', 'python', 'java', 'react', 'node.js', 'sql', 'git', 'agile', 'rest api', 'testing', 'ci/cd', 'docker', 'aws', 'algorithm', 'data structure', 'oop', 'design patterns', 'microservices'],
      synonyms: ['swe', 'software developer', 'programmer', 'coder'],
      seniorityLevels: ['intern', 'junior', 'mid', 'senior', 'staff', 'principal']
    },
    {
      roleKey: 'frontend_developer',
      displayName: 'Frontend Developer',
      industry: 'engineering',
      keywords: ['javascript', 'typescript', 'react', 'vue', 'angular', 'html', 'css', 'sass', 'webpack', 'responsive', 'accessibility', 'ux', 'performance', 'testing'],
      synonyms: ['frontend engineer', 'front-end developer', 'ui developer'],
      seniorityLevels: ['intern', 'junior', 'mid', 'senior', 'staff']
    },
    {
      roleKey: 'backend_developer',
      displayName: 'Backend Developer',
      industry: 'engineering',
      keywords: ['python', 'java', 'node.js', 'go', 'rust', 'sql', 'postgresql', 'mongodb', 'redis', 'api', 'microservices', 'docker', 'kubernetes', 'aws', 'gcp'],
      synonyms: ['backend engineer', 'back-end developer', 'server developer'],
      seniorityLevels: ['intern', 'junior', 'mid', 'senior', 'staff']
    },
    {
      roleKey: 'fullstack_developer',
      displayName: 'Full Stack Developer',
      industry: 'engineering',
      keywords: ['javascript', 'typescript', 'react', 'node.js', 'python', 'sql', 'api', 'docker', 'aws', 'full stack', 'frontend', 'backend'],
      synonyms: ['fullstack engineer', 'full-stack developer'],
      seniorityLevels: ['intern', 'junior', 'mid', 'senior', 'staff']
    },
    {
      roleKey: 'devops_engineer',
      displayName: 'DevOps Engineer',
      industry: 'engineering',
      keywords: ['docker', 'kubernetes', 'terraform', 'ansible', 'jenkins', 'github actions', 'aws', 'gcp', 'azure', 'ci/cd', 'monitoring', 'linux', 'scripting'],
      synonyms: ['site reliability engineer', 'sre', 'platform engineer', 'infrastructure engineer'],
      seniorityLevels: ['junior', 'mid', 'senior', 'staff']
    },
    {
      roleKey: 'mobile_developer',
      displayName: 'Mobile Developer',
      industry: 'engineering',
      keywords: ['ios', 'android', 'swift', 'kotlin', 'react native', 'flutter', 'mobile', 'app store', 'xcode', 'android studio'],
      synonyms: ['mobile engineer', 'ios developer', 'android developer', 'app developer'],
      seniorityLevels: ['intern', 'junior', 'mid', 'senior', 'staff']
    },
    {
      roleKey: 'qa_engineer',
      displayName: 'QA Engineer',
      industry: 'engineering',
      keywords: ['testing', 'automation', 'selenium', 'cypress', 'jest', 'qa', 'quality', 'test cases', 'regression', 'performance testing'],
      synonyms: ['quality assurance engineer', 'test engineer', 'sdet'],
      seniorityLevels: ['junior', 'mid', 'senior']
    }
  ],
  
  marketing: [
    {
      roleKey: 'marketing_manager',
      displayName: 'Marketing Manager',
      industry: 'marketing',
      keywords: ['marketing', 'campaign', 'brand', 'strategy', 'analytics', 'roi', 'budget', 'team leadership', 'kpi', 'growth'],
      synonyms: ['head of marketing', 'marketing lead'],
      seniorityLevels: ['junior', 'mid', 'senior', 'director']
    },
    {
      roleKey: 'digital_marketing_specialist',
      displayName: 'Digital Marketing Specialist',
      industry: 'marketing',
      keywords: ['seo', 'sem', 'ppc', 'google ads', 'facebook ads', 'social media', 'content marketing', 'email marketing', 'analytics', 'conversion'],
      synonyms: ['digital marketer', 'online marketing specialist'],
      seniorityLevels: ['junior', 'mid', 'senior']
    },
    {
      roleKey: 'content_marketing_manager',
      displayName: 'Content Marketing Manager',
      industry: 'marketing',
      keywords: ['content', 'copywriting', 'blog', 'editorial', 'seo', 'content strategy', 'storytelling', 'brand voice'],
      synonyms: ['content manager', 'content strategist'],
      seniorityLevels: ['junior', 'mid', 'senior']
    },
    {
      roleKey: 'growth_marketer',
      displayName: 'Growth Marketer',
      industry: 'marketing',
      keywords: ['growth', 'acquisition', 'retention', 'funnel', 'a/b testing', 'analytics', 'conversion optimization', 'product led'],
      synonyms: ['growth hacker', 'growth manager'],
      seniorityLevels: ['junior', 'mid', 'senior']
    },
    {
      roleKey: 'brand_manager',
      displayName: 'Brand Manager',
      industry: 'marketing',
      keywords: ['brand', 'positioning', 'market research', 'competitive analysis', 'brand identity', 'messaging'],
      synonyms: ['brand strategist'],
      seniorityLevels: ['junior', 'mid', 'senior']
    }
  ],
  
  ai: [
    {
      roleKey: 'ml_engineer',
      displayName: 'Machine Learning Engineer',
      industry: 'ai',
      keywords: ['machine learning', 'python', 'tensorflow', 'pytorch', 'scikit-learn', 'deep learning', 'model training', 'mlops', 'feature engineering', 'neural networks'],
      synonyms: ['ml engineer', 'ai engineer', 'machine learning developer'],
      seniorityLevels: ['junior', 'mid', 'senior', 'staff']
    },
    {
      roleKey: 'ai_researcher',
      displayName: 'AI Researcher',
      industry: 'ai',
      keywords: ['artificial intelligence', 'research', 'publications', 'deep learning', 'nlp', 'computer vision', 'reinforcement learning', 'phd'],
      synonyms: ['research scientist', 'ai scientist'],
      seniorityLevels: ['junior', 'senior', 'principal']
    },
    {
      roleKey: 'nlp_engineer',
      displayName: 'NLP Engineer',
      industry: 'ai',
      keywords: ['nlp', 'natural language processing', 'transformers', 'bert', 'gpt', 'text classification', 'named entity recognition', 'sentiment analysis'],
      synonyms: ['natural language processing engineer'],
      seniorityLevels: ['junior', 'mid', 'senior']
    },
    {
      roleKey: 'computer_vision_engineer',
      displayName: 'Computer Vision Engineer',
      industry: 'ai',
      keywords: ['computer vision', 'image processing', 'opencv', 'cnn', 'object detection', 'image segmentation', 'deep learning'],
      synonyms: ['cv engineer', 'vision engineer'],
      seniorityLevels: ['junior', 'mid', 'senior']
    }
  ],
  
  dataScience: [
    {
      roleKey: 'data_scientist',
      displayName: 'Data Scientist',
      industry: 'dataScience',
      keywords: ['data science', 'python', 'r', 'statistics', 'machine learning', 'sql', 'visualization', 'hypothesis testing', 'a/b testing', 'modeling'],
      synonyms: ['senior data scientist', 'lead data scientist'],
      seniorityLevels: ['junior', 'mid', 'senior', 'staff']
    },
    {
      roleKey: 'data_analyst',
      displayName: 'Data Analyst',
      industry: 'dataScience',
      keywords: ['sql', 'excel', 'tableau', 'power bi', 'analytics', 'reporting', 'dashboard', 'data visualization', 'business intelligence'],
      synonyms: ['business analyst', 'analytics analyst'],
      seniorityLevels: ['junior', 'mid', 'senior']
    },
    {
      roleKey: 'data_engineer',
      displayName: 'Data Engineer',
      industry: 'dataScience',
      keywords: ['etl', 'data pipeline', 'spark', 'airflow', 'sql', 'python', 'data warehouse', 'bigquery', 'snowflake', 'dbt'],
      synonyms: ['data platform engineer'],
      seniorityLevels: ['junior', 'mid', 'senior', 'staff']
    },
    {
      roleKey: 'business_intelligence_analyst',
      displayName: 'Business Intelligence Analyst',
      industry: 'dataScience',
      keywords: ['bi', 'business intelligence', 'tableau', 'power bi', 'looker', 'reporting', 'dashboard', 'sql', 'data modeling'],
      synonyms: ['bi analyst', 'bi developer'],
      seniorityLevels: ['junior', 'mid', 'senior']
    }
  ],
  
  agriculture: [
    {
      roleKey: 'agronomist',
      displayName: 'Agronomist',
      industry: 'agriculture',
      keywords: ['agronomy', 'crop science', 'soil', 'fertilizer', 'pest management', 'irrigation', 'yield optimization', 'sustainable farming'],
      synonyms: ['crop specialist', 'agricultural scientist'],
      seniorityLevels: ['junior', 'mid', 'senior']
    },
    {
      roleKey: 'agricultural_engineer',
      displayName: 'Agricultural Engineer',
      industry: 'agriculture',
      keywords: ['agricultural engineering', 'precision agriculture', 'irrigation systems', 'farm machinery', 'automation', 'agritech'],
      synonyms: ['farm engineer', 'agtech engineer'],
      seniorityLevels: ['junior', 'mid', 'senior']
    },
    {
      roleKey: 'farm_manager',
      displayName: 'Farm Manager',
      industry: 'agriculture',
      keywords: ['farm management', 'operations', 'livestock', 'crop planning', 'budget', 'team management', 'sustainability'],
      synonyms: ['ranch manager', 'agricultural manager'],
      seniorityLevels: ['mid', 'senior']
    }
  ],
  
  physics: [
    {
      roleKey: 'research_physicist',
      displayName: 'Research Physicist',
      industry: 'physics',
      keywords: ['physics', 'research', 'experimental', 'theoretical', 'publications', 'lab work', 'data analysis', 'modeling'],
      synonyms: ['physicist', 'research scientist'],
      seniorityLevels: ['postdoc', 'junior', 'senior', 'principal']
    },
    {
      roleKey: 'applied_physicist',
      displayName: 'Applied Physicist',
      industry: 'physics',
      keywords: ['applied physics', 'instrumentation', 'sensors', 'optics', 'materials science', 'product development'],
      synonyms: ['physics engineer'],
      seniorityLevels: ['junior', 'mid', 'senior']
    }
  ],
  
  general: [
    {
      roleKey: 'project_manager',
      displayName: 'Project Manager',
      industry: 'general',
      keywords: ['project management', 'pmp', 'agile', 'scrum', 'stakeholder', 'timeline', 'budget', 'risk management', 'jira', 'confluence'],
      synonyms: ['pm', 'program manager'],
      seniorityLevels: ['junior', 'mid', 'senior', 'director']
    },
    {
      roleKey: 'product_manager',
      displayName: 'Product Manager',
      industry: 'general',
      keywords: ['product', 'roadmap', 'user research', 'agile', 'scrum', 'stakeholder', 'metrics', 'kpi', 'a/b testing', 'user stories', 'prioritization'],
      synonyms: ['pm', 'product owner'],
      seniorityLevels: ['associate', 'mid', 'senior', 'director', 'vp']
    },
    {
      roleKey: 'ux_designer',
      displayName: 'UX Designer',
      industry: 'general',
      keywords: ['ux', 'user experience', 'figma', 'sketch', 'wireframe', 'prototype', 'user research', 'usability testing', 'design systems'],
      synonyms: ['product designer', 'ux/ui designer'],
      seniorityLevels: ['junior', 'mid', 'senior', 'lead']
    },
    {
      roleKey: 'ui_designer',
      displayName: 'UI Designer',
      industry: 'general',
      keywords: ['ui', 'user interface', 'figma', 'sketch', 'visual design', 'typography', 'color theory', 'design systems', 'components'],
      synonyms: ['visual designer'],
      seniorityLevels: ['junior', 'mid', 'senior']
    },
    {
      roleKey: 'technical_writer',
      displayName: 'Technical Writer',
      industry: 'general',
      keywords: ['technical writing', 'documentation', 'api docs', 'user guides', 'markdown', 'content strategy'],
      synonyms: ['documentation engineer', 'content developer'],
      seniorityLevels: ['junior', 'mid', 'senior']
    }
  ]
};

// ========================================
// EXPORTS
// ========================================

/**
 * Get full role catalog grouped by industry
 */
export function getRoleCatalog(): IndustryGroup[] {
  return Object.entries(ROLE_CATALOG).map(([industryKey, roles]) => {
    const fieldPrompt = FIELD_PROMPTS[industryKey];
    return {
      industryKey,
      displayName: fieldPrompt?.field || industryKey,
      roles
    };
  });
}

/**
 * Get all roles as a flat array
 */
export function getAllRoles(): RoleDefinition[] {
  return Object.values(ROLE_CATALOG).flat();
}

/**
 * Get role by roleKey
 */
export function getRoleByKey(roleKey: string): RoleDefinition | undefined {
  return getAllRoles().find(r => r.roleKey === roleKey);
}

/**
 * Get keywords for a role (for scoring)
 */
export function getRoleKeywords(roleKey: string): string[] {
  const role = getRoleByKey(roleKey);
  return role?.keywords || [];
}

/**
 * Normalize a role title to canonical roleKey
 * Attempts to match against synonyms and display names
 */
export function normalizeToRoleKey(roleTitle: string): string | null {
  const normalized = roleTitle.toLowerCase().trim();
  
  for (const role of getAllRoles()) {
    // Exact match on roleKey
    if (role.roleKey === normalized) return role.roleKey;
    
    // Match on display name
    if (role.displayName.toLowerCase() === normalized) return role.roleKey;
    
    // Match on synonyms
    if (role.synonyms.some(s => s.toLowerCase() === normalized)) return role.roleKey;
    
    // Partial match on display name
    if (role.displayName.toLowerCase().includes(normalized) || 
        normalized.includes(role.displayName.toLowerCase())) {
      return role.roleKey;
    }
  }
  
  return null;
}

/**
 * Get roles for a specific industry
 */
export function getRolesByIndustry(industryKey: string): RoleDefinition[] {
  return ROLE_CATALOG[industryKey] || [];
}

/**
 * Get available industry keys
 */
export function getIndustryKeys(): string[] {
  return Object.keys(ROLE_CATALOG);
}

/**
 * Suggest similar roles for a custom role title
 * Returns top 3 matches based on keyword overlap
 */
export function suggestSimilarRoles(customRole: string, limit: number = 3): RoleDefinition[] {
  const customLower = customRole.toLowerCase();
  const words = customLower.split(/\s+/);
  
  const scored = getAllRoles().map(role => {
    let score = 0;
    
    // Score based on keyword matches
    for (const word of words) {
      if (role.keywords.some(k => k.includes(word))) score += 2;
      if (role.displayName.toLowerCase().includes(word)) score += 3;
      if (role.synonyms.some(s => s.toLowerCase().includes(word))) score += 2;
    }
    
    return { role, score };
  });
  
  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => s.role);
}
