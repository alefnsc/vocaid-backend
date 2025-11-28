import OpenAI from 'openai';

/**
 * Resume-Job Congruency Analyzer
 * 
 * Analyzes the match between a candidate's resume and a job description
 * to determine if the interview should proceed or end gracefully.
 */

export interface CongruencyAnalysis {
  isCongruent: boolean;
  confidence: number; // 0-1
  reasons: string[];
  recommendation: 'continue' | 'end_gracefully';
  isExtremelyIncompatible: boolean; // For immediate termination
  skillsMatch: {
    matched: string[];
    missing: string[];
    transferable: string[];
  };
}

export async function analyzeResumeJobCongruency(
  resume: string,
  jobTitle: string,
  jobDescription: string,
  openai: OpenAI,
  quickCheck: boolean = false
): Promise<CongruencyAnalysis> {
  try {
    // For quick check at start, use lighter analysis
    const analysisPrompt = quickCheck 
      ? `You are an expert recruiter performing a QUICK compatibility check.

JOB TITLE: ${jobTitle}

JOB DESCRIPTION (key requirements):
${jobDescription.substring(0, 600)}

CANDIDATE RESUME (summary):
${resume.substring(0, 1000)}

TASK: Quickly determine if this candidate is EXTREMELY INCOMPATIBLE with this role.

EXTREME INCOMPATIBILITY means:
- Completely different field (e.g., chef applying for software engineer)
- Zero overlap in skills or experience
- No transferable skills whatsoever

BE LENIENT: If there's ANY reasonable connection (similar industry, transferable skills, related education), mark as NOT extremely incompatible.

Respond with this exact JSON format:
{
  "isCongruent": true/false,
  "confidence": 0.0-1.0,
  "reasons": ["brief reason"],
  "recommendation": "continue" or "end_gracefully",
  "isExtremelyIncompatible": true/false,
  "skillsMatch": {
    "matched": ["skill1"],
    "missing": ["skill1"],
    "transferable": ["skill1"]
  }
}

Mark isExtremelyIncompatible=true ONLY if there is virtually NO overlap (less than 10% match).`
      : `You are an expert technical recruiter analyzing candidate-job fit.

JOB TITLE: ${jobTitle}

JOB DESCRIPTION:
${jobDescription}

CANDIDATE RESUME:
${resume}

ANALYSIS TASK:
Perform a thorough evaluation of how well this candidate matches the job requirements.

EVALUATE:
1. **Required Skills Match**: Which required skills does the candidate have?
2. **Experience Alignment**: Does their experience level match the role?
3. **Domain Knowledge**: Do they have relevant industry/domain experience?
4. **Transferable Skills**: What skills could transfer even if not exact match?
5. **Education/Certifications**: Do qualifications align?
6. **Red Flags**: Any concerning gaps or mismatches?

SCORING GUIDE:
- 70%+ match = Congruent (continue interview)
- 40-70% match = Borderline (continue with focus on gaps)
- Below 40% match = Not congruent (end gracefully)
- Below 15% match = Extremely incompatible (immediate end)

Respond with this exact JSON format:
{
  "isCongruent": true/false,
  "confidence": 0.0-1.0,
  "reasons": ["detailed reason 1", "detailed reason 2"],
  "recommendation": "continue" or "end_gracefully",
  "isExtremelyIncompatible": false,
  "skillsMatch": {
    "matched": ["skill1", "skill2"],
    "missing": ["skill1", "skill2"],
    "transferable": ["skill1", "skill2"]
  }
}`;

    const response = await openai.chat.completions.create({
      model: quickCheck ? 'gpt-4o-mini' : 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: 'You are a precise technical recruiter analyzing job-candidate fit. Always respond with valid JSON only. Be fair but thorough in your assessment.'
        },
        {
          role: 'user',
          content: analysisPrompt
        }
      ],
      temperature: 0.2,
      max_tokens: quickCheck ? 300 : 600,
      response_format: { type: 'json_object' }
    });

    const analysis = JSON.parse(response.choices[0].message.content || '{}');
    
    return {
      isCongruent: analysis.isCongruent ?? true,
      confidence: analysis.confidence ?? 0.5,
      reasons: analysis.reasons ?? [],
      recommendation: analysis.recommendation ?? 'continue',
      isExtremelyIncompatible: analysis.isExtremelyIncompatible ?? false,
      skillsMatch: {
        matched: analysis.skillsMatch?.matched ?? [],
        missing: analysis.skillsMatch?.missing ?? [],
        transferable: analysis.skillsMatch?.transferable ?? []
      }
    };
  } catch (error) {
    console.error('Error analyzing congruency:', error);
    // On error, default to continuing the interview
    return {
      isCongruent: true,
      confidence: 0.5,
      reasons: ['Unable to perform analysis, proceeding with interview'],
      recommendation: 'continue',
      isExtremelyIncompatible: false,
      skillsMatch: {
        matched: [],
        missing: [],
        transferable: []
      }
    };
  }
}

/**
 * Generate a graceful ending message when interview needs to be terminated
 */
export function generateGracefulEndingMessage(reasons: string[], isExtremelyIncompatible: boolean = false): string {
  if (isExtremelyIncompatible) {
    // Standardized message for extreme incompatibility - always the same for consistency
    return "Thank you for your interest in this position. After reviewing your background, I've identified that this role requires a significantly different skill set from your current experience. To respect your time and resources, we'll conclude this session here. Your interview credit will be restored automatically. I encourage you to explore positions that better align with your professional background. Best of luck in your job search!";
  }

  // Standardized message for moderate mismatch (not extreme, but still ending)
  return "Thank you for taking the time to speak with me today. Based on our conversation, it appears this particular role may not be the ideal match for your current experience level. I appreciate your interest and encourage you to explore other opportunities that might better align with your skills. Wishing you success in finding the right fit!";
}

/**
 * Check if enough time has passed to perform congruency check (after ~2 minutes)
 */
export function shouldCheckCongruency(
  startTime: Date,
  lastCheckTime: Date | null,
  conversationLength: number
): boolean {
  const now = new Date();
  const minutesSinceStart = (now.getTime() - startTime.getTime()) / 1000 / 60;
  
  // Check after 2-3 minutes of conversation
  if (minutesSinceStart < 2 || minutesSinceStart > 3) {
    return false;
  }
  
  // Only check once
  if (lastCheckTime !== null) {
    return false;
  }
  
  // Need at least 4 exchanges to have enough context
  if (conversationLength < 4) {
    return false;
  }
  
  return true;
}
