/**
 * Multilingual Retell Service
 * 
 * Extends the base Retell service to support multiple languages.
 * Uses a SINGLE multilingual Retell agent for most languages,
 * with language-specific configuration injected via Custom LLM.
 * 
 * Architecture:
 * - Single multilingual agent (RETELL_AGENT_ID) for: PT, EN, ES, FR, RU, HI
 * - Separate Chinese agent (RETELL_AGENT_ID_ZH) for: ZH-CN, ZH-TW
 * - Language context is passed to Custom LLM WebSocket for prompt injection
 * 
 * Key features:
 * - Language-aware agent selection
 * - Voice ID mapping for accurate TTS accents
 * - Dynamic variable injection with language context
 * - Custom LLM prompt localization
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
// LANGUAGE CONFIGURATION
// ========================================

/**
 * Languages supported by the main multilingual agent
 * These all share the same RETELL_AGENT_ID and differentiate via Custom LLM prompts
 */
const MULTILINGUAL_AGENT_LANGUAGES: SupportedLanguageCode[] = [
  'pt-BR',
  'en-US',
  'en-GB',
  'es-ES',
  'es-MX',
  'es-AR',
  'fr-FR',
  'ru-RU',
  'hi-IN',
];

/**
 * Languages that require a separate agent (e.g., Chinese)
 * These use RETELL_AGENT_ID_ZH or similar language-specific agents
 */
const SEPARATE_AGENT_LANGUAGES: SupportedLanguageCode[] = [
  'zh-CN',
  'zh-TW',
];

/**
 * Check if language uses the main multilingual agent
 */
export function usesMultilingualAgent(language: SupportedLanguageCode): boolean {
  return MULTILINGUAL_AGENT_LANGUAGES.includes(language);
}

/**
 * Check if language requires a separate dedicated agent
 */
export function requiresSeparateAgent(language: SupportedLanguageCode): boolean {
  return SEPARATE_AGENT_LANGUAGES.includes(language);
}

/**
 * Get the appropriate agent ID for a language
 * 
 * Logic:
 * 1. Chinese languages (zh-CN, zh-TW) → RETELL_AGENT_ID_ZH
 * 2. All other supported languages → RETELL_AGENT_ID (main multilingual agent)
 */
function getAgentIdForLanguage(language: SupportedLanguageCode): string {
  // Chinese requires separate agent
  if (requiresSeparateAgent(language)) {
    // Try language-specific agent first (zh-CN or zh-TW)
    const specificEnvKey = `RETELL_AGENT_ID_${language.replace('-', '_').toUpperCase()}`;
    const specificAgentId = process.env[specificEnvKey];
    if (specificAgentId) return specificAgentId;
    
    // Fallback to general Chinese agent
    const chineseAgentId = process.env.RETELL_AGENT_ID_ZH;
    if (chineseAgentId) return chineseAgentId;
    
    wsLogger.warn('No Chinese agent configured, falling back to main agent', { language });
  }
  
  // All other languages use the main multilingual agent
  const mainAgentId = process.env.RETELL_AGENT_ID;
  if (!mainAgentId) {
    throw new Error('RETELL_AGENT_ID environment variable is required');
  }
  
  return mainAgentId;
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
   * 
   * For multilingual agent languages: passes language context to Custom LLM
   * For Chinese: uses dedicated Chinese agent
   */
  async registerMultilingualCall(params: MultilingualRetellCallParams) {
    const { userId, language, metadata } = params;

    const isMultilingual = usesMultilingualAgent(language);
    const languageConfig = getLanguageConfig(language);

    wsLogger.info('Registering multilingual call', {
      userId,
      language,
      isMultilingualAgent: isMultilingual,
      jobTitle: metadata.job_title,
    });

    try {
      // Get agent ID based on language type
      const agentId = getAgentIdForLanguage(language);
      const voiceId = getVoiceIdForLanguage(language);

      if (!agentId) {
        throw new Error(`No Retell agent configured for language: ${language}`);
      }

      // Build dynamic variables with comprehensive language context
      // These are passed to the Custom LLM WebSocket for prompt injection
      const dynamicVariables: Record<string, string> = {
        // User info
        first_name: metadata.first_name,
        job_title: metadata.job_title,
        company_name: metadata.company_name,
        
        // Language context (critical for Custom LLM prompt building)
        preferred_language: language,
        language_code: language,
        language_name: languageConfig.englishName,
        language_native_name: languageConfig.name,
        language_base_code: languageConfig.baseCode,
        is_rtl: String(languageConfig.rtl),
        
        // Agent type indicator
        uses_multilingual_agent: String(isMultilingual),
      };

      // Create web call with language context in metadata
      // The Custom LLM WebSocket will use this for prompt localization
      const callParams: any = {
        agent_id: agentId,
        metadata: {
          ...metadata,
          // Language configuration for Custom LLM
          preferred_language: language,
          language_config: {
            code: language,
            name: languageConfig.name,
            englishName: languageConfig.englishName,
            baseCode: languageConfig.baseCode,
            rtl: languageConfig.rtl,
            flag: languageConfig.flag,
          },
          // Indicate if this is the multilingual agent (for prompt building)
          uses_multilingual_agent: isMultilingual,
        },
        retell_llm_dynamic_variables: dynamicVariables,
      };

      // Add voice override if specified (for native accent TTS)
      if (voiceId) {
        callParams.voice_id = voiceId;
      }

      const callResponse = await this.retell.call.createWebCall(callParams);

      wsLogger.info('Multilingual call registered successfully', {
        callId: callResponse.call_id,
        language,
        agentId,
        isMultilingualAgent: isMultilingual,
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
   * Get all supported languages
   * Returns all languages that have agent support:
   * - Multilingual agent languages (PT, EN, ES, FR, RU, HI) if main agent configured
   * - Chinese languages if Chinese agent configured
   */
  getConfiguredLanguages(): SupportedLanguageCode[] {
    const configuredLanguages: SupportedLanguageCode[] = [];
    
    // Check if main multilingual agent is configured
    const mainAgentId = process.env.RETELL_AGENT_ID;
    if (mainAgentId) {
      configuredLanguages.push(...MULTILINGUAL_AGENT_LANGUAGES);
    }
    
    // Check if Chinese agent is configured
    const chineseAgentId = process.env.RETELL_AGENT_ID_ZH || 
                           process.env.RETELL_AGENT_ID_ZH_CN || 
                           process.env.RETELL_AGENT_ID_ZH_TW;
    if (chineseAgentId) {
      configuredLanguages.push(...SEPARATE_AGENT_LANGUAGES);
    }
    
    return configuredLanguages;
  }

  /**
   * Check if a language is supported
   * A language is supported if its agent is configured
   */
  hasLanguageSupport(language: SupportedLanguageCode): boolean {
    if (usesMultilingualAgent(language)) {
      return !!process.env.RETELL_AGENT_ID;
    }
    if (requiresSeparateAgent(language)) {
      return !!(process.env.RETELL_AGENT_ID_ZH || 
                process.env[`RETELL_AGENT_ID_${language.replace('-', '_').toUpperCase()}`]);
    }
    return false;
  }

  /**
   * Get language support status summary
   */
  getLanguageSupportStatus(): { 
    multilingualAgentConfigured: boolean;
    chineseAgentConfigured: boolean;
    supportedLanguages: SupportedLanguageCode[];
    unsupportedLanguages: SupportedLanguageCode[];
  } {
    const multilingualAgentConfigured = !!process.env.RETELL_AGENT_ID;
    const chineseAgentConfigured = !!(process.env.RETELL_AGENT_ID_ZH || 
                                       process.env.RETELL_AGENT_ID_ZH_CN);
    
    const allLanguages = Object.keys(LANGUAGE_CONFIGS) as SupportedLanguageCode[];
    const supportedLanguages = this.getConfiguredLanguages();
    const unsupportedLanguages = allLanguages.filter(
      lang => !supportedLanguages.includes(lang)
    );
    
    return {
      multilingualAgentConfigured,
      chineseAgentConfigured,
      supportedLanguages,
      unsupportedLanguages,
    };
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
