/**
 * Transcript Adapter
 * Normalizes various transcript sources (Retell API, plain text) into
 * a unified segment shape with millisecond-based timing for persistence.
 */

// ========================================
// TYPES
// ========================================

/**
 * Unified transcript segment with millisecond timing
 */
export interface NormalizedTranscriptSegment {
  speaker: 'agent' | 'user';
  content: string;
  startMs: number;
  endMs: number;
  sentimentScore?: number;
  segmentIndex: number;
}

/**
 * Result from transcript normalization
 */
export interface TranscriptNormalizationResult {
  segments: NormalizedTranscriptSegment[];
  totalDurationMs: number;
  source: 'retell_structured' | 'retell_text' | 'plain_text';
}

/**
 * Retell word timing structure
 */
interface RetellWord {
  word: string;
  start: number; // seconds
  end: number;   // seconds
}

/**
 * Retell transcript segment from transcript_with_tool_calls
 */
interface RetellTranscriptSegment {
  role: 'agent' | 'user' | 'tool_calls';
  content: string;
  words?: RetellWord[];
  sentiment?: string;
}

/**
 * Retell call details structure (partial)
 */
interface RetellCallDetails {
  transcript_with_tool_calls?: RetellTranscriptSegment[];
  transcript?: string;
  transcript_object?: Array<{
    role: string;
    content: string;
    words?: RetellWord[];
  }>;
  start_timestamp?: number;
  end_timestamp?: number;
  call_duration_ms?: number;
}

// ========================================
// ADAPTER FUNCTIONS
// ========================================

/**
 * Normalize Retell call details into unified segment shape
 * Prioritizes structured transcript_with_tool_calls, falls back to transcript_object, then plain text
 */
export function normalizeRetellTranscript(
  callDetails: RetellCallDetails
): TranscriptNormalizationResult {
  // Calculate total duration from Retell timestamps (in ms)
  const totalDurationMs = callDetails.call_duration_ms ??
    (callDetails.end_timestamp && callDetails.start_timestamp
      ? callDetails.end_timestamp - callDetails.start_timestamp
      : 0);

  // Try structured transcript first (most accurate)
  if (callDetails.transcript_with_tool_calls?.length) {
    return normalizeStructuredTranscript(callDetails.transcript_with_tool_calls, totalDurationMs);
  }

  // Fall back to transcript_object (older format)
  if (callDetails.transcript_object?.length) {
    return normalizeTranscriptObject(callDetails.transcript_object, totalDurationMs);
  }

  // Fall back to plain text transcript
  if (callDetails.transcript) {
    return normalizePlainTextTranscript(callDetails.transcript, totalDurationMs);
  }

  // No transcript available
  return {
    segments: [],
    totalDurationMs,
    source: 'plain_text',
  };
}

/**
 * Normalize structured transcript_with_tool_calls
 */
function normalizeStructuredTranscript(
  rawSegments: RetellTranscriptSegment[],
  totalDurationMs: number
): TranscriptNormalizationResult {
  const segments: NormalizedTranscriptSegment[] = [];
  let segmentIndex = 0;
  let lastEndMs = 0;

  for (const seg of rawSegments) {
    // Skip tool calls
    if (seg.role === 'tool_calls') continue;

    const speaker = seg.role === 'agent' ? 'agent' : 'user';

    // Calculate timing from word timestamps (convert seconds to ms)
    let startMs: number;
    let endMs: number;

    if (seg.words?.length) {
      startMs = Math.round(seg.words[0].start * 1000);
      endMs = Math.round(seg.words[seg.words.length - 1].end * 1000);
    } else {
      // Estimate timing if no word data available
      const estimatedDurationMs = Math.max(seg.content.split(/\s+/).length * 300, 1000);
      startMs = lastEndMs + 500; // 500ms gap between turns
      endMs = startMs + estimatedDurationMs;
    }

    segments.push({
      speaker,
      content: seg.content || '',
      startMs,
      endMs,
      sentimentScore: seg.sentiment ? mapSentimentToScore(seg.sentiment) : undefined,
      segmentIndex,
    });

    lastEndMs = endMs;
    segmentIndex++;
  }

  return {
    segments,
    totalDurationMs: totalDurationMs || lastEndMs,
    source: 'retell_structured',
  };
}

/**
 * Normalize transcript_object format (older Retell format)
 */
function normalizeTranscriptObject(
  transcriptObject: Array<{ role: string; content: string; words?: RetellWord[] }>,
  totalDurationMs: number
): TranscriptNormalizationResult {
  const segments: NormalizedTranscriptSegment[] = [];
  let lastEndMs = 0;

  transcriptObject.forEach((turn, index) => {
    const speaker = turn.role === 'agent' ? 'agent' : 'user';

    let startMs: number;
    let endMs: number;

    if (turn.words?.length) {
      startMs = Math.round(turn.words[0].start * 1000);
      endMs = Math.round(turn.words[turn.words.length - 1].end * 1000);
    } else {
      const estimatedDurationMs = Math.max(turn.content.split(/\s+/).length * 300, 1000);
      startMs = lastEndMs + 500;
      endMs = startMs + estimatedDurationMs;
    }

    segments.push({
      speaker,
      content: turn.content || '',
      startMs,
      endMs,
      segmentIndex: index,
    });

    lastEndMs = endMs;
  });

  return {
    segments,
    totalDurationMs: totalDurationMs || lastEndMs,
    source: 'retell_structured',
  };
}

/**
 * Normalize plain text transcript
 * Expected formats:
 * - "Agent: text" / "Interviewer: text"
 * - "User: text" / "Candidate: text"
 */
export function normalizePlainTextTranscript(
  text: string,
  totalDurationMs: number = 0
): TranscriptNormalizationResult {
  const segments: NormalizedTranscriptSegment[] = [];
  const lines = text.split('\n').filter((line) => line.trim());

  let currentTimeMs = 0;
  const avgWordsPerMinute = 150;
  const msPerWord = 60000 / avgWordsPerMinute; // ~400ms per word

  lines.forEach((line, index) => {
    let speaker: 'agent' | 'user' = 'user';
    let content = line;

    // Detect speaker from common formats
    if (/^(agent|interviewer):/i.test(line)) {
      speaker = 'agent';
      content = line.replace(/^(agent|interviewer):\s*/i, '');
    } else if (/^(user|candidate):/i.test(line)) {
      speaker = 'user';
      content = line.replace(/^(user|candidate):\s*/i, '');
    }

    if (!content.trim()) return;

    const wordCount = content.split(/\s+/).filter(Boolean).length;
    const segmentDurationMs = Math.max(wordCount * msPerWord, 1000);

    segments.push({
      speaker,
      content: content.trim(),
      startMs: currentTimeMs,
      endMs: currentTimeMs + segmentDurationMs,
      segmentIndex: index,
    });

    currentTimeMs += segmentDurationMs + 500; // 500ms gap between turns
  });

  // Scale to actual duration if provided
  if (totalDurationMs > 0 && segments.length > 0) {
    const estimatedTotalMs = segments[segments.length - 1].endMs;
    const scaleFactor = totalDurationMs / estimatedTotalMs;

    segments.forEach((seg) => {
      seg.startMs = Math.round(seg.startMs * scaleFactor);
      seg.endMs = Math.round(seg.endMs * scaleFactor);
    });
  }

  return {
    segments,
    totalDurationMs: totalDurationMs || (segments.length > 0 ? segments[segments.length - 1].endMs : 0),
    source: 'plain_text',
  };
}

// ========================================
// HELPERS
// ========================================

/**
 * Map sentiment string to numeric score (0-1)
 */
function mapSentimentToScore(sentiment: string): number {
  const lower = sentiment.toLowerCase();
  if (lower.includes('positive') || lower.includes('good')) return 0.8;
  if (lower.includes('negative') || lower.includes('bad')) return 0.2;
  if (lower.includes('neutral')) return 0.5;
  return 0.5;
}

/**
 * Convert ms to seconds for frontend display (TranscriptViewer uses seconds)
 */
export function msToSeconds(ms: number): number {
  return ms / 1000;
}

/**
 * Convert seconds to ms
 */
export function secondsToMs(seconds: number): number {
  return Math.round(seconds * 1000);
}

/**
 * Format milliseconds to MM:SS string
 */
export function formatDurationMs(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
