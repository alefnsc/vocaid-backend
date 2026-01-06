/**
 * Leads Service
 *
 * Lead capture was previously backed by a Prisma `Lead` model.
 * The canonical `prisma/schema.prisma` in this repo does not include that model,
 * so this service is currently a stub.
 */

import logger from '../utils/logger';

const leadsLogger = logger.child({ component: 'leads' });

// ========================================
// INTERFACES
// ========================================

export interface CreateLeadParams {
  name: string;
  email: string;
  company?: string;
  phone?: string;
  type: string;
  source?: string;
  teamSize?: string;
  useCase?: string;
  interestedModules?: string[];
  ipAddress?: string;
  userAgent?: string;
  referrer?: string;
}

export interface LeadResult {
  success: boolean;
  lead?: { id: string };
  error?: string;
  isDuplicate?: boolean;
}

export interface LeadQueryParams {
  type?: string;
  contacted?: boolean;
  limit?: number;
  offset?: number;
}

// ========================================
// LEAD CAPTURE
// ========================================

/**
 * Create a new lead
 * Handles both demo requests and early access signups
 */
export async function createLead(params: CreateLeadParams): Promise<LeadResult> {
  leadsLogger.warn('createLead called but leads are disabled', {
    email: params.email,
    type: params.type,
  });

  return {
    success: false,
    error: 'Leads capture is not available on this deployment.',
  };
}

/**
 * Get leads with optional filtering
 */
export async function getLeads(_params: LeadQueryParams = {}): Promise<any[]> {
  leadsLogger.warn('getLeads called but leads are disabled');
  return [];
}

/**
 * Mark a lead as contacted
 */
export async function markLeadContacted(
  leadId: string,
  notes?: string
): Promise<null> {
  leadsLogger.warn('markLeadContacted called but leads are disabled', { leadId, notes });
  return null;
}

/**
 * Get lead statistics
 */
export async function getLeadStats(): Promise<{
  total: number;
  demoRequests: number;
  earlyAccess: number;
  contacted: number;
  pending: number;
  lastWeek: number;
}> {
  leadsLogger.warn('getLeadStats called but leads are disabled');
  return {
    total: 0,
    demoRequests: 0,
    earlyAccess: 0,
    contacted: 0,
    pending: 0,
    lastWeek: 0,
  };
}

export default {
  createLead,
  getLeads,
  markLeadContacted,
  getLeadStats,
};
