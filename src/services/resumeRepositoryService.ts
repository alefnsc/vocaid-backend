/**
 * Resume Repository Service
 * 
 * Centralized library for managing user resumes with version control.
 * Allows users to store, organize, and reuse their resumes across interviews.
 * 
 * Features:
 * - Resume storage and retrieval
 * - Version history tracking
 * - Resume tagging and organization
 * - Auto-parsing for metadata extraction
 * - Resume quality scoring integration
 * 
 * @module services/resumeRepositoryService
 */

import logger from '../utils/logger';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Create resume repository logger
const resumeLogger = logger.child({ component: 'resume-repository' });

// ========================================
// INTERFACES
// ========================================

export interface ResumeDocument {
  id: string;
  userId: string;
  
  // File data
  fileName: string;
  mimeType: string;
  fileSize: number;
  base64Data: string;
  
  // Metadata
  title: string;
  description?: string;
  tags: string[];
  
  // Parsed content
  parsedText?: string;
  parsedMetadata?: ResumeMetadata;
  
  // Version info
  version: number;
  parentVersionId?: string;
  isLatest: boolean;
  
  // Quality score
  qualityScore?: number;
  
  // Status
  isActive: boolean;
  isPrimary: boolean;
  
  // Timestamps
  createdAt: Date;
  updatedAt: Date;
}

export interface ResumeMetadata {
  candidateName?: string;
  email?: string;
  phone?: string;
  location?: string;
  
  // Professional info
  currentTitle?: string;
  yearsOfExperience?: number;
  skills: string[];
  
  // Education
  education: Array<{
    institution: string;
    degree?: string;
    field?: string;
    year?: number;
  }>;
  
  // Experience
  experience: Array<{
    company: string;
    title: string;
    duration?: string;
    highlights: string[];
  }>;
  
  // Additional
  certifications: string[];
  languages: string[];
}

export interface CreateResumeInput {
  fileName: string;
  mimeType: string;
  base64Data: string;
  title?: string;
  description?: string;
  tags?: string[];
  isPrimary?: boolean;
}

export interface UpdateResumeInput {
  title?: string;
  description?: string;
  tags?: string[];
  isPrimary?: boolean;
}

export interface ResumeListItem {
  id: string;
  title: string;
  fileName: string;
  fileSize: number;
  version: number;
  qualityScore?: number;
  isPrimary: boolean;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
  usageCount: number;
}

export interface ResumeVersion {
  id: string;
  version: number;
  createdAt: Date;
  fileName: string;
  fileSize: number;
  qualityScore?: number;
}

// ========================================
// CONFIGURATION
// ========================================

// Maximum resumes per user (checked via quota service)
const MAX_RESUME_SIZE_MB = 5;
const MAX_RESUME_SIZE_BYTES = MAX_RESUME_SIZE_MB * 1024 * 1024;

// Supported file types
const SUPPORTED_MIME_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain'
];

// ========================================
// VALIDATION
// ========================================

/**
 * Validate resume file before storage
 */
export function validateResumeFile(
  base64Data: string,
  mimeType: string
): { valid: boolean; error?: string } {
  // Check mime type
  if (!SUPPORTED_MIME_TYPES.includes(mimeType)) {
    return { 
      valid: false, 
      error: `Unsupported file type. Supported: PDF, DOC, DOCX, TXT` 
    };
  }
  
  // Check file size (estimate from base64)
  const sizeEstimate = Math.ceil((base64Data.length * 3) / 4);
  if (sizeEstimate > MAX_RESUME_SIZE_BYTES) {
    return { 
      valid: false, 
      error: `File too large. Maximum size: ${MAX_RESUME_SIZE_MB}MB` 
    };
  }
  
  return { valid: true };
}

/**
 * Calculate file size from base64
 */
function calculateFileSize(base64Data: string): number {
  // Remove data URL prefix if present
  const cleanBase64 = base64Data.replace(/^data:.*?;base64,/, '');
  // Estimate actual byte size
  return Math.ceil((cleanBase64.length * 3) / 4);
}

// ========================================
// RESUME CRUD OPERATIONS
// ========================================

/**
 * Create a new resume in the repository
 */
export async function createResume(
  userId: string,
  input: CreateResumeInput
): Promise<ResumeDocument | null> {
  try {
    // Get user
    const user = await prisma.user.findUnique({
      where: { clerkId: userId },
      select: { id: true }
    });
    
    if (!user) {
      resumeLogger.error('User not found', { userId });
      return null;
    }
    
    // Validate file
    const validation = validateResumeFile(input.base64Data, input.mimeType);
    if (!validation.valid) {
      resumeLogger.warn('Invalid resume file', { userId, error: validation.error });
      return null;
    }
    
    // If setting as primary, unset current primary first
    if (input.isPrimary) {
      await prisma.resumeDocument?.updateMany({
        where: { userId: user.id, isPrimary: true },
        data: { isPrimary: false }
      });
    }
    
    // Calculate file size
    const fileSize = calculateFileSize(input.base64Data);
    
    // Create the resume document
    const resume = await prisma.resumeDocument?.create({
      data: {
        userId: user.id,
        fileName: input.fileName,
        mimeType: input.mimeType,
        fileSize,
        base64Data: input.base64Data,
        title: input.title || input.fileName.replace(/\.[^/.]+$/, ''),
        description: input.description,
        tags: input.tags || [],
        version: 1,
        isLatest: true,
        isActive: true,
        isPrimary: input.isPrimary || false
      }
    });
    
    resumeLogger.info('Resume created', { 
      userId, 
      resumeId: resume?.id,
      fileName: input.fileName 
    });
    
    return resume as unknown as ResumeDocument;
  } catch (error: any) {
    resumeLogger.error('Failed to create resume', { error: error.message });
    return null;
  }
}

/**
 * Get all resumes for a user
 */
export async function getResumes(userId: string): Promise<ResumeListItem[]> {
  try {
    const user = await prisma.user.findUnique({
      where: { clerkId: userId },
      select: { id: true }
    });
    
    if (!user) return [];
    
    const resumes = await prisma.resumeDocument?.findMany({
      where: { 
        userId: user.id,
        isActive: true,
        isLatest: true
      },
      select: {
        id: true,
        title: true,
        fileName: true,
        fileSize: true,
        version: true,
        qualityScore: true,
        isPrimary: true,
        tags: true,
        createdAt: true,
        updatedAt: true
      },
      orderBy: [
        { isPrimary: 'desc' },
        { updatedAt: 'desc' }
      ]
    });
    
    // Count usage (interviews using this resume)
    const resumesWithUsage = await Promise.all(
      (resumes || []).map(async (resume: any) => {
        const usageCount = await prisma.interview.count({
          where: { 
            userId: user.id,
            resumeFileName: resume.fileName
          }
        });
        
        return {
          ...resume,
          usageCount
        };
      })
    );
    
    return resumesWithUsage as ResumeListItem[];
  } catch (error: any) {
    resumeLogger.error('Failed to get resumes', { error: error.message });
    return [];
  }
}

/**
 * Get a specific resume by ID
 */
export async function getResumeById(
  userId: string,
  resumeId: string,
  includeData: boolean = false
): Promise<ResumeDocument | null> {
  try {
    const user = await prisma.user.findUnique({
      where: { clerkId: userId },
      select: { id: true }
    });
    
    if (!user) return null;
    
    const resume = await prisma.resumeDocument?.findFirst({
      where: { 
        id: resumeId,
        userId: user.id,
        isActive: true
      },
      select: {
        id: true,
        userId: true,
        fileName: true,
        mimeType: true,
        fileSize: true,
        base64Data: includeData,
        title: true,
        description: true,
        tags: true,
        parsedText: includeData,
        parsedMetadata: true,
        version: true,
        parentVersionId: true,
        isLatest: true,
        qualityScore: true,
        isActive: true,
        isPrimary: true,
        createdAt: true,
        updatedAt: true
      }
    });
    
    return resume as unknown as ResumeDocument;
  } catch (error: any) {
    resumeLogger.error('Failed to get resume', { error: error.message });
    return null;
  }
}

/**
 * Get primary resume for a user
 */
export async function getPrimaryResume(
  userId: string,
  includeData: boolean = false
): Promise<ResumeDocument | null> {
  try {
    const user = await prisma.user.findUnique({
      where: { clerkId: userId },
      select: { id: true }
    });
    
    if (!user) return null;
    
    const resume = await prisma.resumeDocument?.findFirst({
      where: { 
        userId: user.id,
        isPrimary: true,
        isActive: true
      },
      select: {
        id: true,
        userId: true,
        fileName: true,
        mimeType: true,
        fileSize: true,
        base64Data: includeData,
        title: true,
        description: true,
        tags: true,
        parsedText: includeData,
        parsedMetadata: true,
        version: true,
        isLatest: true,
        qualityScore: true,
        isActive: true,
        isPrimary: true,
        createdAt: true,
        updatedAt: true
      }
    });
    
    return resume as unknown as ResumeDocument;
  } catch (error: any) {
    resumeLogger.error('Failed to get primary resume', { error: error.message });
    return null;
  }
}

/**
 * Update resume metadata
 */
export async function updateResume(
  userId: string,
  resumeId: string,
  input: UpdateResumeInput
): Promise<ResumeDocument | null> {
  try {
    const user = await prisma.user.findUnique({
      where: { clerkId: userId },
      select: { id: true }
    });
    
    if (!user) return null;
    
    // If setting as primary, unset current primary first
    if (input.isPrimary) {
      await prisma.resumeDocument?.updateMany({
        where: { userId: user.id, isPrimary: true },
        data: { isPrimary: false }
      });
    }
    
    const resume = await prisma.resumeDocument?.update({
      where: { 
        id: resumeId,
        userId: user.id
      },
      data: {
        title: input.title,
        description: input.description,
        tags: input.tags,
        isPrimary: input.isPrimary,
        updatedAt: new Date()
      }
    });
    
    resumeLogger.info('Resume updated', { userId, resumeId });
    
    return resume as unknown as ResumeDocument;
  } catch (error: any) {
    resumeLogger.error('Failed to update resume', { error: error.message });
    return null;
  }
}

/**
 * Create a new version of an existing resume
 */
export async function createResumeVersion(
  userId: string,
  resumeId: string,
  newFileData: {
    fileName: string;
    mimeType: string;
    base64Data: string;
  }
): Promise<ResumeDocument | null> {
  try {
    const user = await prisma.user.findUnique({
      where: { clerkId: userId },
      select: { id: true }
    });
    
    if (!user) return null;
    
    // Get current resume
    const currentResume = await prisma.resumeDocument?.findFirst({
      where: { 
        id: resumeId,
        userId: user.id,
        isActive: true
      }
    });
    
    if (!currentResume) return null;
    
    // Validate new file
    const validation = validateResumeFile(newFileData.base64Data, newFileData.mimeType);
    if (!validation.valid) {
      resumeLogger.warn('Invalid resume file for version', { userId, error: validation.error });
      return null;
    }
    
    // Mark current version as not latest
    await prisma.resumeDocument?.update({
      where: { id: resumeId },
      data: { isLatest: false }
    });
    
    // Create new version
    const fileSize = calculateFileSize(newFileData.base64Data);
    
    const newVersion = await prisma.resumeDocument?.create({
      data: {
        userId: user.id,
        fileName: newFileData.fileName,
        mimeType: newFileData.mimeType,
        fileSize,
        base64Data: newFileData.base64Data,
        title: (currentResume as any).title,
        description: (currentResume as any).description,
        tags: (currentResume as any).tags || [],
        version: (currentResume as any).version + 1,
        parentVersionId: resumeId,
        isLatest: true,
        isActive: true,
        isPrimary: (currentResume as any).isPrimary
      }
    });
    
    // If was primary, update to new version
    if ((currentResume as any).isPrimary) {
      await prisma.resumeDocument?.update({
        where: { id: resumeId },
        data: { isPrimary: false }
      });
    }
    
    resumeLogger.info('Resume version created', { 
      userId, 
      resumeId,
      newVersion: (newVersion as any)?.version
    });
    
    return newVersion as unknown as ResumeDocument;
  } catch (error: any) {
    resumeLogger.error('Failed to create resume version', { error: error.message });
    return null;
  }
}

/**
 * Get version history for a resume
 */
export async function getResumeVersionHistory(
  userId: string,
  resumeId: string
): Promise<ResumeVersion[]> {
  try {
    const user = await prisma.user.findUnique({
      where: { clerkId: userId },
      select: { id: true }
    });
    
    if (!user) return [];
    
    // Get the root resume (earliest version)
    const resume = await prisma.resumeDocument?.findFirst({
      where: { 
        id: resumeId,
        userId: user.id
      }
    });
    
    if (!resume) return [];
    
    // Find all versions (follow parentVersionId chain)
    const versions: ResumeVersion[] = [];
    let currentId: string | null = resumeId;
    
    while (currentId) {
      const versionResult: {
        id: string;
        version: number;
        createdAt: Date;
        fileName: string;
        fileSize: number;
        qualityScore: number | null;
        parentVersionId: string | null;
      } | null = await prisma.resumeDocument.findFirst({
        where: { 
          id: currentId,
          userId: user.id
        },
        select: {
          id: true,
          version: true,
          createdAt: true,
          fileName: true,
          fileSize: true,
          qualityScore: true,
          parentVersionId: true
        }
      });
      
      if (versionResult) {
        versions.push({
          id: versionResult.id,
          version: versionResult.version,
          createdAt: versionResult.createdAt,
          fileName: versionResult.fileName,
          fileSize: versionResult.fileSize,
          qualityScore: versionResult.qualityScore || undefined
        });
        currentId = versionResult.parentVersionId;
      } else {
        break;
      }
    }
    
    // Also get any newer versions
    const newerVersions = await prisma.resumeDocument?.findMany({
      where: {
        parentVersionId: resumeId,
        userId: user.id
      },
      select: {
        id: true,
        version: true,
        createdAt: true,
        fileName: true,
        fileSize: true,
        qualityScore: true
      }
    });
    
    (newerVersions || []).forEach((v: any) => {
      if (!versions.find(ver => ver.id === v.id)) {
        versions.push({
          id: v.id,
          version: v.version,
          createdAt: v.createdAt,
          fileName: v.fileName,
          fileSize: v.fileSize,
          qualityScore: v.qualityScore
        });
      }
    });
    
    // Sort by version number
    return versions.sort((a, b) => b.version - a.version);
  } catch (error: any) {
    resumeLogger.error('Failed to get version history', { error: error.message });
    return [];
  }
}

/**
 * Delete a resume (soft delete)
 */
export async function deleteResume(
  userId: string,
  resumeId: string
): Promise<boolean> {
  try {
    const user = await prisma.user.findUnique({
      where: { clerkId: userId },
      select: { id: true }
    });
    
    if (!user) return false;
    
    const resume = await prisma.resumeDocument?.update({
      where: { 
        id: resumeId,
        userId: user.id
      },
      data: {
        isActive: false,
        isPrimary: false,
        updatedAt: new Date()
      }
    });
    
    resumeLogger.info('Resume deleted', { userId, resumeId });
    
    return !!resume;
  } catch (error: any) {
    resumeLogger.error('Failed to delete resume', { error: error.message });
    return false;
  }
}

/**
 * Set a resume as primary
 */
export async function setPrimaryResume(
  userId: string,
  resumeId: string
): Promise<boolean> {
  try {
    const user = await prisma.user.findUnique({
      where: { clerkId: userId },
      select: { id: true }
    });
    
    if (!user) return false;
    
    // Unset current primary
    await prisma.resumeDocument?.updateMany({
      where: { userId: user.id, isPrimary: true },
      data: { isPrimary: false }
    });
    
    // Set new primary
    await prisma.resumeDocument?.update({
      where: { 
        id: resumeId,
        userId: user.id
      },
      data: { isPrimary: true }
    });
    
    resumeLogger.info('Primary resume set', { userId, resumeId });
    
    return true;
  } catch (error: any) {
    resumeLogger.error('Failed to set primary resume', { error: error.message });
    return false;
  }
}

/**
 * Search resumes by tags or title
 */
export async function searchResumes(
  userId: string,
  query: string,
  tags?: string[]
): Promise<ResumeListItem[]> {
  try {
    const user = await prisma.user.findUnique({
      where: { clerkId: userId },
      select: { id: true }
    });
    
    if (!user) return [];
    
    const whereClause: any = {
      userId: user.id,
      isActive: true,
      isLatest: true
    };
    
    // Add search conditions
    if (query) {
      whereClause.OR = [
        { title: { contains: query, mode: 'insensitive' } },
        { description: { contains: query, mode: 'insensitive' } },
        { fileName: { contains: query, mode: 'insensitive' } }
      ];
    }
    
    if (tags && tags.length > 0) {
      whereClause.tags = { hasSome: tags };
    }
    
    const resumes = await prisma.resumeDocument?.findMany({
      where: whereClause,
      select: {
        id: true,
        title: true,
        fileName: true,
        fileSize: true,
        version: true,
        qualityScore: true,
        isPrimary: true,
        tags: true,
        createdAt: true,
        updatedAt: true
      },
      orderBy: { updatedAt: 'desc' }
    });
    
    return (resumes || []).map((r: any) => ({
      ...r,
      usageCount: 0 // Would need another query to get actual count
    })) as ResumeListItem[];
  } catch (error: any) {
    resumeLogger.error('Failed to search resumes', { error: error.message });
    return [];
  }
}

/**
 * Update resume quality score
 */
export async function updateQualityScore(
  resumeId: string,
  qualityScore: number
): Promise<boolean> {
  try {
    await prisma.resumeDocument?.update({
      where: { id: resumeId },
      data: { qualityScore }
    });
    
    return true;
  } catch (error: any) {
    resumeLogger.error('Failed to update quality score', { error: error.message });
    return false;
  }
}

/**
 * Store parsed text and metadata for a resume
 */
export async function storeParsedContent(
  resumeId: string,
  parsedText: string,
  parsedMetadata: ResumeMetadata
): Promise<boolean> {
  try {
    await prisma.resumeDocument?.update({
      where: { id: resumeId },
      data: { 
        parsedText,
        parsedMetadata: parsedMetadata as any
      }
    });
    
    return true;
  } catch (error: any) {
    resumeLogger.error('Failed to store parsed content', { error: error.message });
    return false;
  }
}

// ========================================
// EXPORTS
// ========================================

export default {
  validateResumeFile,
  createResume,
  getResumes,
  getResumeById,
  getPrimaryResume,
  updateResume,
  createResumeVersion,
  getResumeVersionHistory,
  deleteResume,
  setPrimaryResume,
  searchResumes,
  updateQualityScore,
  storeParsedContent
};
