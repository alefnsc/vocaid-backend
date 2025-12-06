import OpenAI from 'openai';
import { GoogleGenerativeAI, GenerativeModel, GenerationConfig, Content } from '@google/generative-ai';
import { wsLogger } from '../utils/logger';

/**
 * AI Service - Unified interface for OpenAI and Gemini with fallback support
 * 
 * Provides a consistent API for:
 * - Chat completions (streaming and non-streaming)
 * - Automatic fallback from OpenAI to Gemini on errors
 * - Token limit handling
 * - Rate limit detection
 * - Service unavailability handling
 */

// Error types that should trigger fallback to Gemini
const FALLBACK_ERROR_CODES = [
  'rate_limit_exceeded',
  'insufficient_quota',
  'server_error',
  'service_unavailable',
  'timeout',
  'context_length_exceeded',
  'model_overloaded'
];

const FALLBACK_STATUS_CODES = [429, 500, 502, 503, 504];

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  presencePenalty?: number;
  frequencyPenalty?: number;
  responseFormat?: 'text' | 'json';
}

export interface StreamChunk {
  content: string;
  isComplete: boolean;
}

export type StreamCallback = (chunk: StreamChunk) => void;

export class AIService {
  private openai: OpenAI;
  private gemini: GoogleGenerativeAI;
  private geminiModel: GenerativeModel;
  private currentProvider: 'openai' | 'gemini' = 'openai';
  private consecutiveOpenAIErrors: number = 0;
  private readonly MAX_CONSECUTIVE_ERRORS = 3;
  private openAIAvailable: boolean = true;
  private lastOpenAIErrorTime: number = 0;
  private readonly OPENAI_COOLDOWN_MS = 60000; // 1 minute cooldown after errors

  constructor() {
    // Initialize OpenAI
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });

    // Initialize Gemini
    this.gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
    this.geminiModel = this.gemini.getGenerativeModel({ 
      model: 'gemini-1.5-flash' // Fast model, similar to gpt-4o-mini
    });

    wsLogger.info('AIService initialized', {
      openaiConfigured: !!process.env.OPENAI_API_KEY,
      geminiConfigured: !!process.env.GEMINI_API_KEY
    });
  }

  /**
   * Check if an error should trigger fallback to Gemini
   */
  private shouldFallback(error: any): boolean {
    // Check error code
    if (error?.code && FALLBACK_ERROR_CODES.includes(error.code)) {
      return true;
    }

    // Check HTTP status code
    if (error?.status && FALLBACK_STATUS_CODES.includes(error.status)) {
      return true;
    }

    // Check for specific error messages
    const errorMessage = error?.message?.toLowerCase() || '';
    if (
      errorMessage.includes('rate limit') ||
      errorMessage.includes('quota') ||
      errorMessage.includes('context length') ||
      errorMessage.includes('token') ||
      errorMessage.includes('overloaded') ||
      errorMessage.includes('timeout') ||
      errorMessage.includes('service unavailable') ||
      errorMessage.includes('503') ||
      errorMessage.includes('429')
    ) {
      return true;
    }

    return false;
  }

  /**
   * Check if OpenAI should be tried (cooldown check)
   */
  private shouldTryOpenAI(): boolean {
    if (!this.openAIAvailable) {
      const timeSinceError = Date.now() - this.lastOpenAIErrorTime;
      if (timeSinceError > this.OPENAI_COOLDOWN_MS) {
        // Reset after cooldown
        this.openAIAvailable = true;
        this.consecutiveOpenAIErrors = 0;
        wsLogger.info('OpenAI cooldown ended, re-enabling');
      }
    }
    return this.openAIAvailable;
  }

  /**
   * Record OpenAI error and potentially disable temporarily
   */
  private recordOpenAIError(error: any) {
    this.consecutiveOpenAIErrors++;
    this.lastOpenAIErrorTime = Date.now();

    if (this.consecutiveOpenAIErrors >= this.MAX_CONSECUTIVE_ERRORS) {
      this.openAIAvailable = false;
      wsLogger.warn('OpenAI temporarily disabled due to consecutive errors', {
        errorCount: this.consecutiveOpenAIErrors,
        cooldownMs: this.OPENAI_COOLDOWN_MS
      });
    }
  }

  /**
   * Reset OpenAI error count on successful call
   */
  private recordOpenAISuccess() {
    this.consecutiveOpenAIErrors = 0;
    this.openAIAvailable = true;
  }

  /**
   * Convert ChatMessage array to Gemini format
   */
  private convertToGeminiFormat(messages: ChatMessage[]): { systemInstruction: string; history: Content[] } {
    let systemInstruction = '';
    const history: Content[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        // Gemini uses systemInstruction for system prompts
        systemInstruction += (systemInstruction ? '\n\n' : '') + msg.content;
      } else if (msg.role === 'user') {
        history.push({
          role: 'user',
          parts: [{ text: msg.content }]
        });
      } else if (msg.role === 'assistant') {
        history.push({
          role: 'model',
          parts: [{ text: msg.content }]
        });
      }
    }

    return { systemInstruction, history };
  }

  /**
   * Map OpenAI model to Gemini equivalent
   */
  private getGeminiModel(openaiModel?: string): string {
    const modelMap: Record<string, string> = {
      'gpt-4o': 'gemini-1.5-pro',
      'gpt-4o-mini': 'gemini-1.5-flash',
      'gpt-4-turbo': 'gemini-1.5-pro',
      'gpt-4': 'gemini-1.5-pro',
      'gpt-3.5-turbo': 'gemini-1.5-flash'
    };
    return modelMap[openaiModel || 'gpt-4o-mini'] || 'gemini-1.5-flash';
  }

  /**
   * Generate chat completion (non-streaming)
   */
  async chatCompletion(
    messages: ChatMessage[],
    options: ChatCompletionOptions = {}
  ): Promise<string> {
    const { 
      model = 'gpt-4o-mini',
      temperature = 0.4,
      maxTokens = 200,
      responseFormat = 'text'
    } = options;

    // Try OpenAI first if available
    if (this.shouldTryOpenAI()) {
      try {
        wsLogger.info('Attempting OpenAI chat completion', { model });
        
        const response = await this.openai.chat.completions.create({
          model,
          messages: messages.map(m => ({ role: m.role, content: m.content })),
          temperature,
          max_tokens: maxTokens,
          response_format: responseFormat === 'json' ? { type: 'json_object' } : undefined
        });

        this.recordOpenAISuccess();
        this.currentProvider = 'openai';
        
        return response.choices[0]?.message?.content || '';
      } catch (error: any) {
        wsLogger.error('OpenAI chat completion failed', { 
          error: error.message,
          code: error.code,
          status: error.status
        });

        if (this.shouldFallback(error)) {
          this.recordOpenAIError(error);
          wsLogger.info('Falling back to Gemini');
        } else {
          throw error; // Re-throw non-fallback errors
        }
      }
    }

    // Fallback to Gemini
    return this.geminiChatCompletion(messages, options);
  }

  /**
   * Gemini chat completion (non-streaming)
   */
  private async geminiChatCompletion(
    messages: ChatMessage[],
    options: ChatCompletionOptions = {}
  ): Promise<string> {
    const {
      model,
      temperature = 0.4,
      maxTokens = 200,
      responseFormat = 'text'
    } = options;

    try {
      wsLogger.info('Using Gemini for chat completion', { 
        model: this.getGeminiModel(model) 
      });

      const { systemInstruction, history } = this.convertToGeminiFormat(messages);

      // Create model with specific configuration
      const geminiModel = this.gemini.getGenerativeModel({
        model: this.getGeminiModel(model),
        systemInstruction: systemInstruction || undefined,
        generationConfig: {
          temperature,
          maxOutputTokens: maxTokens,
          responseMimeType: responseFormat === 'json' ? 'application/json' : 'text/plain'
        } as GenerationConfig
      });

      // Get the last user message for the prompt
      const lastUserMessage = messages.filter(m => m.role === 'user').pop();
      
      if (!lastUserMessage) {
        throw new Error('No user message found');
      }

      // Start chat with history (excluding the last user message)
      const historyWithoutLast = history.slice(0, -1);
      const chat = geminiModel.startChat({
        history: historyWithoutLast.length > 0 ? historyWithoutLast : undefined
      });

      const result = await chat.sendMessage(lastUserMessage.content);
      const response = result.response.text();

      this.currentProvider = 'gemini';
      
      return response;
    } catch (error: any) {
      wsLogger.error('Gemini chat completion failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Generate streaming chat completion
   * Returns a generator that yields chunks
   */
  async *streamChatCompletion(
    messages: ChatMessage[],
    options: ChatCompletionOptions = {}
  ): AsyncGenerator<StreamChunk> {
    const {
      model = 'gpt-4o-mini',
      temperature = 0.4,
      maxTokens = 100,
      presencePenalty = 0.5,
      frequencyPenalty = 0.3
    } = options;

    // Try OpenAI first if available
    if (this.shouldTryOpenAI()) {
      try {
        wsLogger.info('Attempting OpenAI streaming completion', { model });

        const stream = await this.openai.chat.completions.create({
          model,
          messages: messages.map(m => ({ role: m.role, content: m.content })),
          temperature,
          max_tokens: maxTokens,
          presence_penalty: presencePenalty,
          frequency_penalty: frequencyPenalty,
          stream: true
        });

        this.recordOpenAISuccess();
        this.currentProvider = 'openai';

        for await (const chunk of stream) {
          const content = chunk.choices[0]?.delta?.content || '';
          const isComplete = chunk.choices[0]?.finish_reason !== null;
          
          if (content || isComplete) {
            yield { content, isComplete };
          }
        }

        return;
      } catch (error: any) {
        wsLogger.error('OpenAI streaming failed', {
          error: error.message,
          code: error.code,
          status: error.status
        });

        if (this.shouldFallback(error)) {
          this.recordOpenAIError(error);
          wsLogger.info('Falling back to Gemini streaming');
        } else {
          throw error;
        }
      }
    }

    // Fallback to Gemini streaming
    yield* this.geminiStreamCompletion(messages, options);
  }

  /**
   * Gemini streaming completion
   */
  private async *geminiStreamCompletion(
    messages: ChatMessage[],
    options: ChatCompletionOptions = {}
  ): AsyncGenerator<StreamChunk> {
    const {
      model,
      temperature = 0.4,
      maxTokens = 100
    } = options;

    try {
      wsLogger.info('Using Gemini for streaming completion', {
        model: this.getGeminiModel(model)
      });

      const { systemInstruction, history } = this.convertToGeminiFormat(messages);

      const geminiModel = this.gemini.getGenerativeModel({
        model: this.getGeminiModel(model),
        systemInstruction: systemInstruction || undefined,
        generationConfig: {
          temperature,
          maxOutputTokens: maxTokens
        } as GenerationConfig
      });

      const lastUserMessage = messages.filter(m => m.role === 'user').pop();
      
      if (!lastUserMessage) {
        throw new Error('No user message found');
      }

      const historyWithoutLast = history.slice(0, -1);
      const chat = geminiModel.startChat({
        history: historyWithoutLast.length > 0 ? historyWithoutLast : undefined
      });

      const result = await chat.sendMessageStream(lastUserMessage.content);

      for await (const chunk of result.stream) {
        const text = chunk.text();
        if (text) {
          yield { content: text, isComplete: false };
        }
      }

      // Signal completion
      yield { content: '', isComplete: true };

      this.currentProvider = 'gemini';
    } catch (error: any) {
      wsLogger.error('Gemini streaming failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Get current provider being used
   */
  getCurrentProvider(): 'openai' | 'gemini' {
    return this.currentProvider;
  }

  /**
   * Check service health
   */
  async healthCheck(): Promise<{ openai: boolean; gemini: boolean }> {
    let openaiHealthy = false;
    let geminiHealthy = false;

    try {
      await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 5
      });
      openaiHealthy = true;
    } catch {
      openaiHealthy = false;
    }

    try {
      const model = this.gemini.getGenerativeModel({ model: 'gemini-1.5-flash' });
      await model.generateContent('ping');
      geminiHealthy = true;
    } catch {
      geminiHealthy = false;
    }

    return { openai: openaiHealthy, gemini: geminiHealthy };
  }

  /**
   * Get the underlying OpenAI client (for backward compatibility)
   */
  getOpenAI(): OpenAI {
    return this.openai;
  }
}

// Singleton instance
let aiServiceInstance: AIService | null = null;

export function getAIService(): AIService {
  if (!aiServiceInstance) {
    aiServiceInstance = new AIService();
  }
  return aiServiceInstance;
}

export default AIService;
