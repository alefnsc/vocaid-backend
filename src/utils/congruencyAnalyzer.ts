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
    // For quick check at start, use VERY lenient analysis
    const analysisPrompt = quickCheck 
      ? `You are an expert recruiter performing a QUICK compatibility check.

JOB TITLE: ${jobTitle}

JOB DESCRIPTION (key requirements):
${jobDescription.substring(0, 800)}

CANDIDATE RESUME:
${resume.substring(0, 1500)}

TASK: Determine if this candidate is EXTREMELY INCOMPATIBLE with this role.

CRITICAL - BE EXTREMELY LENIENT. Mark as incompatible ONLY if ALL of these are true:
1. The candidate has ZERO related experience (not even tangentially related)
2. There are NO transferable skills whatsoever
3. The fields are completely unrelated (e.g., professional chef applying for neurosurgeon)
4. No education or background could possibly apply

EXAMPLES OF COMPATIBLE (should NOT be marked incompatible):
- Software developer applying for different tech stack (transferable skills)
- Marketing person applying for sales (related fields)
- Junior applying for senior role (growth potential)
- Different industry but same function (transferable)
- Any tech role to any other tech role
- Any business role to any other business role

ONLY mark isExtremelyIncompatible=true for ABSURD mismatches like:
- Chef applying for Software Engineer with NO tech background
- Farmer applying for Investment Banker with NO finance background
- Lifeguard applying for Brain Surgeon with NO medical background

When in doubt, mark as COMPATIBLE and let the interview proceed.

Respond with this exact JSON format:
{
  "isCongruent": true,
  "confidence": 0.3,
  "reasons": ["brief reason"],
  "recommendation": "continue",
  "isExtremelyIncompatible": false,
  "skillsMatch": {
    "matched": ["skill1"],
    "missing": ["skill1"],
    "transferable": ["skill1"]
  }
}

DEFAULT TO isCongruent=true and isExtremelyIncompatible=false unless ABSURDLY incompatible.`
      : `You are an expert technical recruiter analyzing candidate-job fit.

JOB TITLE: ${jobTitle}

JOB DESCRIPTION:
${jobDescription}

CANDIDATE RESUME:
${resume}

ANALYSIS TASK:
Perform a fair evaluation of how well this candidate matches the job requirements.
Be encouraging and focus on potential, not just exact matches.

EVALUATE:
1. **Required Skills Match**: Which required skills does the candidate have or could quickly learn?
2. **Experience Alignment**: Does their experience level match or show growth trajectory?
3. **Domain Knowledge**: Do they have relevant industry/domain experience or related experience?
4. **Transferable Skills**: What skills could transfer even if not exact match?
5. **Education/Certifications**: Do qualifications align or show capability?
6. **Growth Potential**: Could this candidate succeed with some ramp-up time?

SCORING GUIDE (BE LENIENT):
- 50%+ match = Congruent (continue interview)
- 30-50% match = Borderline (continue with focus on gaps)
- Below 30% match = Not congruent (end gracefully)
- Below 10% match = Extremely incompatible (immediate end - VERY RARE)

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
          content: 'You are a fair and encouraging recruiter. Your job is to give candidates a chance. Only reject candidates for EXTREME mismatches. When in doubt, let them interview. Always respond with valid JSON only.'
        },
        {
          role: 'user',
          content: analysisPrompt
        }
      ],
      temperature: 0.1, // Very low temperature for consistent, conservative results
      max_tokens: quickCheck ? 400 : 700,
      response_format: { type: 'json_object' }
    });

    const analysis = JSON.parse(response.choices[0].message.content || '{}');
    
    // Additional safety: Override extremely incompatible if confidence is not very high
    const isExtremelyIncompatible = analysis.isExtremelyIncompatible === true && 
                                     (analysis.confidence || 0) > 0.9;
    
    return {
      isCongruent: analysis.isCongruent ?? true,
      confidence: analysis.confidence ?? 0.5,
      reasons: analysis.reasons ?? [],
      recommendation: analysis.recommendation ?? 'continue',
      isExtremelyIncompatible: isExtremelyIncompatible,
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
