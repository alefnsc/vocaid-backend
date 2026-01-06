import WebSocket from 'ws';
import OpenAI from 'openai';
import { getFieldPrompt, formatInitialMessage } from '../prompts/fieldPrompts';
import { 
  generateMultilingualSystemPrompt, 
  generateInitialGreeting,
  getLanguageSpecificPhrases,
  generateInterviewAlignedPrompt
} from '../prompts/multilingualPrompts';
import { 
  analyzeResumeJobCongruency, 
  generateGracefulEndingMessage,
  shouldCheckCongruency,
  CongruencyAnalysis
} from '../utils/congruencyAnalyzer';
import { InterviewTimer } from '../utils/interviewTimer';
import { wsLogger } from '../utils/logger';
import { SupportedLanguageCode, isValidLanguageCode, getLanguageConfig } from '../types/multilingual';
import { getCallContext } from './callContextService';
import { 
  createInterviewSession,
  recordFirstAgentUtterance,
  updateSessionTokens,
  finalizeSession,
  incrementClarificationTurns,
  type CreateSessionParams,
  type FinalizeSessionParams,
} from './interviewSessionService';
import postCallProcessingService from './postCallProcessingService';

/**
 * Retell Custom LLM WebSocket Handler
 * Based on: https://github.com/RetellAI/retell-custom-llm-node-demo
 * 
 * IMPORTANT: Must handle these interaction_types:
 * - call_details: Initial call setup (replaces call_started in newer API)
 * - update_only: Transcript update, no response needed
 * - response_required: User finished speaking, response required
 * - reminder_required: User hasn't spoken in a while
 * - ping_pong: Keep-alive ping from Retell
 */

interface CustomLLMRequest {
  interaction_type: 'call_details' | 'call_started' | 'update_only' | 'response_required' | 'reminder_required' | 'ping_pong';
  call_id?: string;
  call?: {
    call_id: string;
    from_number?: string;
    to_number?: string;
    metadata?: Record<string, any>;
    retell_llm_dynamic_variables?: Record<string, any>;
  };
  response_id?: number; // Retell sends this - we must echo it back
  transcript: Array<{
    role: 'agent' | 'user';
    content: string;
    timestamp: number;
  }>;
  metadata?: {
    first_name: string;
    last_name?: string;
    job_title: string;
    company_name: string;
    job_description: string;
    interviewee_cv: string; // Base64 encoded resume content
    resume_file_name?: string;
    resume_mime_type?: string;
    interview_id?: string;
    preferred_language?: string; // User's preferred language (e.g., 'en-US', 'pt-BR', 'es-ES')
  };
  // Retell LLM dynamic variables passed during call
  retell_llm_dynamic_variables?: {
    first_name?: string;
    job_title?: string;
    company_name?: string;
    job_description?: string;
    interviewee_cv?: string;
    preferred_language?: string; // User's preferred language
  };
}

interface CustomLLMResponse {
  response_type: 'config' | 'response' | 'agent_interrupt';
  response_id?: number;
  content?: string;
  content_complete?: boolean;
  end_call?: boolean;
  end_call_after_spoken?: boolean;
  no_interruption_allowed?: boolean;
  end_call_reason?: string; // 'incompatibility' | 'time_exceeded' | 'user_request' etc.
  config?: {
    auto_reconnect?: boolean;
    call_details?: boolean;
  };
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// Constants for performance optimization
const MAX_CONVERSATION_HISTORY = 20; // Limit to prevent memory bloat
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 500;

export class CustomLLMWebSocketHandler {
  private ws: WebSocket;
  private openai: OpenAI;
  private conversationHistory: ChatMessage[] = [];
  private systemPrompt: string = '';
  private responseId: number = 0;
  private callId: string = '';
  private interviewTimer: InterviewTimer;
  private congruencyChecked: boolean = false;
  private shouldEndInterview: boolean = false;
  private isExtremelyIncompatible: boolean = false;
  private metadata: any = null;
  private hasGreeted: boolean = false; // Track if we've sent initial greeting
  private reminderCount: number = 0; // Track how many reminders we've sent
  private readonly MAX_REMINDERS = 2; // After this many reminders, end call gracefully
  private isProcessing: boolean = false; // Prevent concurrent processing
  
  // Metrics tracking
  private sessionId: string | null = null; // InterviewSession ID for metrics
  private totalPromptTokens: number = 0;
  private totalCompletionTokens: number = 0;
  private turnCount: number = 0;
  private clarificationCount: number = 0;
  private callStartTime: Date | null = null;
  private firstUtteranceSent: boolean = false;

  constructor(ws: WebSocket, openai: OpenAI, callId?: string) {
    this.ws = ws;
    this.openai = openai;
    this.callId = callId || '';
    this.callStartTime = new Date(); // Record call start for metrics
    this.interviewTimer = new InterviewTimer(
      parseInt(process.env.MAX_INTERVIEW_DURATION_MINUTES || '15')
    );
    wsLogger.info('CustomLLMWebSocketHandler created', { 
      callId: this.callId
    });
    
    // Send initial config response when WebSocket opens
    // This tells Retell we want to receive call_details
    this.sendConfig();
  }

  /**
   * Send initial config response to Retell
   * This must be sent first when WebSocket connects
   */
  private sendConfig() {
    const configResponse: CustomLLMResponse = {
      response_type: 'config',
      config: {
        auto_reconnect: true,
        call_details: true // Request call details
      }
    };
    
    wsLogger.debug('Sending initial config', { callId: this.callId });
    this.ws.send(JSON.stringify(configResponse));
  }

  /**
   * Handle incoming messages from Retell
   */
  async handleMessage(data: string) {
    try {
      const request: CustomLLMRequest = JSON.parse(data);
      
      // Use call_id from request or nested call object if not set
      if (!this.callId) {
        this.callId = request.call_id || request.call?.call_id || '';
      }

      wsLogger.debug('Retell message received', {
        callId: this.callId,
        interactionType: request.interaction_type,
        responseId: request.response_id,
        transcriptLength: request.transcript?.length || 0,
        hasMetadata: !!(request.metadata || request.retell_llm_dynamic_variables || request.call?.metadata)
      });

      switch (request.interaction_type) {
        case 'call_details':
          // New API - call_details replaces call_started
          wsLogger.info('CALL_DETAILS event received', { callId: this.callId });
          await this.handleCallDetails(request);
          break;
          
        case 'call_started':
          // Legacy API support
          wsLogger.info('CALL_STARTED event received (legacy)', { callId: this.callId });
          await this.handleCallStarted(request);
          break;
        
        case 'response_required':
          await this.handleResponseRequired(request);
          break;
        
        case 'reminder_required':
          await this.handleReminderRequired(request);
          break;
        
        case 'update_only':
          wsLogger.debug('Update only - no response needed', { callId: this.callId });
          break;
          
        case 'ping_pong':
          // Must respond to ping to keep connection alive
          this.handlePingPong();
          break;
          
        default:
          wsLogger.warn('Unknown interaction type', { 
            callId: this.callId, 
            type: (request as any).interaction_type 
          });
      }
    } catch (error: any) {
      wsLogger.error('Error handling Retell message', { 
        callId: this.callId, 
        error: error.message,
        stack: error.stack 
      });
    }
  }

  /**
   * Handle ping_pong to keep connection alive
   */
  private handlePingPong() {
    const pongResponse = {
      response_type: 'ping_pong',
      timestamp: Date.now()
    };
    wsLogger.debug('Responding to ping_pong', { callId: this.callId });
    this.ws.send(JSON.stringify(pongResponse));
  }

  /**
   * Handle call_details event (newer API - replaces call_started)
   * 
   * IMPORTANT: Retell may not forward all custom metadata fields to the Custom LLM.
   * We use the CallContext service to retrieve stored context (especially preferred_language)
   * that was saved when the call was registered via /register-call.
   */
  private async handleCallDetails(request: CustomLLMRequest) {
    // Extract metadata from various possible locations (Retell sends it differently)
    const retellMetadata = request.metadata || 
                           request.retell_llm_dynamic_variables || 
                           request.call?.metadata ||
                           request.call?.retell_llm_dynamic_variables ||
                           {};
    
    // Get stored CallContext (contains preferred_language reliably)
    const callId = request.call?.call_id || request.call_id || this.callId;
    const storedContext = getCallContext(callId);
    
    wsLogger.info('Call details received - merging contexts', {
      callId,
      retellMetadataLanguage: retellMetadata.preferred_language,
      storedContextLanguage: storedContext?.preferredLanguage,
      candidate: retellMetadata.first_name || storedContext?.candidateName || 'Unknown',
      position: retellMetadata.job_title || storedContext?.jobTitle || 'Unknown',
      company: retellMetadata.company_name || storedContext?.companyName || 'Unknown',
      hasCV: !!retellMetadata.interviewee_cv || !!storedContext?.intervieweeCV,
      hasStoredContext: !!storedContext,
    });
    
    // Merge metadata: prioritize stored context for language (since Retell may not forward it)
    this.metadata = {
      ...retellMetadata,
      // Use stored context as authoritative source for language
      preferred_language: storedContext?.preferredLanguage || retellMetadata.preferred_language || 'en-US',
      // Fill in any missing fields from stored context
      first_name: retellMetadata.first_name || storedContext?.candidateName?.split(' ')[0],
      job_title: retellMetadata.job_title || storedContext?.jobTitle,
      company_name: retellMetadata.company_name || storedContext?.companyName,
      job_description: retellMetadata.job_description || storedContext?.jobDescription,
      interviewee_cv: retellMetadata.interviewee_cv || storedContext?.intervieweeCV,
    };
    
    wsLogger.info('Merged metadata for interview', {
      callId,
      finalLanguage: this.metadata.preferred_language,
      candidate: this.metadata.first_name,
      position: this.metadata.job_title,
    });

    // Proceed to start the interview (same logic as handleCallStarted)
    await this.startInterview();
  }

  /**
   * Handle call started event (legacy API)
   * Also uses CallContext for language reliability
   */
  private async handleCallStarted(request: CustomLLMRequest) {
    const callId = request.call_id || this.callId;
    const storedContext = getCallContext(callId);
    
    wsLogger.info('Call session started (legacy)', {
      callId,
      storedContextLanguage: storedContext?.preferredLanguage,
      candidate: request.metadata?.first_name || storedContext?.candidateName || 'Unknown',
      position: request.metadata?.job_title || storedContext?.jobTitle || 'Unknown',
      company: request.metadata?.company_name || storedContext?.companyName || 'Unknown'
    });
    
    // Merge metadata with stored context
    this.metadata = {
      ...request.metadata,
      preferred_language: storedContext?.preferredLanguage || request.metadata?.preferred_language || 'en-US',
      first_name: request.metadata?.first_name || storedContext?.candidateName?.split(' ')[0],
      job_title: request.metadata?.job_title || storedContext?.jobTitle,
      company_name: request.metadata?.company_name || storedContext?.companyName,
    };

    // Start the interview
    await this.startInterview();
  }

  /**
   * Start the interview - shared logic for call_details and call_started
   * 
   * Supports multilingual interviews by:
   * 1. Detecting preferred_language from metadata
   * 2. Generating language-specific system prompts
   * 3. Using localized greetings and transitions
   * 4. Creating InterviewSession for metrics tracking
   */
  private async startInterview() {
    // OPTIMIZATION: Perform congruency check in BACKGROUND after greeting
    // This eliminates 1-3 seconds of latency before the agent speaks
    if (this.metadata?.interviewee_cv && this.metadata?.job_title) {
      // Fire async congruency check - don't await it
      this.performBackgroundCongruencyCheck();
    }

    // Extract language preference from metadata (set by multilingualRetellService)
    const preferredLanguage = this.getPreferredLanguage();
    const isMultilingual = preferredLanguage !== 'en-US';

    wsLogger.info('Starting interview with language context', {
      callId: this.callId,
      preferredLanguage,
      isMultilingual,
      candidateName: this.metadata?.first_name,
    });

    // Create InterviewSession for metrics tracking (async, non-blocking)
    this.createSessionForMetrics(preferredLanguage);

    // Proceed with normal interview start
    if (this.metadata) {
      const fieldPrompt = getFieldPrompt(
        this.metadata.job_title || '',
        this.metadata.job_description || ''
      );
      
      // Generate greeting based on language
      let personalizedGreeting: string;
      if (isMultilingual) {
        // Use multilingual greeting
        personalizedGreeting = generateInitialGreeting(
          preferredLanguage,
          this.metadata.first_name || 'there',
          this.metadata.job_title || 'this position',
          this.metadata.company_name || 'your target company'
        );
      } else {
        // Use default English greeting
        personalizedGreeting = formatInitialMessage(
          fieldPrompt,
          this.metadata.first_name || 'there',
          this.metadata.job_title || 'this position',
          this.metadata.company_name || 'your target company'
        );
      }
      
      // OPTIMIZED: Use interview-aligned prompt for better questioning
      // Get seniority from metadata or default to 'mid'
      const seniority = this.metadata.seniority || 'mid';
      
      // Use the new interview-aligned prompt generator
      this.systemPrompt = generateInterviewAlignedPrompt({
        language: preferredLanguage,
        roleTitle: this.metadata.job_title || 'Position',
        seniority: seniority,
        companyName: this.metadata.company_name,
        jobDescription: this.metadata.job_description,
        resumeContext: this.metadata.interviewee_cv,
        roleCountry: this.metadata.role_country,
        // B2B mode disabled for now (feature flagged OFF)
        dynamicConfig: undefined,
      });

      this.conversationHistory.push({
        role: 'system',
        content: this.systemPrompt
      });

      // Send personalized initial greeting
      wsLogger.info('Sending personalized greeting', { 
        callId: this.callId,
        candidateName: this.metadata.first_name,
        field: fieldPrompt.field,
        language: preferredLanguage,
        greetingLength: personalizedGreeting.length 
      });
      this.hasGreeted = true;
      await this.sendAgentInterrupt(personalizedGreeting, false);
    } else {
      wsLogger.warn('No metadata received - sending generic greeting', { callId: this.callId });
      
      // Get language-specific generic greeting
      const phrases = getLanguageSpecificPhrases(preferredLanguage);
      const languageConfig = getLanguageConfig(preferredLanguage);
      
      // Send a generic greeting in the appropriate language
      const genericGreeting = isMultilingual 
        ? phrases.greeting
            .replace('{candidateName}', 'there')
            .replace('{jobTitle}', 'this position')
            .replace('{companyName}', 'your target company')
        : "Hello! Welcome to your mock interview with Vocaid. I'm your AI interviewer, and I'll be helping you prepare for your job interview today. This session will take about 15 minutes. Let's begin - can you tell me about your professional background?";
      
      this.systemPrompt = isMultilingual
        ? `You are Vocaid, a professional AI interviewer helping candidates prepare for job interviews.
You MUST conduct this ENTIRE interview in ${languageConfig.name} (${languageConfig.englishName}).
Be conversational, professional, and encouraging. 
Keep responses concise (1-2 sentences max).
Ask one question at a time and adapt based on candidate responses.
Do NOT switch to English unless the candidate explicitly requests it.`
        : `You are Vocaid, a professional AI interviewer helping candidates prepare for job interviews.
Be conversational, professional, and encouraging. 
Keep responses concise (1-2 sentences max).
Ask one question at a time and adapt based on candidate responses.`;
      
      this.conversationHistory.push({
        role: 'system',
        content: this.systemPrompt
      });
      
      this.hasGreeted = true;
      await this.sendAgentInterrupt(genericGreeting, false);
    }
  }

  /**
   * Get preferred language from metadata
   * Falls back to 'en-US' if not specified
   * 
   * Now uses CallContext as authoritative source (merged in handleCallDetails)
   */
  private getPreferredLanguage(): SupportedLanguageCode {
    // Check various locations where language might be specified
    const languageConfig = this.metadata?.language_config;
    const preferredLanguage = this.metadata?.preferred_language || 
                              languageConfig?.code ||
                              this.metadata?.language_code;
    
    let resolvedLanguage: SupportedLanguageCode = 'en-US';
    
    if (preferredLanguage && isValidLanguageCode(preferredLanguage)) {
      resolvedLanguage = preferredLanguage;
    }
    
    wsLogger.info('Language resolved for interview', {
      callId: this.callId,
      preferredLanguage: this.metadata?.preferred_language,
      languageConfig: languageConfig?.code,
      languageCode: this.metadata?.language_code,
      resolvedLanguage,
    });
    
    return resolvedLanguage;
  }

  /**
   * Detect field/domain from job title for specialized prompts
   */
  private detectFieldFromJobTitle(jobTitle: string): string | undefined {
    const lowerTitle = jobTitle.toLowerCase();
    
    if (lowerTitle.includes('engineer') || lowerTitle.includes('developer') || 
        lowerTitle.includes('software') || lowerTitle.includes('devops') ||
        lowerTitle.includes('architect') || lowerTitle.includes('programmer')) {
      return 'engineering';
    }
    
    if (lowerTitle.includes('marketing') || lowerTitle.includes('brand') ||
        lowerTitle.includes('growth') || lowerTitle.includes('seo')) {
      return 'marketing';
    }
    
    if (lowerTitle.includes('product') || lowerTitle.includes('pm')) {
      return 'product';
    }
    
    if (lowerTitle.includes('design') || lowerTitle.includes('ux') ||
        lowerTitle.includes('ui')) {
      return 'design';
    }
    
    if (lowerTitle.includes('sales') || lowerTitle.includes('account')) {
      return 'sales';
    }
    
    if (lowerTitle.includes('data') || lowerTitle.includes('analyst') ||
        lowerTitle.includes('scientist')) {
      return 'data';
    }
    
    return undefined; // Use general prompt
  }

  /**
   * Handle response required event
   */
  private async handleResponseRequired(request: CustomLLMRequest) {
    wsLogger.debug('Response required', { 
      callId: this.callId,
      retellResponseId: request.response_id,
      hasGreeted: this.hasGreeted
    });
    
    // Use the response_id from Retell's request
    if (request.response_id !== undefined) {
      this.responseId = request.response_id;
    }

    // If we haven't greeted yet, send initial greeting first
    // This handles the case where call_started event isn't received
    if (!this.hasGreeted) {
      wsLogger.info('First response_required - sending initial greeting', { callId: this.callId });
      
      // Try to get metadata from request if we don't have it
      if (!this.metadata && request.metadata) {
        this.metadata = request.metadata;
      }

      // Get language preference
      const preferredLanguage = this.getPreferredLanguage();
      const isMultilingual = preferredLanguage !== 'en-US';
      const languageConfig = getLanguageConfig(preferredLanguage);

      // Setup system prompt with language context
      const fieldPrompt = getFieldPrompt(
        this.metadata?.job_title || 'General',
        this.metadata?.job_description || ''
      );
      
      if (isMultilingual) {
        // Use multilingual prompt
        const multilingualPrompt = generateMultilingualSystemPrompt(
          preferredLanguage,
          this.detectFieldFromJobTitle(this.metadata?.job_title || '')
        );
        
        this.systemPrompt = `${multilingualPrompt}

<interview_context>
  <candidate>${this.metadata?.first_name || 'Candidate'}</candidate>
  <position>${this.metadata?.job_title || 'Position'}</position>
  <company>${this.metadata?.company_name || 'Company'}</company>
</interview_context>

<job_description>${this.metadata?.job_description || 'Not provided'}</job_description>

<response_rules>
  <rule>Keep responses concise (2-3 sentences max)</rule>
  <rule>Ask one question at a time</rule>
  <rule>Conduct the ENTIRE interview in ${languageConfig.name}</rule>
  <rule>Maximum interview duration is 15 minutes</rule>
</response_rules>`;

        // Generate localized greeting
        const greeting = generateInitialGreeting(
          preferredLanguage,
          this.metadata?.first_name || 'there',
          this.metadata?.job_title || 'this position',
          this.metadata?.company_name || 'your target company'
        );
        
        this.conversationHistory.push({
          role: 'system',
          content: this.systemPrompt
        });

        this.hasGreeted = true;
        await this.sendResponse(greeting, false);
        return;
      }
      
      // Default English prompt
      this.systemPrompt = `${fieldPrompt.systemPrompt}

INTERVIEW CONTEXT:
- Candidate: ${this.metadata?.first_name || 'Candidate'}
- Position: ${this.metadata?.job_title || 'Position'} at ${this.metadata?.company_name || 'Company'}
- Job Description: ${this.metadata?.job_description || 'Not provided'}

INSTRUCTIONS:
- Keep responses concise (2-3 sentences max)
- Ask one question at a time
- Be conversational and natural
- Adapt follow-up questions based on candidate responses
- Maximum interview duration is 15 minutes`;

      this.conversationHistory.push({
        role: 'system',
        content: this.systemPrompt
      });

      this.hasGreeted = true;
      
      // Send greeting as a regular response (not agent_interrupt since we're responding to a request)
      await this.sendResponse(fieldPrompt.initialMessage, false);
      return;
    }
    
    // Check timer first
    if (this.interviewTimer.hasExceededTime()) {
      wsLogger.info('Interview time exceeded', { callId: this.callId });
      const timeUpMessage = this.interviewTimer.getTimeUpMessage();
      await this.sendResponse(timeUpMessage, true);
      return;
    }

    // Check if warning needed
    if (this.interviewTimer.shouldWarn()) {
      wsLogger.info('Sending time warning', { callId: this.callId });
      const warningMessage = this.interviewTimer.getWarningMessage();
      await this.sendResponse(warningMessage, false);
      return;
    }

    // Get latest user message
    const transcript = request.transcript || [];
    const lastMessage = transcript[transcript.length - 1];
    
    if (!lastMessage || lastMessage.role !== 'user') {
      wsLogger.warn('No user message to respond to', { callId: this.callId });
      return;
    }

    // Reset reminder count since user is responding
    this.reminderCount = 0;

    wsLogger.debug('User message received', { 
      callId: this.callId, 
      contentLength: lastMessage.content.length 
    });

    // Check if interview time is almost up (2 min warning)
    if (this.interviewTimer.shouldWarn()) {
      wsLogger.info('Interview time warning - 2 minutes remaining', { callId: this.callId });
      const warningMessage = this.interviewTimer.getWarningMessage();
      await this.sendResponse(warningMessage, false);
      // Continue processing after warning
    }

    // Check if interview time has exceeded
    if (this.interviewTimer.hasExceededTime()) {
      wsLogger.info('Interview time exceeded - ending call', { callId: this.callId });
      const timeUpMessage = this.interviewTimer.getTimeUpMessage();
      await this.sendResponseWithReason(timeUpMessage, true, 'max_duration');
      return;
    }

    // Add user message to history
    this.conversationHistory.push({
      role: 'user',
      content: lastMessage.content
    });

    // Check congruency if appropriate timing
    if (!this.congruencyChecked && this.metadata && 
        shouldCheckCongruency(
          this.interviewTimer['startTime'], 
          null, 
          this.conversationHistory.length
        )) {
      await this.performCongruencyCheck();
    }

    // If interview should end, send graceful ending
    if (this.shouldEndInterview) {
      const endingMessage = generateGracefulEndingMessage([], this.isExtremelyIncompatible);
      await this.sendResponseWithReason(
        endingMessage, 
        true, 
        this.isExtremelyIncompatible ? 'incompatibility' : 'mismatch'
      );
      return;
    }

    // Generate AI response
    await this.generateAndSendResponse();
  }

  /**
   * Handle reminder required event (user silent for extended period)
   * Retell sends this before potentially ending the call due to silence
   */
  private async handleReminderRequired(request: CustomLLMRequest) {
    this.reminderCount++;
    wsLogger.info('Reminder required - user not responding', { 
      callId: this.callId, 
      reminderCount: this.reminderCount,
      maxReminders: this.MAX_REMINDERS
    });

    // If we've sent too many reminders, end the call gracefully
    if (this.reminderCount >= this.MAX_REMINDERS) {
      wsLogger.info('Max reminders reached - ending call due to silence', { callId: this.callId });
      const farewellMessage = "I notice you've been quiet for a while. " +
        "That's completely okay - interviews can be challenging. " +
        "I'm going to end our session here to save your time. " +
        "Feel free to start a new interview whenever you're ready. " +
        "Take care, and good luck with your job search!";
      
      await this.sendResponseWithReason(farewellMessage, true, 'silence');
      return;
    }

    // First reminder - gentle prompt
    if (this.reminderCount === 1) {
      await this.sendResponse(
        "I'm sorry, I didn't catch that. Could you please repeat your answer? " +
        "Take your time - there's no rush.",
        false
      );
    } else {
      // Second reminder - more explicit
      await this.sendResponse(
        "I'm still here whenever you're ready. " +
        "If you need a moment to think, that's perfectly fine. " +
        "Just let me know when you'd like to continue.",
        false
      );
    }
  }

  /**
   * Perform background congruency check at interview start
   * Runs async to avoid blocking the initial greeting
   */
  private async performBackgroundCongruencyCheck() {
    if (!this.metadata) return;

    wsLogger.info('Starting background compatibility check', { callId: this.callId });
    
    try {
      const quickAnalysis = await analyzeResumeJobCongruency(
        this.metadata.interviewee_cv,
        this.metadata.job_title,
        this.metadata.job_description || '',
        this.openai,
        true // Quick check mode
      );

      wsLogger.info('Background compatibility result', {
        callId: this.callId,
        isCongruent: quickAnalysis.isCongruent,
        isExtremelyIncompatible: quickAnalysis.isExtremelyIncompatible,
        confidence: quickAnalysis.confidence
      });

      // Only flag for extreme incompatibility - will be handled on next response
      if (quickAnalysis.isExtremelyIncompatible && quickAnalysis.confidence > 0.95) {
        wsLogger.warn('EXTREME INCOMPATIBILITY DETECTED', { 
          callId: this.callId,
          reasons: quickAnalysis.reasons 
        });
        this.isExtremelyIncompatible = true;
        this.shouldEndInterview = true;
        this.congruencyChecked = true;
      }
    } catch (error: any) {
      wsLogger.error('Background compatibility check failed', { 
        callId: this.callId, 
        error: error.message 
      });
    }
  }

  /**
   * Perform congruency analysis (mid-interview check)
   * This is more lenient than the initial quick check
   */
  private async performCongruencyCheck() {
    if (!this.metadata) return;

    wsLogger.info('Performing full congruency check', { callId: this.callId });
    
    try {
      const analysis = await analyzeResumeJobCongruency(
        this.metadata.interviewee_cv || '',
        this.metadata.job_title || '',
        this.metadata.job_description || '',
        this.openai,
        false // Full analysis mode
      );

      wsLogger.info('Congruency analysis complete', { 
        callId: this.callId,
        isCongruent: analysis.isCongruent,
        confidence: analysis.confidence 
      });

      this.congruencyChecked = true;

      // VERY HIGH bar for ending mid-interview - require high confidence AND extreme incompatibility
      // Normal mismatches should NOT end the interview - let the candidate practice
      if (!analysis.isCongruent && analysis.confidence > 0.85 && analysis.isExtremelyIncompatible) {
        wsLogger.warn('Mid-interview incompatibility detected', {
          callId: this.callId,
          confidence: analysis.confidence,
          reasons: analysis.reasons
        });
        this.shouldEndInterview = true;
        this.isExtremelyIncompatible = true;
      }
      // Note: We no longer end interviews for moderate mismatches
      // Let candidates practice interviewing even if not a perfect fit
    } catch (error: any) {
      wsLogger.error('Error performing congruency check', { 
        callId: this.callId, 
        error: error.message 
      });
      // On error, continue interview
      this.congruencyChecked = true;
    }
  }

  /**
   * Prune conversation history to prevent memory bloat
   * Keeps system prompt + last N messages
   */
  private pruneConversationHistory() {
    if (this.conversationHistory.length > MAX_CONVERSATION_HISTORY) {
      // Keep system prompt (first message) and last N-1 messages
      const systemMessage = this.conversationHistory[0];
      const recentMessages = this.conversationHistory.slice(-(MAX_CONVERSATION_HISTORY - 1));
      this.conversationHistory = [systemMessage, ...recentMessages];
      wsLogger.debug('Pruned conversation history', { 
        callId: this.callId, 
        newLength: this.conversationHistory.length 
      });
    }
  }

  /**
   * Create InterviewSession for metrics tracking
   * Runs async to not block interview start
   */
  private async createSessionForMetrics(language: SupportedLanguageCode) {
    try {
      // Get interview ID from metadata (if available)
      const interviewId = this.metadata?.interview_id;
      
      if (!interviewId) {
        wsLogger.debug('No interview ID available - skipping session creation', { 
          callId: this.callId 
        });
        return;
      }

      const session = await createInterviewSession({
        interviewId,
        retellCallId: this.callId,
        language,
        roleTitle: this.metadata?.job_title || 'Unknown',
        seniority: this.metadata?.seniority || 'mid',
        roleCountry: this.metadata?.role_country,
      });

      if (session) {
        this.sessionId = session.id;
        wsLogger.info('Interview session created for metrics', {
          callId: this.callId,
          sessionId: session.id,
          interviewId,
        });
      }
    } catch (error: any) {
      wsLogger.error('Failed to create interview session', {
        callId: this.callId,
        error: error.message,
      });
      // Non-blocking - don't fail the interview if metrics fail
    }
  }

  /**
   * Record first agent utterance for latency metrics
   */
  private async recordFirstUtteranceMetrics() {
    if (this.firstUtteranceSent) {
      return;
    }

    this.firstUtteranceSent = true;
    
    // Use interviewId for recording first utterance
    const interviewId = this.metadata?.interview_id;
    if (!interviewId) {
      return;
    }
    
    try {
      await recordFirstAgentUtterance(interviewId);
      wsLogger.debug('First utterance recorded', { 
        callId: this.callId,
        interviewId 
      });
    } catch (error: any) {
      wsLogger.warn('Failed to record first utterance', {
        callId: this.callId,
        error: error.message,
      });
    }
  }

  /**
   * Log token usage from OpenAI response
   */
  private async logTokenUsage(promptTokens: number, completionTokens: number, model: string) {
    this.totalPromptTokens += promptTokens;
    this.totalCompletionTokens += completionTokens;
    this.turnCount++;

    const interviewId = this.metadata?.interview_id;
    if (!interviewId) {
      return;
    }

    try {
      await updateSessionTokens(interviewId, {
        promptTokens,
        completionTokens,
        llmModel: model,
        llmProvider: 'openai',
      });
    } catch (error: any) {
      wsLogger.warn('Failed to log token usage', {
        callId: this.callId,
        error: error.message,
      });
    }
  }

  /**
   * Complete the interview session with final metrics
   */
  private async completeSession(endReason: string) {
    const interviewId = this.metadata?.interview_id;
    if (!interviewId) {
      return;
    }

    try {
      // Map string end reason to InterviewEndReason enum value
      const endReasonMap: Record<string, 'COMPLETED' | 'USER_HANGUP' | 'TIME_LIMIT' | 'TECHNICAL_ERROR' | 'INCOMPATIBILITY' | 'SILENCE_TIMEOUT' | 'AGENT_ERROR'> = {
        'normal': 'COMPLETED',
        'completed': 'COMPLETED',
        'max_duration': 'TIME_LIMIT',
        'time_exceeded': 'TIME_LIMIT',
        'silence': 'SILENCE_TIMEOUT',
        'incompatibility': 'INCOMPATIBILITY',
        'mismatch': 'INCOMPATIBILITY',
        'error': 'TECHNICAL_ERROR',
        'user_ended': 'USER_HANGUP',
        'user_hangup': 'USER_HANGUP',
        'agent_error': 'AGENT_ERROR',
      };
      
      const mappedReason = endReasonMap[endReason.toLowerCase()] || 'COMPLETED';

      await finalizeSession(interviewId, {
        endReason: mappedReason,
        completionRate: this.calculateCompletionRate(),
        retellDurationSec: Math.floor(this.interviewTimer.getElapsedMinutes() * 60),
        retellDisconnectReason: endReason,
      });

      // Trigger post-call processing asynchronously (don't await to avoid blocking)
      // This will fetch Retell post-call data, generate metrics + study plan via OpenAI
      postCallProcessingService.processInterview(interviewId).catch((error: any) => {
        wsLogger.error('Post-call processing failed', {
          callId: this.callId,
          interviewId,
          error: error.message,
        });
      });

      wsLogger.info('Interview session completed', {
        callId: this.callId,
        interviewId,
        turnCount: this.turnCount,
        totalTokens: this.totalPromptTokens + this.totalCompletionTokens,
        endReason: mappedReason,
      });
    } catch (error: any) {
      wsLogger.error('Failed to complete session', {
        callId: this.callId,
        error: error.message,
      });
    }
  }

  /**
   * Calculate interview completion rate (0-1)
   * Based on typical interview phases completed
   */
  private calculateCompletionRate(): number {
    const elapsed = this.interviewTimer.getElapsedMinutes();
    const maxDuration = parseInt(process.env.MAX_INTERVIEW_DURATION_MINUTES || '15');
    
    // Completion is based on time spent vs max duration
    // Also consider if interview ended prematurely
    let rate = elapsed / maxDuration;
    
    // Cap at 1.0
    return Math.min(rate, 1.0);
  }

  /**
   * Exponential backoff delay calculator
   */
  private getRetryDelay(attempt: number): number {
    return Math.min(BASE_RETRY_DELAY_MS * Math.pow(2, attempt), 4000);
  }

  /**
   * Generate response using OpenAI streaming with exponential backoff
   * OPTIMIZED: Using gpt-4o-mini for faster response times (~2-3x faster than gpt-4o)
   */
  private async generateAndSendResponse() {
    // Prevent concurrent processing
    if (this.isProcessing) {
      wsLogger.warn('Already processing response, skipping', { callId: this.callId });
      return;
    }
    this.isProcessing = true;

    wsLogger.debug('Generating AI response', { 
      callId: this.callId
    });

    // Prune history before generating
    this.pruneConversationHistory();
    
    let lastError: Error | null = null;
    const model = 'gpt-4o-mini';
    
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        let fullResponse = '';
        let chunkCount = 0;
        let promptTokens = 0;
        let completionTokens = 0;

        // Use OpenAI streaming with usage tracking
        const stream = await this.openai.chat.completions.create({
          model,
          messages: this.conversationHistory.map(m => ({ role: m.role, content: m.content })),
          temperature: 0.4,
          max_tokens: 100,
          presence_penalty: 0.5,
          frequency_penalty: 0.3,
          stream: true,
          stream_options: { include_usage: true },
        });

        for await (const chunk of stream) {
          const content = chunk.choices[0]?.delta?.content || '';
          const isComplete = chunk.choices[0]?.finish_reason !== null;
          
          // Capture usage data (comes in final chunk with stream_options)
          if (chunk.usage) {
            promptTokens = chunk.usage.prompt_tokens || 0;
            completionTokens = chunk.usage.completion_tokens || 0;
          }
          
          if (content) {
            fullResponse += content;
            chunkCount++;
            
            // Send streaming response
            const response: CustomLLMResponse = {
              response_type: 'response',
              response_id: this.responseId,
              content: content,
              content_complete: false
            };
            this.ws.send(JSON.stringify(response));
          }

          if (isComplete) {
            // Send completion
            const finalResponse: CustomLLMResponse = {
              response_type: 'response',
              response_id: this.responseId,
              content: '',
              content_complete: true
            };
            this.ws.send(JSON.stringify(finalResponse));
          }
        }

        wsLogger.debug('AI response sent', { 
          callId: this.callId, 
          responseId: this.responseId,
          chunkCount,
          responseLength: fullResponse.length,
          promptTokens,
          completionTokens,
        });

        // Log token usage for metrics
        if (promptTokens > 0 || completionTokens > 0) {
          this.logTokenUsage(promptTokens, completionTokens, model);
        }

        // Add to conversation history
        this.conversationHistory.push({
          role: 'assistant',
          content: fullResponse
        });

        this.responseId++;
        this.isProcessing = false;
        return; // Success - exit retry loop
      } catch (error: any) {
        lastError = error;
        wsLogger.warn('OpenAI request failed, retrying', { 
          callId: this.callId, 
          attempt: attempt + 1,
          maxRetries: MAX_RETRIES,
          error: error.message
        });

        if (attempt < MAX_RETRIES - 1) {
          await new Promise(resolve => setTimeout(resolve, this.getRetryDelay(attempt)));
        }
      }
    }

    // All retries failed
    wsLogger.error('Error generating AI response after retries', { 
      callId: this.callId, 
      error: lastError?.message
    });

    // Send a fallback response to avoid silence
    const fallbackMessage = "I apologize, I'm having a brief technical issue. Could you please repeat what you just said?";
    await this.sendResponse(fallbackMessage, false);
    this.isProcessing = false;
  }

  /**
   * Send an agent interrupt (for initial greeting and agent-initiated messages)
   * This makes the agent speak first without waiting for user input
   */
  private async sendAgentInterrupt(content: string, endCall: boolean = false) {
    // For agent_interrupt, we use response_id 0 for the initial greeting
    // Retell expects the agent to speak first when using Custom LLM
    const response: CustomLLMResponse = {
      response_type: 'response', // Use 'response' type for initial greeting
      response_id: 0, // First message always uses response_id 0
      content: content,
      content_complete: true,
      end_call: endCall,
      end_call_after_spoken: endCall
    };

    wsLogger.debug('Sending initial agent message', {
      callId: this.callId,
      responseId: 0,
      contentLength: content.length,
      endCall
    });
    
    this.ws.send(JSON.stringify(response));

    // Record first utterance for latency metrics
    this.recordFirstUtteranceMetrics();

    this.conversationHistory.push({
      role: 'assistant',
      content: content
    });

    // Set responseId to 1 for subsequent responses
    this.responseId = 1;
  }

  /**
   * Send an agent interrupt that MUST speak before ending call
   * This ensures the user always hears the ending message before disconnection
   */
  private async sendAgentInterruptWithEndAfterSpoken(content: string) {
    const response: CustomLLMResponse = {
      response_type: 'response',
      response_id: 0,
      content: content,
      content_complete: true,
      end_call: false, // Don't end immediately
      end_call_after_spoken: true, // End ONLY after speaking
      no_interruption_allowed: true // Don't allow user to interrupt the ending message
    };

    wsLogger.debug('Sending ending message (will end after spoken)', {
      callId: this.callId,
      responseId: 0,
      contentLength: content.length
    });
    
    this.ws.send(JSON.stringify(response));

    this.conversationHistory.push({
      role: 'assistant',
      content: content
    });

    this.responseId = 1;
  }

  /**
   * Send a direct response (non-streaming)
   */
  private async sendResponse(content: string, endCall: boolean = false) {
    const response: CustomLLMResponse = {
      response_type: 'response',
      response_id: this.responseId,
      content: content,
      content_complete: true,
      end_call: endCall,
      end_call_after_spoken: endCall
    };

    wsLogger.debug('Sending response', {
      callId: this.callId,
      responseId: this.responseId,
      contentLength: content.length,
      endCall
    });
    
    this.ws.send(JSON.stringify(response));

    this.conversationHistory.push({
      role: 'assistant',
      content: content
    });

    this.responseId++;
  }

  /**
   * Send a response with end reason (for tracking incompatibility)
   * Ensures the agent speaks the message completely before ending
   */
  private async sendResponseWithReason(content: string, endCall: boolean, reason: string) {
    const response: CustomLLMResponse = {
      response_type: 'response',
      response_id: this.responseId,
      content: content,
      content_complete: true,
      end_call: endCall,
      end_call_after_spoken: endCall, // Wait for agent to finish speaking
      end_call_reason: reason,
      no_interruption_allowed: endCall // Prevent user from interrupting the ending message
    };

    wsLogger.info('Sending response with reason', { 
      callId: this.callId, 
      reason, 
      endCall,
      contentLength: content.length
    });
    this.ws.send(JSON.stringify(response));

    // Complete session early if call is ending (for accurate timing)
    if (endCall) {
      this.completeSession(reason);
    }

    this.conversationHistory.push({
      role: 'assistant',
      content: content
    });

    this.responseId++;
  }

  /**
   * Handle WebSocket errors
   */
  handleError(error: Error) {
    wsLogger.error('WebSocket error', { callId: this.callId, error: error.message });
    // Complete session with error reason
    this.completeSession('error');
  }

  /**
   * Handle WebSocket close
   */
  handleClose() {
    wsLogger.info('WebSocket connection closed', { 
      callId: this.callId,
      duration: this.interviewTimer.getFormattedElapsedTime(),
      totalTokens: this.totalPromptTokens + this.totalCompletionTokens,
      turnCount: this.turnCount,
    });
    
    // Complete the session with final metrics
    this.completeSession('normal');
  }
}
