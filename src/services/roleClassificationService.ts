/**
 * Role Classification Service
 * 
 * Hybrid approach (C): Deterministic rules first, LLM fallback when confidence is low.
 * Classifies resumes into a product-oriented taxonomy for filtering in Resume Library.
 */

export type AlignedRoleSource = 'RULES' | 'LLM';

export const ALIGNED_ROLES = [
  'SOFTWARE_ENGINEERING',
  'DATA_SCIENCE',
  'PRODUCT_MANAGEMENT',
  'DESIGN',
  'MARKETING',
  'SALES',
  'FINANCE',
  'OPERATIONS',
  'HR',
  'LEGAL',
  'CUSTOMER_SUCCESS',
  'OTHER',
] as const;

export type AlignedRole = (typeof ALIGNED_ROLES)[number];

// ========================================
// TYPES
// ========================================

export interface RoleClassificationResult {
  alignedRole: AlignedRole;
  confidence: number; // 0.0 - 1.0
  source: AlignedRoleSource;
  matchedKeywords?: string[];
}

// ========================================
// ROLE TAXONOMY & KEYWORDS
// ========================================

/**
 * Product-oriented role taxonomy with keyword mappings.
 * Keywords are lowercase for case-insensitive matching.
 */
export const ROLE_TAXONOMY: Record<AlignedRole, {
  label: string;
  keywords: string[];
  titlePatterns: RegExp[];
}> = {
  SOFTWARE_ENGINEERING: {
    label: 'Software Engineering',
    keywords: [
      'software', 'developer', 'engineer', 'programming', 'code', 'coding',
      'frontend', 'backend', 'fullstack', 'full-stack', 'devops', 'sre',
      'javascript', 'typescript', 'python', 'java', 'react', 'node', 'angular',
      'vue', 'golang', 'rust', 'c++', 'c#', '.net', 'ruby', 'rails', 'django',
      'spring', 'kubernetes', 'docker', 'aws', 'azure', 'gcp', 'cloud',
      'api', 'microservices', 'database', 'sql', 'nosql', 'mongodb',
      'postgresql', 'mysql', 'redis', 'graphql', 'rest', 'ci/cd', 'git',
      'agile', 'scrum', 'mobile', 'ios', 'android', 'flutter', 'react native'
    ],
    titlePatterns: [
      /software\s*(engineer|developer)/i,
      /(frontend|backend|fullstack|full-stack)\s*(engineer|developer)/i,
      /(web|mobile|ios|android)\s*developer/i,
      /devops\s*engineer/i,
      /sre|site reliability/i,
      /technical\s*lead/i,
      /tech\s*lead/i,
      /engineering\s*manager/i
    ]
  },
  DATA_SCIENCE: {
    label: 'Data Science',
    keywords: [
      'data', 'science', 'scientist', 'machine learning', 'ml', 'ai',
      'artificial intelligence', 'deep learning', 'neural', 'nlp',
      'natural language', 'computer vision', 'tensorflow', 'pytorch',
      'keras', 'scikit', 'pandas', 'numpy', 'jupyter', 'statistics',
      'statistical', 'modeling', 'predictive', 'analytics', 'analyst',
      'big data', 'spark', 'hadoop', 'etl', 'data pipeline', 'dbt',
      'snowflake', 'databricks', 'tableau', 'power bi', 'visualization',
      'a/b testing', 'experimentation', 'llm', 'generative ai'
    ],
    titlePatterns: [
      /data\s*scientist/i,
      /data\s*analyst/i,
      /data\s*engineer/i,
      /machine\s*learning\s*(engineer|scientist)/i,
      /ml\s*engineer/i,
      /ai\s*(engineer|researcher)/i,
      /analytics\s*(engineer|manager)/i,
      /bi\s*(analyst|developer)/i
    ]
  },
  PRODUCT_MANAGEMENT: {
    label: 'Product Management',
    keywords: [
      'product', 'manager', 'pm', 'roadmap', 'backlog', 'user story',
      'requirements', 'stakeholder', 'prioritization', 'mvp', 'feature',
      'release', 'sprint', 'okr', 'kpi', 'metrics', 'user research',
      'customer discovery', 'product strategy', 'go-to-market', 'gtm',
      'product-led', 'growth', 'monetization', 'pricing', 'competitive',
      'market research', 'jira', 'confluence', 'asana', 'notion',
      'figma collaboration', 'cross-functional', 'product owner'
    ],
    titlePatterns: [
      /product\s*manager/i,
      /product\s*owner/i,
      /pm$/i,
      /associate\s*pm/i,
      /senior\s*pm/i,
      /vp\s*(of\s*)?product/i,
      /chief\s*product/i,
      /cpo/i,
      /product\s*director/i
    ]
  },
  DESIGN: {
    label: 'Design',
    keywords: [
      'design', 'designer', 'ux', 'ui', 'user experience', 'user interface',
      'figma', 'sketch', 'adobe xd', 'invision', 'prototype', 'wireframe',
      'mockup', 'usability', 'accessibility', 'a11y', 'responsive',
      'mobile design', 'web design', 'graphic', 'visual', 'brand',
      'typography', 'color theory', 'design system', 'component library',
      'interaction design', 'motion design', 'animation', 'illustration',
      'photoshop', 'illustrator', 'indesign', 'creative', 'art direction'
    ],
    titlePatterns: [
      /ux\s*designer/i,
      /ui\s*designer/i,
      /ux\/ui|ui\/ux/i,
      /product\s*designer/i,
      /visual\s*designer/i,
      /graphic\s*designer/i,
      /interaction\s*designer/i,
      /design\s*(lead|manager|director)/i,
      /creative\s*director/i
    ]
  },
  MARKETING: {
    label: 'Marketing',
    keywords: [
      'marketing', 'marketer', 'brand', 'campaign', 'digital marketing',
      'content', 'seo', 'sem', 'ppc', 'google ads', 'facebook ads',
      'social media', 'email marketing', 'automation', 'hubspot',
      'mailchimp', 'salesforce marketing', 'marketo', 'pardot',
      'lead generation', 'demand gen', 'inbound', 'outbound',
      'content strategy', 'copywriting', 'copy', 'messaging',
      'brand awareness', 'performance marketing', 'growth marketing',
      'influencer', 'pr', 'public relations', 'communications'
    ],
    titlePatterns: [
      /marketing\s*(manager|director|specialist|coordinator)/i,
      /digital\s*marketing/i,
      /content\s*(manager|strategist|writer)/i,
      /seo\s*(manager|specialist)/i,
      /growth\s*marketer/i,
      /brand\s*manager/i,
      /demand\s*gen/i,
      /cmo/i,
      /vp\s*(of\s*)?marketing/i
    ]
  },
  SALES: {
    label: 'Sales',
    keywords: [
      'sales', 'selling', 'revenue', 'quota', 'pipeline', 'crm',
      'salesforce', 'hubspot crm', 'prospecting', 'cold calling',
      'outreach', 'closing', 'negotiation', 'account executive', 'ae',
      'sdr', 'bdr', 'business development', 'enterprise sales',
      'saas sales', 'b2b', 'b2c', 'retail', 'wholesale',
      'territory', 'forecast', 'commission', 'upsell', 'cross-sell',
      'customer acquisition', 'deal', 'contract', 'rfp', 'proposal'
    ],
    titlePatterns: [
      /sales\s*(representative|rep|manager|director|executive)/i,
      /account\s*executive/i,
      /business\s*development/i,
      /sdr|bdr/i,
      /sales\s*engineer/i,
      /vp\s*(of\s*)?sales/i,
      /chief\s*revenue/i,
      /cro/i
    ]
  },
  FINANCE: {
    label: 'Finance',
    keywords: [
      'finance', 'financial', 'accounting', 'accountant', 'cpa', 'cfa',
      'budget', 'forecasting', 'reporting', 'audit', 'compliance',
      'tax', 'treasury', 'investment', 'banking', 'analyst', 'fp&a',
      'controller', 'bookkeeping', 'gaap', 'ifrs', 'quickbooks',
      'excel', 'financial modeling', 'valuation', 'due diligence',
      'm&a', 'private equity', 'venture capital', 'vc', 'hedge fund',
      'portfolio', 'risk management', 'credit', 'underwriting'
    ],
    titlePatterns: [
      /finance\s*(manager|director|analyst)/i,
      /financial\s*analyst/i,
      /accountant/i,
      /controller/i,
      /fp&a/i,
      /cfo/i,
      /vp\s*(of\s*)?finance/i,
      /treasurer/i,
      /auditor/i
    ]
  },
  OPERATIONS: {
    label: 'Operations',
    keywords: [
      'operations', 'ops', 'logistics', 'supply chain', 'procurement',
      'inventory', 'warehouse', 'fulfillment', 'shipping', 'distribution',
      'manufacturing', 'production', 'quality', 'qc', 'qa', 'lean',
      'six sigma', 'process improvement', 'efficiency', 'automation',
      'vendor management', 'supplier', 'erp', 'sap', 'oracle',
      'project management', 'pmp', 'program manager', 'scrum master'
    ],
    titlePatterns: [
      /operations\s*(manager|director|analyst)/i,
      /ops\s*manager/i,
      /supply\s*chain/i,
      /logistics\s*(manager|coordinator)/i,
      /project\s*manager/i,
      /program\s*manager/i,
      /coo/i,
      /vp\s*(of\s*)?operations/i
    ]
  },
  HR: {
    label: 'Human Resources',
    keywords: [
      'hr', 'human resources', 'recruiting', 'recruiter', 'talent',
      'talent acquisition', 'hiring', 'onboarding', 'employee',
      'people operations', 'people ops', 'hrbp', 'compensation',
      'benefits', 'payroll', 'workday', 'adp', 'bamboohr', 'greenhouse',
      'lever', 'linkedin recruiter', 'employer brand', 'culture',
      'diversity', 'dei', 'inclusion', 'training', 'l&d',
      'learning development', 'performance management', 'engagement'
    ],
    titlePatterns: [
      /hr\s*(manager|director|specialist|coordinator)/i,
      /human\s*resources/i,
      /recruiter/i,
      /talent\s*acquisition/i,
      /people\s*operations/i,
      /hrbp/i,
      /chro/i,
      /vp\s*(of\s*)?(hr|people)/i
    ]
  },
  LEGAL: {
    label: 'Legal',
    keywords: [
      'legal', 'lawyer', 'attorney', 'counsel', 'law', 'litigation',
      'contract', 'compliance', 'regulatory', 'ip', 'intellectual property',
      'patent', 'trademark', 'copyright', 'corporate law', 'employment law',
      'privacy', 'gdpr', 'ccpa', 'data protection', 'paralegal',
      'legal ops', 'contract management', 'negotiation', 'dispute',
      'arbitration', 'mediation', 'due diligence', 'governance'
    ],
    titlePatterns: [
      /lawyer|attorney/i,
      /legal\s*(counsel|manager|director)/i,
      /general\s*counsel/i,
      /paralegal/i,
      /compliance\s*(officer|manager)/i,
      /clo/i,
      /vp\s*(of\s*)?legal/i
    ]
  },
  CUSTOMER_SUCCESS: {
    label: 'Customer Success',
    keywords: [
      'customer success', 'csm', 'customer service', 'support',
      'account management', 'client success', 'customer experience',
      'cx', 'nps', 'csat', 'retention', 'churn', 'renewal',
      'onboarding', 'implementation', 'adoption', 'escalation',
      'zendesk', 'intercom', 'freshdesk', 'gainsight', 'totango',
      'help desk', 'technical support', 'troubleshooting'
    ],
    titlePatterns: [
      /customer\s*success\s*(manager|director)/i,
      /csm/i,
      /account\s*manager/i,
      /customer\s*support/i,
      /customer\s*service/i,
      /customer\s*experience/i,
      /client\s*success/i,
      /support\s*(engineer|specialist)/i
    ]
  },
  OTHER: {
    label: 'Other',
    keywords: [],
    titlePatterns: []
  }
};

// Confidence threshold for LLM fallback
const LLM_FALLBACK_THRESHOLD = 0.5;

// ========================================
// CLASSIFICATION FUNCTIONS
// ========================================

/**
 * Classify resume role using deterministic rules.
 * Analyzes title, tags, parsed text, and filename.
 */
export function classifyRoleByRules(
  title: string,
  tags: string[],
  parsedText?: string | null,
  fileName?: string
): RoleClassificationResult {
  const combinedText = [
    title,
    fileName?.replace(/\.[^/.]+$/, '') || '',
    ...tags,
    parsedText?.slice(0, 5000) || '' // First 5000 chars of parsed text
  ].join(' ').toLowerCase();

  const scores: Array<{
    role: AlignedRole;
    score: number;
    matches: string[];
  }> = [];

  // Score each role
  for (const [roleKey, config] of Object.entries(ROLE_TAXONOMY)) {
    const role = roleKey as AlignedRole;
    if (role === 'OTHER') continue;

    let score = 0;
    const matches: string[] = [];

    // Check title patterns (high weight)
    for (const pattern of config.titlePatterns) {
      if (pattern.test(title)) {
        score += 3;
        matches.push(`title:${pattern.source}`);
        break; // Only count one title match
      }
    }

    // Check keywords
    for (const keyword of config.keywords) {
      if (combinedText.includes(keyword)) {
        score += 1;
        matches.push(keyword);
      }
    }

    if (score > 0) {
      scores.push({ role, score, matches });
    }
  }

  // Sort by score descending
  scores.sort((a, b) => b.score - a.score);

  if (scores.length === 0) {
    return {
      alignedRole: 'OTHER',
      confidence: 0.3,
      source: 'RULES',
      matchedKeywords: []
    };
  }

  const best = scores[0];
  const second = scores[1];

  // Calculate confidence based on:
  // 1. Absolute score (more matches = higher confidence)
  // 2. Gap to second-best (larger gap = higher confidence)
  const absoluteConfidence = Math.min(best.score / 10, 0.7); // Max 0.7 from absolute
  const gapConfidence = second 
    ? Math.min((best.score - second.score) / best.score * 0.3, 0.3)
    : 0.3;
  
  const confidence = Math.min(absoluteConfidence + gapConfidence, 1.0);

  return {
    alignedRole: best.role,
    confidence: Math.round(confidence * 100) / 100,
    source: 'RULES',
    matchedKeywords: best.matches.slice(0, 10) // Top 10 matches
  };
}

/**
 * Get display label for an aligned role.
 */
export function getRoleLabel(role: AlignedRole): string {
  return ROLE_TAXONOMY[role]?.label || 'Other';
}

/**
 * Get all available roles with their labels.
 */
export function getAllRoles(): Array<{ value: AlignedRole; label: string }> {
  return Object.entries(ROLE_TAXONOMY).map(([value, config]) => ({
    value: value as AlignedRole,
    label: config.label
  }));
}

/**
 * Check if confidence is below threshold for LLM fallback.
 */
export function needsLlmFallback(result: RoleClassificationResult): boolean {
  return result.confidence < LLM_FALLBACK_THRESHOLD && result.alignedRole === 'OTHER';
}

/**
 * Classify resume role using LLM (placeholder for future implementation).
 * Currently returns the rules-based result.
 */
export async function classifyRoleWithLlm(
  title: string,
  tags: string[],
  parsedText?: string | null,
  fileName?: string
): Promise<RoleClassificationResult> {
  // TODO: Implement LLM classification using OpenAI/Azure OpenAI
  // For now, fall back to rules-based classification
  const rulesResult = classifyRoleByRules(title, tags, parsedText, fileName);
  
  // Mark as LLM source if we would have used LLM
  if (needsLlmFallback(rulesResult)) {
    // In future: call LLM here
    // For now, return rules result with slightly lower confidence
    return {
      ...rulesResult,
      confidence: Math.max(rulesResult.confidence - 0.1, 0.1),
      source: 'RULES' // Would be 'LLM' when implemented
    };
  }
  
  return rulesResult;
}

/**
 * Main classification entry point.
 * Uses hybrid approach: rules first, LLM fallback if needed.
 */
export async function classifyResumeRole(
  title: string,
  tags: string[],
  parsedText?: string | null,
  fileName?: string
): Promise<RoleClassificationResult> {
  const rulesResult = classifyRoleByRules(title, tags, parsedText, fileName);
  
  // If confidence is high enough, use rules result
  if (!needsLlmFallback(rulesResult)) {
    return rulesResult;
  }
  
  // Otherwise, try LLM (when implemented)
  return classifyRoleWithLlm(title, tags, parsedText, fileName);
}
