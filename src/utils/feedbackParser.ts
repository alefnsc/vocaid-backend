/**
 * Feedback Parser Utility
 * 
 * Parses Retell post-call summary markdown to extract structured scores
 * and metrics for storage in InterviewMetric table.
 * 
 * Expected markdown format from Retell Call Summary prompt:
 * - Overall Performance Score: X/100
 * - Content Quality: X/100
 * - Communication: X/100
 * - Confidence: X/100
 * - Technical Knowledge: X/100
 * - Problem Solving: X/100
 * 
 * @module utils/feedbackParser
 */

import logger from './logger';

const feedbackLogger = logger.child({ component: 'feedback-parser' });

// ========================================
// TYPES
// ========================================

export interface ParsedFeedbackScores {
  overallScore: number | null;
  contentScore: number | null;
  communicationScore: number | null;
  confidenceScore: number | null;
  technicalScore: number | null;
  problemSolvingScore: number | null;
}

export interface ParsedFeedbackSections {
  summary: string | null;
  strengths: string[];
  improvements: string[];
  recommendations: string[];
  contentQualityNotes: string | null;
  communicationNotes: string | null;
  confidenceNotes: string | null;
  technicalNotes: string | null;
  problemSolvingNotes: string | null;
}

export interface ParsedFeedback {
  scores: ParsedFeedbackScores;
  sections: ParsedFeedbackSections;
  rawMarkdown: string;
}

export interface InterviewMetricInput {
  category: string;
  metricName: string;
  score: number;
  maxScore: number;
  feedback?: string;
}

// ========================================
// SCORE EXTRACTION PATTERNS
// ========================================

const SCORE_PATTERNS = {
  overall: /Overall\s*Performance\s*Score[:\s]*(\d+)(?:\/100)?/i,
  content: /Content\s*Quality[:\s]*(\d+)(?:\/100)?/i,
  communication: /Communication[:\s]*(\d+)(?:\/100)?/i,
  confidence: /Confidence[:\s]*(\d+)(?:\/100)?/i,
  technical: /Technical\s*Knowledge[:\s]*(\d+)(?:\/100)?/i,
  problemSolving: /Problem\s*Solving[:\s]*(\d+)(?:\/100)?/i,
};

// Fallback pattern for "Score Breakdown" section bullet points
const BREAKDOWN_PATTERNS = {
  content: /-\s*Content\s*Quality[:\s]*(\d+)(?:\/100)?/i,
  communication: /-\s*Communication[:\s]*(\d+)(?:\/100)?/i,
  confidence: /-\s*Confidence[:\s]*(\d+)(?:\/100)?/i,
  technical: /-\s*Technical\s*Knowledge[:\s]*(\d+)(?:\/100)?/i,
  problemSolving: /-\s*Problem\s*Solving[:\s]*(\d+)(?:\/100)?/i,
};

// ========================================
// SCORE PARSING FUNCTIONS
// ========================================

/**
 * Extract a numeric score from markdown using a regex pattern
 */
function extractScore(markdown: string, pattern: RegExp): number | null {
  const match = markdown.match(pattern);
  if (match && match[1]) {
    const score = parseInt(match[1], 10);
    // Validate score is reasonable (0-100)
    if (score >= 0 && score <= 100) {
      return score;
    }
  }
  return null;
}

/**
 * Parse all scores from feedback markdown
 */
export function parseScores(markdown: string): ParsedFeedbackScores {
  const scores: ParsedFeedbackScores = {
    overallScore: null,
    contentScore: null,
    communicationScore: null,
    confidenceScore: null,
    technicalScore: null,
    problemSolvingScore: null,
  };

  if (!markdown) {
    return scores;
  }

  // Try primary patterns first
  scores.overallScore = extractScore(markdown, SCORE_PATTERNS.overall);
  scores.contentScore = extractScore(markdown, SCORE_PATTERNS.content) 
    ?? extractScore(markdown, BREAKDOWN_PATTERNS.content);
  scores.communicationScore = extractScore(markdown, SCORE_PATTERNS.communication)
    ?? extractScore(markdown, BREAKDOWN_PATTERNS.communication);
  scores.confidenceScore = extractScore(markdown, SCORE_PATTERNS.confidence)
    ?? extractScore(markdown, BREAKDOWN_PATTERNS.confidence);
  scores.technicalScore = extractScore(markdown, SCORE_PATTERNS.technical)
    ?? extractScore(markdown, BREAKDOWN_PATTERNS.technical);
  scores.problemSolvingScore = extractScore(markdown, SCORE_PATTERNS.problemSolving)
    ?? extractScore(markdown, BREAKDOWN_PATTERNS.problemSolving);

  feedbackLogger.debug('Parsed scores from feedback', { scores });

  return scores;
}

// ========================================
// SECTION EXTRACTION FUNCTIONS
// ========================================

/**
 * Extract content from a markdown section
 */
function extractSection(markdown: string, sectionName: string): string | null {
  // Match section header (## Section Name) until next ## or end
  const regex = new RegExp(
    `##\\s*${sectionName}[\\s\\S]*?(?=##|$)`,
    'i'
  );
  const match = markdown.match(regex);
  
  if (!match) return null;
  
  // Remove the header line and clean up
  return match[0]
    .replace(new RegExp(`##\\s*${sectionName}\\s*`, 'i'), '')
    .trim();
}

/**
 * Extract bullet points from a section
 */
function extractBulletPoints(sectionContent: string | null): string[] {
  if (!sectionContent) return [];
  
  return sectionContent
    .split('\n')
    .filter(line => line.trim().startsWith('-'))
    .map(line => line.replace(/^-\s*/, '').trim())
    .filter(item => item.length > 0);
}

/**
 * Parse all sections from feedback markdown
 */
export function parseSections(markdown: string): ParsedFeedbackSections {
  const sections: ParsedFeedbackSections = {
    summary: null,
    strengths: [],
    improvements: [],
    recommendations: [],
    contentQualityNotes: null,
    communicationNotes: null,
    confidenceNotes: null,
    technicalNotes: null,
    problemSolvingNotes: null,
  };

  if (!markdown) {
    return sections;
  }

  // Extract interview summary (first section or specific header)
  sections.summary = extractSection(markdown, 'Interview Summary');
  
  // Extract strengths
  const strengthsSection = extractSection(markdown, 'Strengths');
  sections.strengths = extractBulletPoints(strengthsSection);
  
  // Extract improvements
  const improvementsSection = extractSection(markdown, 'Improvements') 
    ?? extractSection(markdown, 'Areas for Improvement');
  sections.improvements = extractBulletPoints(improvementsSection);
  
  // Extract recommendations
  const recommendationsSection = extractSection(markdown, 'Recommendations');
  sections.recommendations = extractBulletPoints(recommendationsSection);
  
  // Extract notes for each skill category
  sections.contentQualityNotes = extractSection(markdown, 'Content Quality');
  sections.communicationNotes = extractSection(markdown, 'Communication');
  sections.confidenceNotes = extractSection(markdown, 'Confidence');
  sections.technicalNotes = extractSection(markdown, 'Technical Knowledge');
  sections.problemSolvingNotes = extractSection(markdown, 'Problem Solving');

  return sections;
}

// ========================================
// MAIN PARSING FUNCTION
// ========================================

/**
 * Parse complete feedback markdown into structured data
 */
export function parseFeedback(markdown: string): ParsedFeedback {
  const scores = parseScores(markdown);
  const sections = parseSections(markdown);

  return {
    scores,
    sections,
    rawMarkdown: markdown,
  };
}

/**
 * Convert parsed scores to InterviewMetric records
 */
export function scoresToMetrics(
  scores: ParsedFeedbackScores,
  sections: ParsedFeedbackSections
): InterviewMetricInput[] {
  const metrics: InterviewMetricInput[] = [];

  if (scores.contentScore !== null) {
    metrics.push({
      category: 'content',
      metricName: 'Content Quality',
      score: scores.contentScore,
      maxScore: 100,
      feedback: sections.contentQualityNotes ?? undefined,
    });
  }

  if (scores.communicationScore !== null) {
    metrics.push({
      category: 'communication',
      metricName: 'Communication',
      score: scores.communicationScore,
      maxScore: 100,
      feedback: sections.communicationNotes ?? undefined,
    });
  }

  if (scores.confidenceScore !== null) {
    metrics.push({
      category: 'confidence',
      metricName: 'Confidence',
      score: scores.confidenceScore,
      maxScore: 100,
      feedback: sections.confidenceNotes ?? undefined,
    });
  }

  if (scores.technicalScore !== null) {
    metrics.push({
      category: 'technical',
      metricName: 'Technical Knowledge',
      score: scores.technicalScore,
      maxScore: 100,
      feedback: sections.technicalNotes ?? undefined,
    });
  }

  if (scores.problemSolvingScore !== null) {
    metrics.push({
      category: 'problem_solving',
      metricName: 'Problem Solving',
      score: scores.problemSolvingScore,
      maxScore: 100,
      feedback: sections.problemSolvingNotes ?? undefined,
    });
  }

  feedbackLogger.debug('Converted scores to metrics', { 
    metricsCount: metrics.length,
    categories: metrics.map(m => m.category)
  });

  return metrics;
}

/**
 * Extract overall score from feedback markdown
 * Returns the score as a number (0-100) or null if not found
 */
export function extractOverallScore(markdown: string): number | null {
  if (!markdown) return null;
  
  const scores = parseScores(markdown);
  
  // Return overall score if found
  if (scores.overallScore !== null) {
    return scores.overallScore;
  }
  
  // If no overall score, compute weighted average from category scores
  const categoryScores = [
    { score: scores.contentScore, weight: 0.35 },
    { score: scores.communicationScore, weight: 0.25 },
    { score: scores.confidenceScore, weight: 0.20 },
    { score: scores.technicalScore, weight: 0.20 },
  ].filter(s => s.score !== null);

  if (categoryScores.length === 0) return null;

  const totalWeight = categoryScores.reduce((sum, s) => sum + s.weight, 0);
  const weightedSum = categoryScores.reduce(
    (sum, s) => sum + (s.score as number) * s.weight, 
    0
  );

  return Math.round(weightedSum / totalWeight);
}

// ========================================
// COMPATIBILITY ALIASES (for existing callers)
// ========================================

export interface ParsedFeedbackSummary {
  overallScore: number | null;
  categoryScores: Record<string, number>;
}

/**
 * Convenience wrapper used by interviewService and apiRoutes.
 * Returns overallScore + a flat categoryScores map for easy access.
 */
export function parseFeedbackSummary(markdown: string): ParsedFeedbackSummary {
  const parsed = parseFeedback(markdown);
  const categoryScores: Record<string, number> = {};

  if (parsed.scores.contentScore !== null) {
    categoryScores.content = parsed.scores.contentScore;
  }
  if (parsed.scores.communicationScore !== null) {
    categoryScores.communication = parsed.scores.communicationScore;
  }
  if (parsed.scores.confidenceScore !== null) {
    categoryScores.confidence = parsed.scores.confidenceScore;
  }
  if (parsed.scores.technicalScore !== null) {
    categoryScores.technical = parsed.scores.technicalScore;
  }
  if (parsed.scores.problemSolvingScore !== null) {
    categoryScores.problemSolving = parsed.scores.problemSolvingScore;
  }

  return {
    overallScore: extractOverallScore(markdown),
    categoryScores,
  };
}

/**
 * Convert parseFeedbackSummary result to InterviewMetric inputs.
 * @param summary - result from parseFeedbackSummary
 * @param interviewId - interview UUID (unused here but kept for signature parity)
 */
export function convertToInterviewMetrics(
  summary: ParsedFeedbackSummary,
  _interviewId: string
): InterviewMetricInput[] {
  // Re-parse to get section notes for feedback field
  // (caller typically provides feedbackText; we just need the notes)
  // For efficiency we assume caller can call parseFeedback separately if needed.
  // Here we provide a minimal conversion from categoryScores.
  const metrics: InterviewMetricInput[] = [];

  const categoryMeta: Record<string, { metricName: string; category: string }> = {
    content: { metricName: 'Content Quality', category: 'content' },
    communication: { metricName: 'Communication', category: 'communication' },
    confidence: { metricName: 'Confidence', category: 'confidence' },
    technical: { metricName: 'Technical Knowledge', category: 'technical' },
    problemSolving: { metricName: 'Problem Solving', category: 'problem_solving' },
  };

  for (const [key, score] of Object.entries(summary.categoryScores)) {
    const meta = categoryMeta[key];
    if (meta) {
      metrics.push({
        category: meta.category,
        metricName: meta.metricName,
        score,
        maxScore: 100,
      });
    }
  }

  return metrics;
}

export default {
  parseFeedback,
  parseScores,
  parseSections,
  scoresToMetrics,
  extractOverallScore,
  parseFeedbackSummary,
  convertToInterviewMetrics,
};
