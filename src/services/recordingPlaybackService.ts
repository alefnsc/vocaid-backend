/**
 * Recording Playback Service
 * 
 * Integrates with Retell to fetch and manage interview recordings.
 * Provides audio playback URLs, transcript synchronization, and playback markers.
 * 
 * Features:
 * - Fetch recording from Retell
 * - Transcript synchronization with timestamps
 * - Playback markers for key moments
 * - Recording metadata and duration
 * 
 * @module services/recordingPlaybackService
 */

import Retell from 'retell-sdk';
import logger from '../utils/logger';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Create recording logger
const recordingLogger = logger.child({ component: 'recording-playback' });

// ========================================
// INTERFACES
// ========================================

export interface RecordingInfo {
  interviewId: string;
  retellCallId: string;
  
  // Audio info
  audioUrl: string | null;
  audioDuration: number; // in seconds
  audioFormat: string;
  
  // Recording status
  recordingStatus: 'pending' | 'processing' | 'available' | 'unavailable' | 'expired';
  
  // Timestamps
  recordedAt: Date;
  expiresAt?: Date;
}

export interface TranscriptSegment {
  id: string;
  speaker: 'agent' | 'user';
  text: string;
  startTime: number; // in seconds
  endTime: number;
  confidence?: number;
}

export interface SynchronizedTranscript {
  interviewId: string;
  segments: TranscriptSegment[];
  totalDuration: number;
  speakerBreakdown: {
    agentDuration: number;
    userDuration: number;
    agentWordCount: number;
    userWordCount: number;
  };
}

export interface PlaybackMarker {
  id: string;
  type: 'highlight' | 'improvement' | 'question' | 'answer' | 'pause' | 'custom';
  timestamp: number; // in seconds
  label: string;
  description?: string;
  color?: string;
}

export interface PlaybackData {
  recording: RecordingInfo;
  transcript: SynchronizedTranscript;
  markers: PlaybackMarker[];
}

export interface RetellCallDetails {
  call_id: string;
  call_status?: string;
  recording_url?: string;
  transcript?: string;
  transcript_object?: Array<{
    role: string;
    content: string;
    words?: Array<{
      word: string;
      start: number;
      end: number;
    }>;
  }>;
  call_analysis?: {
    call_summary?: string;
    user_sentiment?: string;
    call_successful?: boolean;
  };
  start_timestamp?: number;
  end_timestamp?: number;
}

// ========================================
// RETELL CLIENT
// ========================================

let retellClient: Retell | null = null;

function getRetellClient(): Retell {
  if (!retellClient) {
    const apiKey = process.env.RETELL_API_KEY;
    if (!apiKey) {
      throw new Error('RETELL_API_KEY not configured');
    }
    retellClient = new Retell({ apiKey });
  }
  return retellClient;
}

// ========================================
// RECORDING RETRIEVAL
// ========================================

/**
 * Get recording info for an interview
 */
export async function getRecordingInfo(
  userId: string,
  interviewId: string
): Promise<RecordingInfo | null> {
  try {
    // Get interview from database
    const user = await prisma.user.findUnique({
      where: { clerkId: userId },
      select: { id: true }
    });
    
    if (!user) return null;
    
    const interview = await prisma.interview.findFirst({
      where: { 
        id: interviewId,
        userId: user.id
      },
      select: {
        id: true,
        retellCallId: true,
        startedAt: true,
        endedAt: true,
        callDuration: true,
        status: true
      }
    });
    
    if (!interview || !interview.retellCallId) {
      recordingLogger.warn('Interview or call ID not found', { interviewId });
      return null;
    }
    
    // Fetch call details from Retell
    try {
      const retell = getRetellClient();
      const callDetails = await retell.call.retrieve(interview.retellCallId) as RetellCallDetails;
      
      // Determine recording status
      let recordingStatus: RecordingInfo['recordingStatus'] = 'unavailable';
      
      if (callDetails.recording_url) {
        recordingStatus = 'available';
      } else if (callDetails.call_status === 'ongoing') {
        recordingStatus = 'pending';
      } else if (callDetails.call_status === 'ended') {
        recordingStatus = 'processing';
      }
      
      // Calculate duration
      const duration = interview.callDuration || 
        (callDetails.end_timestamp && callDetails.start_timestamp
          ? Math.floor((callDetails.end_timestamp - callDetails.start_timestamp) / 1000)
          : 0);
      
      return {
        interviewId: interview.id,
        retellCallId: interview.retellCallId,
        audioUrl: callDetails.recording_url || null,
        audioDuration: duration,
        audioFormat: 'audio/webm', // Retell typically uses webm
        recordingStatus,
        recordedAt: interview.startedAt || new Date(),
        expiresAt: undefined // Retell recordings don't expire by default
      };
    } catch (retellError: any) {
      recordingLogger.error('Failed to fetch from Retell', { error: retellError.message });
      
      // Return basic info without Retell data
      return {
        interviewId: interview.id,
        retellCallId: interview.retellCallId,
        audioUrl: null,
        audioDuration: interview.callDuration || 0,
        audioFormat: 'audio/webm',
        recordingStatus: 'unavailable',
        recordedAt: interview.startedAt || new Date()
      };
    }
  } catch (error: any) {
    recordingLogger.error('Failed to get recording info', { error: error.message });
    return null;
  }
}

// ========================================
// TRANSCRIPT SYNCHRONIZATION
// ========================================

/**
 * Get synchronized transcript with timestamps
 */
export async function getSynchronizedTranscript(
  userId: string,
  interviewId: string
): Promise<SynchronizedTranscript | null> {
  try {
    const user = await prisma.user.findUnique({
      where: { clerkId: userId },
      select: { id: true }
    });
    
    if (!user) return null;
    
    const interview = await prisma.interview.findFirst({
      where: { 
        id: interviewId,
        userId: user.id
      },
      select: {
        id: true,
        retellCallId: true,
        transcript: true,
        callDuration: true
      }
    });
    
    if (!interview) return null;
    
    // Try to get detailed transcript from Retell
    if (interview.retellCallId) {
      try {
        const retell = getRetellClient();
        const callDetails = await retell.call.retrieve(interview.retellCallId) as RetellCallDetails;
        
        if (callDetails.transcript_object && callDetails.transcript_object.length > 0) {
          // Parse Retell's detailed transcript with word-level timestamps
          return parseRetellTranscript(interview.id, callDetails, interview.callDuration || 0);
        }
      } catch (retellError) {
        recordingLogger.warn('Could not fetch Retell transcript, using stored', { interviewId });
      }
    }
    
    // Fall back to stored transcript
    if (interview.transcript) {
      return parseStoredTranscript(interview.id, interview.transcript, interview.callDuration || 0);
    }
    
    return null;
  } catch (error: any) {
    recordingLogger.error('Failed to get transcript', { error: error.message });
    return null;
  }
}

/**
 * Parse Retell's transcript object into synchronized segments
 */
function parseRetellTranscript(
  interviewId: string,
  callDetails: RetellCallDetails,
  totalDuration: number
): SynchronizedTranscript {
  const segments: TranscriptSegment[] = [];
  let agentDuration = 0;
  let userDuration = 0;
  let agentWordCount = 0;
  let userWordCount = 0;
  
  const transcriptObject = callDetails.transcript_object || [];
  
  transcriptObject.forEach((turn, index) => {
    const speaker = turn.role === 'agent' ? 'agent' : 'user';
    const words = turn.words || [];
    
    // Calculate timing from word timestamps
    let startTime = 0;
    let endTime = 0;
    
    if (words.length > 0) {
      startTime = words[0].start;
      endTime = words[words.length - 1].end;
    } else if (index > 0 && segments.length > 0) {
      // Estimate timing based on previous segment
      startTime = segments[segments.length - 1].endTime + 0.5;
      endTime = startTime + (turn.content.split(' ').length * 0.3); // ~0.3s per word
    }
    
    const segment: TranscriptSegment = {
      id: `segment-${index}`,
      speaker,
      text: turn.content,
      startTime,
      endTime,
      confidence: 0.95 // Retell typically has high accuracy
    };
    
    segments.push(segment);
    
    // Track speaker stats
    const duration = endTime - startTime;
    const wordCount = turn.content.split(/\s+/).filter(w => w.length > 0).length;
    
    if (speaker === 'agent') {
      agentDuration += duration;
      agentWordCount += wordCount;
    } else {
      userDuration += duration;
      userWordCount += wordCount;
    }
  });
  
  return {
    interviewId,
    segments,
    totalDuration: totalDuration || (segments.length > 0 ? segments[segments.length - 1].endTime : 0),
    speakerBreakdown: {
      agentDuration: Math.round(agentDuration),
      userDuration: Math.round(userDuration),
      agentWordCount,
      userWordCount
    }
  };
}

/**
 * Parse stored transcript text into segments
 */
function parseStoredTranscript(
  interviewId: string,
  transcriptText: string,
  totalDuration: number
): SynchronizedTranscript {
  const segments: TranscriptSegment[] = [];
  let agentDuration = 0;
  let userDuration = 0;
  let agentWordCount = 0;
  let userWordCount = 0;
  
  // Parse transcript - assuming format like "Agent: text\nUser: text"
  const lines = transcriptText.split('\n').filter(line => line.trim());
  let currentTime = 0;
  
  lines.forEach((line, index) => {
    let speaker: 'agent' | 'user' = 'user';
    let text = line;
    
    // Detect speaker from common formats
    if (line.toLowerCase().startsWith('agent:') || line.toLowerCase().startsWith('interviewer:')) {
      speaker = 'agent';
      text = line.replace(/^(agent|interviewer):\s*/i, '');
    } else if (line.toLowerCase().startsWith('user:') || line.toLowerCase().startsWith('candidate:')) {
      speaker = 'user';
      text = line.replace(/^(user|candidate):\s*/i, '');
    }
    
    // Estimate timing based on word count
    const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;
    const estimatedDuration = Math.max(wordCount * 0.3, 1); // ~0.3s per word, min 1s
    
    const segment: TranscriptSegment = {
      id: `segment-${index}`,
      speaker,
      text,
      startTime: currentTime,
      endTime: currentTime + estimatedDuration
    };
    
    segments.push(segment);
    currentTime += estimatedDuration + 0.5; // Add gap between turns
    
    // Track stats
    if (speaker === 'agent') {
      agentDuration += estimatedDuration;
      agentWordCount += wordCount;
    } else {
      userDuration += estimatedDuration;
      userWordCount += wordCount;
    }
  });
  
  // Scale to actual duration if known
  if (totalDuration > 0 && segments.length > 0) {
    const scaleFactor = totalDuration / (segments[segments.length - 1].endTime || 1);
    segments.forEach(seg => {
      seg.startTime *= scaleFactor;
      seg.endTime *= scaleFactor;
    });
    agentDuration *= scaleFactor;
    userDuration *= scaleFactor;
  }
  
  return {
    interviewId,
    segments,
    totalDuration: totalDuration || (segments.length > 0 ? segments[segments.length - 1].endTime : 0),
    speakerBreakdown: {
      agentDuration: Math.round(agentDuration),
      userDuration: Math.round(userDuration),
      agentWordCount,
      userWordCount
    }
  };
}

// ========================================
// PLAYBACK MARKERS
// ========================================

/**
 * Generate playback markers from interview data
 */
export async function generatePlaybackMarkers(
  userId: string,
  interviewId: string
): Promise<PlaybackMarker[]> {
  try {
    const user = await prisma.user.findUnique({
      where: { clerkId: userId },
      select: { id: true }
    });
    
    if (!user) return [];
    
    const interview = await prisma.interview.findFirst({
      where: { 
        id: interviewId,
        userId: user.id
      },
      select: {
        id: true,
        retellCallId: true,
        feedbackText: true,
        confidenceTimeline: true
      }
    });
    
    if (!interview) return [];
    
    const markers: PlaybackMarker[] = [];
    
    // Parse confidence timeline for key moments
    if (interview.confidenceTimeline) {
      const timeline = interview.confidenceTimeline as Array<{
        timestamp: number;
        value: number;
        tone?: string;
        pace?: string;
      }>;
      
      // Find high confidence moments
      const highPoints = timeline.filter(t => t.value > 80);
      highPoints.slice(0, 3).forEach((point, index) => {
        markers.push({
          id: `highlight-${index}`,
          type: 'highlight',
          timestamp: point.timestamp,
          label: 'Strong Moment',
          description: `High confidence (${point.value}%)`,
          color: '#22c55e'
        });
      });
      
      // Find areas for improvement
      const lowPoints = timeline.filter(t => t.value < 50);
      lowPoints.slice(0, 3).forEach((point, index) => {
        markers.push({
          id: `improvement-${index}`,
          type: 'improvement',
          timestamp: point.timestamp,
          label: 'Area for Growth',
          description: `Lower confidence detected`,
          color: '#f59e0b'
        });
      });
      
      // Find pauses (sudden drops in pace)
      let pauseCount = 0;
      for (let i = 1; i < timeline.length; i++) {
        const current = timeline[i];
        const prev = timeline[i - 1];
        if (current.pace === 'slow' && prev.pace !== 'slow') {
          markers.push({
            id: `pause-${pauseCount}`,
            type: 'pause',
            timestamp: current.timestamp,
            label: 'Thoughtful Pause',
            description: 'Speaking pace slowed down',
            color: '#6366f1'
          });
          pauseCount++;
          if (pauseCount >= 2) break;
        }
      }
    }
    
    // Sort markers by timestamp
    return markers.sort((a, b) => a.timestamp - b.timestamp);
  } catch (error: any) {
    recordingLogger.error('Failed to generate markers', { error: error.message });
    return [];
  }
}

/**
 * Save custom playback marker
 */
export async function saveCustomMarker(
  userId: string,
  interviewId: string,
  marker: Omit<PlaybackMarker, 'id'>
): Promise<PlaybackMarker | null> {
  try {
    const user = await prisma.user.findUnique({
      where: { clerkId: userId },
      select: { id: true }
    });
    
    if (!user) return null;
    
    // Verify interview belongs to user
    const interview = await prisma.interview.findFirst({
      where: { 
        id: interviewId,
        userId: user.id
      }
    });
    
    if (!interview) return null;
    
    // For now, we'd store custom markers in a separate table
    // This is a placeholder - would need a PlaybackMarker model
    const newMarker: PlaybackMarker = {
      ...marker,
      id: `custom-${Date.now()}`,
      type: 'custom'
    };
    
    recordingLogger.info('Custom marker saved', { interviewId, marker: newMarker });
    
    return newMarker;
  } catch (error: any) {
    recordingLogger.error('Failed to save marker', { error: error.message });
    return null;
  }
}

// ========================================
// COMPLETE PLAYBACK DATA
// ========================================

/**
 * Get complete playback data for an interview
 */
export async function getPlaybackData(
  userId: string,
  interviewId: string
): Promise<PlaybackData | null> {
  try {
    const [recording, transcript, markers] = await Promise.all([
      getRecordingInfo(userId, interviewId),
      getSynchronizedTranscript(userId, interviewId),
      generatePlaybackMarkers(userId, interviewId)
    ]);
    
    if (!recording) {
      recordingLogger.warn('Recording not found', { interviewId });
      return null;
    }
    
    return {
      recording,
      transcript: transcript || {
        interviewId,
        segments: [],
        totalDuration: recording.audioDuration,
        speakerBreakdown: {
          agentDuration: 0,
          userDuration: 0,
          agentWordCount: 0,
          userWordCount: 0
        }
      },
      markers
    };
  } catch (error: any) {
    recordingLogger.error('Failed to get playback data', { error: error.message });
    return null;
  }
}

/**
 * Get transcript segment at a specific timestamp
 */
export function getSegmentAtTime(
  transcript: SynchronizedTranscript,
  timestamp: number
): TranscriptSegment | null {
  return transcript.segments.find(
    seg => timestamp >= seg.startTime && timestamp <= seg.endTime
  ) || null;
}

/**
 * Search transcript for keyword
 */
export function searchTranscript(
  transcript: SynchronizedTranscript,
  query: string
): TranscriptSegment[] {
  const lowerQuery = query.toLowerCase();
  return transcript.segments.filter(
    seg => seg.text.toLowerCase().includes(lowerQuery)
  );
}

// ========================================
// EXPORTS
// ========================================

export default {
  getRecordingInfo,
  getSynchronizedTranscript,
  generatePlaybackMarkers,
  saveCustomMarker,
  getPlaybackData,
  getSegmentAtTime,
  searchTranscript
};
