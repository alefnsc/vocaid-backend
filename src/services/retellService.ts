import Retell from 'retell-sdk';
import { clerkClient } from '@clerk/clerk-sdk-node';

/**
 * Retell Service for managing interview calls
 */

interface RegisterCallBody {
  metadata: {
    first_name: string;
    job_title: string;
    company_name: string;
    job_description: string;
    interviewee_cv: string;
  };
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
   */
  async registerCall(body: RegisterCallBody, userId: string) {
    try {
      console.log('Registering call with Retell for user:', userId);

      // Create web call with custom LLM
      const callResponse = await this.retell.call.createWebCall({
        agent_id: process.env.RETELL_AGENT_ID || '',
        metadata: body.metadata,
        retell_llm_dynamic_variables: {
          first_name: body.metadata.first_name,
          job_title: body.metadata.job_title,
          company_name: body.metadata.company_name
        }
      });

      console.log('Call registered successfully:', callResponse.call_id);

      return {
        call_id: callResponse.call_id,
        access_token: callResponse.access_token,
        status: 'created',
        message: 'Call registered successfully'
      };
    } catch (error: any) {
      console.error('Error registering call:', error);
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
