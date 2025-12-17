/**
 * Multilingual Retell Service
 * 
 * Extends the base Retell service to support multiple languages.
 * Selects appropriate agent/voice based on user's language preferences.
 * 
 * Key features:
 * - Language-specific agent selection
 * - Voice ID mapping for accurate TTS accents
 * - Dynamic variable injection with language context
 * - Performance optimizations for real-time voice interaction
 * 
 * @module services/multilingualRetellService
 */

import Retell from 'retell-sdk';
import { clerkClient } from '@clerk/express';
import { wsLogger } from '../utils/logger';
import {
  SupportedLanguageCode,
  MultilingualRetellCallParams,
  RetellLanguageConfig,
  LANGUAGE_CONFIGS,
  getLanguageConfig,
} from '../types/multilingual';
import { getUserPreferences } from './userPreferencesService';

// ========================================
// RETELL LANGUAGE CONFIGURATION
// ========================================

/**
 * Environment-based agent ID mapping
 * Set these in your .env file for each language
 * 
 * Example .env:
 * RETELL_AGENT_ID_PT_BR=agent_xxx
 * RETELL_AGENT_ID_EN_US=agent_yyy
 * RETELL_AGENT_ID_ES_ES=agent_zzz
 */
function getAgentIdForLanguage(language: SupportedLanguageCode): string {
  const envKey = `RETELL_AGENT_ID_${language.replace('-', '_').toUpperCase()}`;
  const agentId = process.env[envKey];
  
  // Fallback chain: specific language -> base language -> default
  if (agentId) return agentId;
  
  // Try base language (e.g., es-MX -> ES -> default)
  const baseKey = `RETELL_AGENT_ID_${language.split('-')[0].toUpperCase()}`;
  const baseAgentId = process.env[baseKey];
  if (baseAgentId) return baseAgentId;
  
  // Final fallback to default agent
  return process.env.RETELL_AGENT_ID || '';
}

/**
 * Get voice ID for language (for TTS accent accuracy)
 * Retell supports different voices with native accents
 */
function getVoiceIdForLanguage(language: SupportedLanguageCode): string | undefined {
  const envKey = `RETELL_VOICE_ID_${language.replace('-', '_').toUpperCase()}`;
  return process.env[envKey];
}

/**
 * Language-specific response delay adjustments
 * Some languages may need more processing time
 */
const LANGUAGE_RESPONSE_DELAYS: Partial<Record<SupportedLanguageCode, number>> = {
  'zh-CN': 200,  // Chinese may need more parsing time
  'zh-TW': 200,
  'hi-IN': 150,  // Hindi with mixed English
  'ru-RU': 100,  // Cyrillic processing
};

// ========================================
// MULTILINGUAL RETELL SERVICE CLASS
// ========================================

export class MultilingualRetellService {
  private retell: Retell;
  private customLLMWebSocketUrl: string;

  constructor(apiKey: string) {
    this.retell = new Retell({
      apiKey: apiKey,
    });

    // WebSocket URL for custom LLM
    const baseUrl = process.env.WEBHOOK_BASE_URL || 'http://localhost:3001';
    this.customLLMWebSocketUrl = baseUrl
      .replace('http://', 'ws://')
      .replace('https://', 'wss://') + '/llm-websocket/{call_id}';
  }

  /**
   * Register a multilingual call with Retell
   * Fetches user's language preference from Clerk and configures accordingly
   */
  async registerMultilingualCall(params: MultilingualRetellCallParams) {
    const { userId, language, metadata } = params;

    wsLogger.info('Registering multilingual call', {
      userId,
      language,
      jobTitle: metadata.job_title,
    });

    try {
      // Get language-specific configuration
      const agentId = getAgentIdForLanguage(language);
      const voiceId = getVoiceIdForLanguage(language);
      const languageConfig = getLanguageConfig(language);

      if (!agentId) {
        throw new Error(`No Retell agent configured for language: ${language}`);
      }

      // Build dynamic variables with language context
      const dynamicVariables: Record<string, string> = {
        first_name: metadata.first_name,
        job_title: metadata.job_title,
        company_name: metadata.company_name,
        preferred_language: language,
        language_name: languageConfig.englishName,
        language_native_name: languageConfig.name,
      };

      // Create web call with language-specific agent
      const callParams: any = {
        agent_id: agentId,
        metadata: {
          ...metadata,
          preferred_language: language,
          language_config: {
            code: language,
            name: languageConfig.name,
            rtl: languageConfig.rtl,
          },
        },
        retell_llm_dynamic_variables: dynamicVariables,
      };

      // Add voice override if specified
      if (voiceId) {
        callParams.voice_id = voiceId;
      }

      const callResponse = await this.retell.call.createWebCall(callParams);

      wsLogger.info('Multilingual call registered successfully', {
        callId: callResponse.call_id,
        language,
        agentId,
      });

      return {
        call_id: callResponse.call_id,
        access_token: callResponse.access_token,
        status: 'created',
        message: 'Multilingual call registered successfully',
        language: {
          code: language,
          name: languageConfig.name,
          englishName: languageConfig.englishName,
        },
      };
    } catch (error: any) {
      wsLogger.error('Error registering multilingual call', {
        userId,
        language,
        error: error.message,
      });
      throw new Error(`Failed to register multilingual call: ${error.message}`);
    }
  }

  /**
   * Register a call with automatic language detection from user profile
   */
  async registerCallWithAutoLanguage(
    userId: string,
    metadata: Omit<MultilingualRetellCallParams['metadata'], 'preferred_language'>
  ) {
    wsLogger.info('Registering call with auto language detection', { userId });

    try {
      // Get user's language preference from Clerk
      const preferences = await getUserPreferences(userId);
      const language = preferences?.language || 'en-US';

      return await this.registerMultilingualCall({
        userId,
        language,
        metadata: {
          ...metadata,
          preferred_language: language,
        },
      });
    } catch (error: any) {
      wsLogger.error('Error in auto-language call registration', {
        userId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get language-specific configuration for a call
   */
  getLanguageConfig(language: SupportedLanguageCode): RetellLanguageConfig {
    return {
      language,
      agentId: getAgentIdForLanguage(language),
      voiceId: getVoiceIdForLanguage(language),
      responseDelayMs: LANGUAGE_RESPONSE_DELAYS[language] || 0,
    };
  }

  /**
   * Get all configured languages with their agents
   */
  getConfiguredLanguages(): SupportedLanguageCode[] {
    return (Object.keys(LANGUAGE_CONFIGS) as SupportedLanguageCode[]).filter(
      (lang) => {
        const agentId = getAgentIdForLanguage(lang);
        return !!agentId && agentId !== process.env.RETELL_AGENT_ID;
      }
    );
  }

  /**
   * Check if a language has dedicated agent configuration
   */
  hasLanguageSupport(language: SupportedLanguageCode): boolean {
    const agentId = getAgentIdForLanguage(language);
    return !!agentId;
  }

  /**
   * Get call details
   */
  async getCall(callId: string) {
    try {
      const call = await this.retell.call.retrieve(callId);
      return call;
    } catch (error: any) {
      wsLogger.error('Error retrieving call', { callId, error: error.message });
      throw new Error(`Failed to retrieve call: ${error.message}`);
    }
  }

  /**
   * List calls with optional filtering
   */
  async listCalls(filterCriteria?: any) {
    try {
      const calls = await this.retell.call.list(filterCriteria);
      return calls;
    } catch (error: any) {
      wsLogger.error('Error listing calls', { error: error.message });
      throw new Error(`Failed to list calls: ${error.message}`);
    }
  }

  /**
   * Get custom LLM WebSocket URL
   */
  getCustomLLMWebSocketUrl(): string {
    return this.customLLMWebSocketUrl;
  }
}

// ========================================
// SINGLETON INSTANCE
// ========================================

let multilingualRetellServiceInstance: MultilingualRetellService | null = null;

export function getMultilingualRetellService(): MultilingualRetellService {
  if (!multilingualRetellServiceInstance) {
    const apiKey = process.env.RETELL_API_KEY;
    if (!apiKey) {
      throw new Error('RETELL_API_KEY environment variable is required');
    }
    multilingualRetellServiceInstance = new MultilingualRetellService(apiKey);
  }
  return multilingualRetellServiceInstance;
}

// ========================================
// LANGUAGE DETECTION UTILITIES
// ========================================

/**
 * Detect language from transcript content
 * Useful for real-time language switching during calls
 */
export function detectLanguageFromText(text: string): SupportedLanguageCode | null {
  // Simple heuristic-based detection
  // In production, use a proper language detection library
  
  const patterns: Array<{ pattern: RegExp; language: SupportedLanguageCode }> = [
    { pattern: /[\u4e00-\u9fff]/, language: 'zh-CN' },           // Chinese characters
    { pattern: /[\u0400-\u04FF]/, language: 'ru-RU' },           // Cyrillic
    { pattern: /[\u0900-\u097F]/, language: 'hi-IN' },           // Devanagari (Hindi)
    { pattern: /\b(você|obrigado|não|sim|está)\b/i, language: 'pt-BR' },
    { pattern: /\b(usted|gracias|muy|está|cómo)\b/i, language: 'es-ES' },
    { pattern: /\b(vous|merci|très|c'est|comment)\b/i, language: 'fr-FR' },
  ];
  
  for (const { pattern, language } of patterns) {
    if (pattern.test(text)) {
      return language;
    }
  }
  
  return null;
}

/**
 * Get language instructions for the LLM
 */
export function getLanguageInstructions(language: SupportedLanguageCode): string {
  const config = getLanguageConfig(language);
  
  return `
<language_context>
  <code>${language}</code>
  <name>${config.name}</name>
  <english_name>${config.englishName}</english_name>
  <is_rtl>${config.rtl}</is_rtl>
</language_context>

<language_instructions>
  You MUST conduct this entire interview in ${config.name} (${config.englishName}).
  - All questions, responses, and feedback must be in ${config.name}
  - Use culturally appropriate expressions and idioms
  - Maintain professional yet natural conversational tone
  - If the candidate switches to another language, gently redirect them back to ${config.name}
  - Do NOT mix languages unless specifically quoting technical terms
</language_instructions>
`.trim();
}

export default MultilingualRetellService;
