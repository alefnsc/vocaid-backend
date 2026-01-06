import Retell from 'retell-sdk';

/**
 * Retell Service for managing interview calls
 * 
 * Supports multilingual agent switching:
 * - Chinese (zh-CN) → uses RETELL_AGENT_ID_ZH
 * - All other languages → uses RETELL_AGENT_ID (main multilingual agent)
 */

interface RegisterCallBody {
  metadata: {
    first_name: string;
    last_name?: string;
    job_title: string;
    seniority?: string; // Candidate seniority level: intern, junior, mid, senior, staff, principal
    company_name: string;
    job_description: string;
    // Resume is fetched server-side from Azure Blob via interview_id -> ResumeDocument.storageKey
    interview_id: string; // Required: Used to fetch resume from database
    preferred_language?: string; // Language code for agent switching
  };
}

/**
 * Get the appropriate agent ID based on language
 * Chinese Mandarin (zh-CN) uses a separate agent
 */
function getAgentIdForLanguage(language?: string): string {
  // Chinese Mandarin requires separate agent
  if (language === 'zh-CN') {
    const chineseAgentId = process.env.RETELL_AGENT_ID_ZH;
    if (chineseAgentId) {
      console.log('🇨🇳 Using Chinese Mandarin agent:', chineseAgentId);
      return chineseAgentId;
    }
    console.warn('⚠️ No Chinese agent configured, falling back to main agent');
  }
  
  // All other languages use the main multilingual agent
  const mainAgentId = process.env.RETELL_AGENT_ID || '';
  console.log('🌐 Using main multilingual agent:', mainAgentId);
  return mainAgentId;
}

export class RetellService {
  private retell: Retell;
  private customLLMWebSocketUrl: string;

  constructor(apiKey: string) {
    this.retell = new Retell({
      apiKey: apiKey
    });
    
    // WebSocket URL for custom LLM
    const baseUrl = process.env.WEBHOOK_BASE_URL || 'http://localhost:3001';
    this.customLLMWebSocketUrl = baseUrl.replace('http://', 'ws://').replace('https://', 'wss://') + '/llm-websocket/{call_id}';
  }

  /**
   * Register a new call with Retell
   * Automatically selects the appropriate agent based on preferred_language
   */
  async registerCall(body: RegisterCallBody, userId: string) {
    try {
      const language = body.metadata.preferred_language;
      console.log('📞 Registering call with Retell:', {
        userId,
        language: language || 'auto (en-US)',
        candidate: body.metadata.first_name
      });

      // Select agent based on language
      const agentId = getAgentIdForLanguage(language);

      // Create web call with custom LLM
      const callResponse = await this.retell.call.createWebCall({
        agent_id: agentId,
        metadata: {
          ...body.metadata,
          // Ensure language is in metadata for Custom LLM prompt building
          preferred_language: language || 'en-US'
        },
        retell_llm_dynamic_variables: {
          first_name: body.metadata.first_name,
          job_title: body.metadata.job_title,
          company_name: body.metadata.company_name,
          preferred_language: language || 'en-US'
        }
      });

      console.log('✅ Call registered:', {
        callId: callResponse.call_id,
        agentId,
        language: language || 'en-US'
      });

      return {
        call_id: callResponse.call_id,
        access_token: callResponse.access_token,
        status: 'created',
        message: 'Call registered successfully',
        language: language || 'en-US'
      };
    } catch (error: any) {
      console.error('❌ Error registering call:', error);
      throw new Error(`Failed to register call: ${error.message}`);
    }
  }

  /**
   * Get call details
   */
  async getCall(callId: string) {
    try {
      const call = await this.retell.call.retrieve(callId);
      return call;
    } catch (error: any) {
      console.error('Error retrieving call:', error);
      throw new Error(`Failed to retrieve call: ${error.message}`);
    }
  }

  /**
   * List calls for a user
   */
  async listCalls(filterCriteria?: any) {
    try {
      const calls = await this.retell.call.list(filterCriteria);
      return calls;
    } catch (error: any) {
      console.error('Error listing calls:', error);
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
