import WebSocket from 'ws';
import OpenAI from 'openai';
import { getFieldPrompt, formatInitialMessage } from '../prompts/fieldPrompts';
import { 
  analyzeResumeJobCongruency, 
  generateGracefulEndingMessage,
  shouldCheckCongruency,
  CongruencyAnalysis
} from '../utils/congruencyAnalyzer';
import { InterviewTimer } from '../utils/interviewTimer';
import { wsLogger } from '../utils/logger';
import { AIService, getAIService, ChatMessage } from './aiService';

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
  };
  // Retell LLM dynamic variables passed during call
  retell_llm_dynamic_variables?: {
    first_name?: string;
    job_title?: string;
    company_name?: string;
    job_description?: string;
    interviewee_cv?: string;
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

export class CustomLLMWebSocketHandler {
  private ws: WebSocket;
  private openai: OpenAI;
  private aiService: AIService;
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

  constructor(ws: WebSocket, openai: OpenAI, callId?: string) {
    this.ws = ws;
    this.openai = openai;
    this.aiService = getAIService();
    this.callId = callId || '';
    this.interviewTimer = new InterviewTimer(
      parseInt(process.env.MAX_INTERVIEW_DURATION_MINUTES || '15')
    );
    wsLogger.info('CustomLLMWebSocketHandler created', { 
      callId: this.callId,
      aiProvider: this.aiService.getCurrentProvider()
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
    
    wsLogger.info('Sending initial config', { callId: this.callId });
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

      wsLogger.info('Retell message received', {
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
          wsLogger.info('Update only - no response needed', { callId: this.callId });
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
    wsLogger.info('Responding to ping_pong', { callId: this.callId });
    this.ws.send(JSON.stringify(pongResponse));
  }

  /**
   * Handle call_details event (newer API - replaces call_started)
   */
  private async handleCallDetails(request: CustomLLMRequest) {
    // Extract metadata from various possible locations
    const metadata = request.metadata || 
                     request.retell_llm_dynamic_variables || 
                     request.call?.metadata ||
                     request.call?.retell_llm_dynamic_variables ||
                     {};
    
    wsLogger.info('Call details received', {
      callId: request.call?.call_id || request.call_id,
      candidate: metadata.first_name || 'Unknown',
      position: metadata.job_title || 'Unknown',
      company: metadata.company_name || 'Unknown',
      hasCV: !!metadata.interviewee_cv
    });
    
    // Store metadata
    this.metadata = metadata;

    // Proceed to start the interview (same logic as handleCallStarted)
    await this.startInterview();
  }

  /**
   * Handle call started event (legacy API)
   */
  private async handleCallStarted(request: CustomLLMRequest) {
    wsLogger.info('Call session started (legacy)', {
      callId: request.call_id,
      candidate: request.metadata?.first_name || 'Unknown',
      position: request.metadata?.job_title || 'Unknown',
      company: request.metadata?.company_name || 'Unknown'
    });
    
    // Store metadata
    this.metadata = request.metadata;

    // Start the interview
    await this.startInterview();
  }

  /**
   * Start the interview - shared logic for call_details and call_started
   */
  private async startInterview() {
    // OPTIMIZATION: Perform congruency check in BACKGROUND after greeting
    // This eliminates 1-3 seconds of latency before the agent speaks
    if (this.metadata?.interviewee_cv && this.metadata?.job_title) {
      // Fire async congruency check - don't await it
      this.performBackgroundCongruencyCheck();
    }

    // Proceed with normal interview start
    if (this.metadata) {
      const fieldPrompt = getFieldPrompt(
        this.metadata.job_title || '',
        this.metadata.job_description || ''
      );
      
      // Format the initial message with candidate-specific information
      const personalizedGreeting = formatInitialMessage(
        fieldPrompt,
        this.metadata.first_name || 'there',
        this.metadata.job_title || 'this position',
        this.metadata.company_name || 'your target company'
      );
      
      // OPTIMIZED: Condensed system prompt to reduce tokens and processing time
      // Truncate job description and resume to essential parts
      const truncatedJobDesc = (this.metadata.job_description || '').substring(0, 500);
      const truncatedCV = (this.metadata.interviewee_cv || '').substring(0, 1000);
      
      this.systemPrompt = `${fieldPrompt.systemPrompt}

CONTEXT: ${this.metadata.first_name} for ${this.metadata.job_title} at ${this.metadata.company_name}

JOB: ${truncatedJobDesc}

RESUME: ${truncatedCV}

RULES: 1-2 sentences max. ONE question at a time. Reference their resume.`;

      this.conversationHistory.push({
        role: 'system',
        content: this.systemPrompt
      });

      // Send personalized initial greeting
      wsLogger.info('Sending personalized greeting', { 
        callId: this.callId,
        candidateName: this.metadata.first_name,
        field: fieldPrompt.field,
        greetingLength: personalizedGreeting.length 
      });
      this.hasGreeted = true;
      await this.sendAgentInterrupt(personalizedGreeting, false);
    } else {
      wsLogger.warn('No metadata received - sending generic greeting', { callId: this.callId });
      
      // Send a generic greeting if no metadata
      const genericGreeting = "Hello! Welcome to your mock interview with Voxly. I'm your AI interviewer, and I'll be helping you prepare for your job interview today. This session will take about 15 minutes. Let's begin - can you tell me about your professional background?";
      
      this.systemPrompt = `You are Voxly, a professional AI interviewer helping candidates prepare for job interviews.
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
   * Handle response required event
   */
  private async handleResponseRequired(request: CustomLLMRequest) {
    wsLogger.info('Response required', { 
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

      // Setup system prompt and send greeting
      const fieldPrompt = getFieldPrompt(
        this.metadata?.job_title || 'General',
        this.metadata?.job_description || ''
      );
      
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

    wsLogger.info('User message received', { 
      callId: this.callId, 
      content: lastMessage.content.substring(0, 100) 
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
   * Generate response using AIService (OpenAI with Gemini fallback)
   * OPTIMIZED: Using gpt-4o-mini for faster response times (~2-3x faster than gpt-4o)
   * FALLBACK: Automatically falls back to Gemini on OpenAI errors
   */
  private async generateAndSendResponse() {
    wsLogger.info('Generating AI response', { 
      callId: this.callId,
      provider: this.aiService.getCurrentProvider()
    });
    
    try {
      let fullResponse = '';
      let chunkCount = 0;

      // Use AIService streaming with automatic fallback
      const stream = this.aiService.streamChatCompletion(
        this.conversationHistory,
        {
          model: 'gpt-4o-mini', // Will fallback to gemini-1.5-flash if needed
          temperature: 0.4,
          maxTokens: 100,
          presencePenalty: 0.5,
          frequencyPenalty: 0.3
        }
      );

      for await (const chunk of stream) {
        if (chunk.content) {
          fullResponse += chunk.content;
          chunkCount++;
          
          // Send streaming response
          const response: CustomLLMResponse = {
            response_type: 'response',
            response_id: this.responseId,
            content: chunk.content,
            content_complete: false
          };
          this.ws.send(JSON.stringify(response));
        }

        if (chunk.isComplete) {
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

      wsLogger.info('AI response sent', { 
        callId: this.callId, 
        responseId: this.responseId,
        chunkCount,
        responseLength: fullResponse.length,
        provider: this.aiService.getCurrentProvider()
      });

      // Add to conversation history
      this.conversationHistory.push({
        role: 'assistant',
        content: fullResponse
      });

      this.responseId++;
    } catch (error: any) {
      wsLogger.error('Error generating AI response', { 
        callId: this.callId, 
        error: error.message,
        provider: this.aiService.getCurrentProvider()
      });

      // Send a fallback response to avoid silence
      const fallbackMessage = "I apologize, I'm having a brief technical issue. Could you please repeat what you just said?";
      await this.sendResponse(fallbackMessage, false);
    }
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

    wsLogger.info('Sending initial agent message', {
      callId: this.callId,
      responseId: 0,
      contentPreview: content.substring(0, 100),
      endCall
    });
    
    this.ws.send(JSON.stringify(response));

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

    wsLogger.info('Sending ending message (will end after spoken)', {
      callId: this.callId,
      responseId: 0,
      contentPreview: content.substring(0, 100)
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

    wsLogger.info('Sending response', {
      callId: this.callId,
      responseId: this.responseId,
      contentPreview: content.substring(0, 100),
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
  }

  /**
   * Handle WebSocket close
   */
  handleClose() {
    wsLogger.info('WebSocket connection closed', { 
      callId: this.callId,
      duration: this.interviewTimer.getFormattedElapsedTime()
    });
  }
}
