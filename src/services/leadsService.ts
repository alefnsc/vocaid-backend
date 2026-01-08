/**
 * Leads Service
 *
 * Lead capture backed by Prisma Lead model.
 * Handles early access signups and demo requests with deduplication.
 * 
 * @module services/leadsService
 */

import { PrismaClient, LeadType, CompanySizeTier } from '@prisma/client';
import logger from '../utils/logger';

const prisma = new PrismaClient();
const leadsLogger = logger.child({ component: 'leads' });

// ========================================
// INTERFACES
// ========================================

export interface CreateLeadParams {
  name: string;
  email: string;
  type: LeadType;
  companyName?: string;
  companySizeTier?: CompanySizeTier;
  phoneE164?: string;
  interestedModules?: string[];
  source?: string;
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
  type?: LeadType;
  contacted?: boolean;
  limit?: number;
  offset?: number;
}

// ========================================
// LEAD CAPTURE
// ========================================

/**
 * Create a new lead
 * Handles both demo requests and early access signups with deduplication.
 */
export async function createLead(params: CreateLeadParams): Promise<LeadResult> {
  const { 
    name, 
    email, 
    type,
    companyName,
    companySizeTier,
    phoneE164,
    interestedModules = [],
    source,
    ipAddress,
    userAgent,
    referrer,
  } = params;

  leadsLogger.info('Creating lead', {
    email,
    type,
    companyName,
    companySizeTier,
    modules: interestedModules,
  });

  try {
    // Upsert to handle duplicates gracefully (update if exists)
    const lead = await prisma.lead.upsert({
      where: {
        type_email: {
          type,
          email: email.toLowerCase().trim(),
        },
      },
      update: {
        name,
        companyName,
        companySizeTier,
        phoneE164,
        interestedModules,
        source,
        ipAddress,
        userAgent,
        referrer,
        updatedAt: new Date(),
      },
      create: {
        type,
        email: email.toLowerCase().trim(),
        name,
        companyName,
        companySizeTier,
        phoneE164,
        interestedModules,
        source,
        ipAddress,
        userAgent,
        referrer,
      },
    });

    leadsLogger.info('Lead created/updated successfully', { 
      leadId: lead.id,
      type,
      email,
    });

    return {
      success: true,
      lead: { id: lead.id },
    };
  } catch (error: any) {
    leadsLogger.error('Failed to create lead', {
      email,
      type,
      error: error.message,
    });

    return {
      success: false,
      error: 'Failed to save lead. Please try again.',
    };
  }
}

/**
 * Get leads with optional filtering
 */
export async function getLeads(params: LeadQueryParams = {}): Promise<any[]> {
  const { type, contacted, limit = 100, offset = 0 } = params;

  try {
    const leads = await prisma.lead.findMany({
      where: {
        ...(type && { type }),
        ...(contacted !== undefined && { contacted }),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    });

    return leads;
  } catch (error: any) {
    leadsLogger.error('Failed to get leads', { error: error.message });
    return [];
  }
}

/**
 * Mark a lead as contacted
 */
export async function markLeadContacted(
  leadId: string,
  notes?: string
): Promise<any | null> {
  try {
    const lead = await prisma.lead.update({
      where: { id: leadId },
      data: {
        contacted: true,
        contactedAt: new Date(),
        contactNotes: notes,
      },
    });

    leadsLogger.info('Lead marked as contacted', { leadId });
    return lead;
  } catch (error: any) {
    leadsLogger.error('Failed to mark lead as contacted', { 
      leadId, 
      error: error.message,
    });
    return null;
  }
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
  try {
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

    const [total, demoRequests, earlyAccess, contacted, lastWeek] = await Promise.all([
      prisma.lead.count(),
      prisma.lead.count({ where: { type: 'DEMO_REQUEST' } }),
      prisma.lead.count({ where: { type: 'EARLY_ACCESS' } }),
      prisma.lead.count({ where: { contacted: true } }),
      prisma.lead.count({ where: { createdAt: { gte: oneWeekAgo } } }),
    ]);

    return {
      total,
      demoRequests,
      earlyAccess,
      contacted,
      pending: total - contacted,
      lastWeek,
    };
  } catch (error: any) {
    leadsLogger.error('Failed to get lead stats', { error: error.message });
    return {
      total: 0,
      demoRequests: 0,
      earlyAccess: 0,
      contacted: 0,
      pending: 0,
      lastWeek: 0,
    };
  }
}

export default {
  createLead,
  getLeads,
  markLeadContacted,
  getLeadStats,
};
