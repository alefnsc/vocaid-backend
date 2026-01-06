/**
 * Resume Routes
 * 
 * API endpoints for resume repository.
 * 
 * Routes:
 * - GET /api/resumes - List user's resumes
 * - POST /api/resumes/upload - Upload new resume
 * - GET /api/resumes/:id - Get resume metadata
 * - GET /api/resumes/:id/download - Download resume file
 * - POST /api/resumes/linkedin - Create resume from LinkedIn data
 * 
 * @module routes/resumeRoutes
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { PrismaClient, ResumeSource } from '@prisma/client';
import logger from '../utils/logger';
import { uploadResume, downloadResume, deleteResume, isAzureBlobEnabled } from '../services/azureBlobService';
import { requireSession } from '../middleware/sessionAuthMiddleware';

const router = Router();
const prisma = new PrismaClient();
const resumeLogger = logger.child({ component: 'resume-routes' });

// ========================================
// VALIDATION SCHEMAS
// ========================================

const uploadResumeSchema = z.object({
  fileName: z.string().min(1).max(255),
  mimeType: z.enum([
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain'
  ]),
  base64Data: z.string().min(1),
  title: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  isPrimary: z.boolean().optional()
});

const updateResumeSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  isPrimary: z.boolean().optional()
});

const linkedInResumeSchema = z.object({
  profileData: z.object({
    name: z.string().optional(),
    email: z.string().email().optional(),
    headline: z.string().optional(),
    summary: z.string().optional(),
    pictureUrl: z.string().url().optional(),
    profileUrl: z.string().url().optional()
  }),
  title: z.string().min(1).max(255).optional()
});

// ========================================
// ROUTES
// ========================================

/**
 * GET /api/resumes
 * List all resumes for the authenticated user
 */
router.get('/', requireSession, async (req: Request, res: Response) => {
  const userId = req.userId!;
  
  try {
    const resumes = await prisma.resumeDocument.findMany({
      where: {
        userId,
        isActive: true,
        isLatest: true
      },
      select: {
        id: true,
        title: true,
        fileName: true,
        fileSize: true,
        mimeType: true,
        source: true,
        linkedInProfileUrl: true,
        version: true,
        qualityScore: true,
        isPrimary: true,
        tags: true,
        createdAt: true,
        updatedAt: true,
        lastUsedAt: true,
        _count: {
          select: { interviews: true }
        }
      },
      orderBy: [
        { isPrimary: 'desc' },
        { updatedAt: 'desc' }
      ]
    });
    
    // Transform to include usage count
    const data = resumes.map(r => ({
      ...r,
      usageCount: r._count.interviews,
      _count: undefined
    }));
    
    resumeLogger.info('Resumes listed', { userId: userId.slice(0, 12), count: data.length });
    
    return res.json({
      status: 'success',
      data
    });
  } catch (error: any) {
    resumeLogger.error('Failed to list resumes', { error: error.message });
    return res.status(500).json({
      status: 'error',
      message: 'Failed to list resumes'
    });
  }
});

/**
 * POST /api/resumes/upload
 * Upload a new resume
 */
router.post('/upload', requireSession, async (req: Request, res: Response) => {
  const userId = req.userId!;
  
  try {
    const parseResult = uploadResumeSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid request data',
        errors: parseResult.error.errors
      });
    }
    
    const { fileName, mimeType, base64Data, title, description, tags, isPrimary } = parseResult.data;
    
    // Calculate file size
    const fileSize = Math.ceil((base64Data.length * 3) / 4);
    
    // Check file size (max 5MB)
    if (fileSize > 5 * 1024 * 1024) {
      return res.status(400).json({
        status: 'error',
        message: 'File too large. Maximum size: 5MB'
      });
    }
    
    // If setting as primary, unset current primary
    if (isPrimary) {
      await prisma.resumeDocument.updateMany({
        where: { userId, isPrimary: true },
        data: { isPrimary: false }
      });
    }
    
    // Upload to Azure Blob Storage
    const fileBuffer = Buffer.from(base64Data, 'base64');
    const uploadResult = await uploadResume(userId, fileName, fileBuffer, mimeType);
    
    if (!uploadResult.success || !uploadResult.blobName) {
      resumeLogger.error('Failed to upload resume to Azure Blob Storage', {
        userId: userId.slice(0, 12),
        error: uploadResult.error
      });
      return res.status(500).json({
        status: 'error',
        message: 'Failed to upload resume to storage'
      });
    }
    
    // Create resume with storageKey (no base64Data in DB)
    const resume = await prisma.resumeDocument.create({
      data: {
        userId,
        fileName,
        mimeType,
        fileSize,
        storageKey: uploadResult.blobName,
        source: 'UPLOAD' as ResumeSource,
        title: title || fileName.replace(/\.[^/.]+$/, ''),
        description,
        tags: tags || [],
        version: 1,
        isLatest: true,
        isActive: true,
        isPrimary: isPrimary || false
      }
    });
    
    resumeLogger.info('Resume uploaded', {
      userId: userId.slice(0, 12),
      resumeId: resume.id.slice(0, 8),
      fileName
    });
    
    return res.status(201).json({
      status: 'success',
      data: {
        id: resume.id,
        title: resume.title,
        fileName: resume.fileName,
        fileSize: resume.fileSize,
        source: resume.source,
        isPrimary: resume.isPrimary,
        createdAt: resume.createdAt
      }
    });
  } catch (error: any) {
    resumeLogger.error('Failed to upload resume', { error: error.message });
    return res.status(500).json({
      status: 'error',
      message: 'Failed to upload resume'
    });
  }
});

/**
 * GET /api/resumes/:id
 * Get resume metadata
 */
router.get('/:id', requireSession, async (req: Request, res: Response) => {
  const userId = req.userId!;
  const { id } = req.params;
  
  try {
    const resume = await prisma.resumeDocument.findFirst({
      where: {
        id,
        userId,
        isActive: true
      },
      select: {
        id: true,
        title: true,
        fileName: true,
        fileSize: true,
        mimeType: true,
        source: true,
        linkedInProfileUrl: true,
        description: true,
        tags: true,
        version: true,
        qualityScore: true,
        isPrimary: true,
        parsedMetadata: true,
        createdAt: true,
        updatedAt: true,
        lastUsedAt: true,
        scores: {
          select: {
            roleTitle: true,
            score: true,
            provider: true,
            breakdown: true,
            computedAt: true
          },
          orderBy: { computedAt: 'desc' }
        },
        _count: {
          select: { interviews: true }
        }
      }
    });
    
    if (!resume) {
      return res.status(404).json({
        status: 'error',
        message: 'Resume not found'
      });
    }
    
    return res.json({
      status: 'success',
      data: {
        ...resume,
        usageCount: resume._count.interviews,
        _count: undefined
      }
    });
  } catch (error: any) {
    resumeLogger.error('Failed to get resume', { error: error.message });
    return res.status(500).json({
      status: 'error',
      message: 'Failed to get resume'
    });
  }
});

/**
 * GET /api/resumes/:id/download
 * Download resume file
 */
router.get('/:id/download', requireSession, async (req: Request, res: Response) => {
  const userId = req.userId!;
  const { id } = req.params;
  
  try {
    const resume = await prisma.resumeDocument.findFirst({
      where: {
        id,
        userId,
        isActive: true
      },
      select: {
        fileName: true,
        mimeType: true,
        storageKey: true
      }
    });
    
    if (!resume) {
      return res.status(404).json({
        status: 'error',
        message: 'Resume not found'
      });
    }
    
    if (!resume.storageKey) {
      return res.status(404).json({
        status: 'error',
        message: 'Resume file not found in storage'
      });
    }
    
    // Download from Azure Blob Storage
    const downloadResult = await downloadResume(resume.storageKey);
    
    if (!downloadResult.success || !downloadResult.data) {
      resumeLogger.error('Failed to download resume from Azure Blob', {
        storageKey: resume.storageKey,
        error: downloadResult.error
      });
      return res.status(500).json({
        status: 'error',
        message: 'Failed to retrieve resume file'
      });
    }
    
    res.setHeader('Content-Type', resume.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${resume.fileName}"`);
    res.setHeader('Content-Length', downloadResult.data.length);
    
    return res.send(downloadResult.data);
  } catch (error: any) {
    resumeLogger.error('Failed to download resume', { error: error.message });
    return res.status(500).json({
      status: 'error',
      message: 'Failed to download resume'
    });
  }
});

/**
 * PATCH /api/resumes/:id
 * Update resume metadata
 */
router.patch('/:id', requireSession, async (req: Request, res: Response) => {
  const userId = req.userId!;
  const { id } = req.params;
  
  try {
    const parseResult = updateResumeSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid request data',
        errors: parseResult.error.errors
      });
    }
    
    // Check ownership
    const existing = await prisma.resumeDocument.findFirst({
      where: { id, userId, isActive: true }
    });
    
    if (!existing) {
      return res.status(404).json({
        status: 'error',
        message: 'Resume not found'
      });
    }
    
    const { title, description, tags, isPrimary } = parseResult.data;
    
    // If setting as primary, unset current primary
    if (isPrimary) {
      await prisma.resumeDocument.updateMany({
        where: { userId, isPrimary: true },
        data: { isPrimary: false }
      });
    }
    
    const resume = await prisma.resumeDocument.update({
      where: { id },
      data: {
        title,
        description,
        tags,
        isPrimary
      }
    });
    
    return res.json({
      status: 'success',
      data: {
        id: resume.id,
        title: resume.title,
        isPrimary: resume.isPrimary,
        updatedAt: resume.updatedAt
      }
    });
  } catch (error: any) {
    resumeLogger.error('Failed to update resume', { error: error.message });
    return res.status(500).json({
      status: 'error',
      message: 'Failed to update resume'
    });
  }
});

/**
 * DELETE /api/resumes/:id
 * Soft delete a resume
 */
router.delete('/:id', requireSession, async (req: Request, res: Response) => {
  const userId = req.userId!;
  const { id } = req.params;
  
  try {
    // Check ownership and get storageKey for blob deletion
    const existing = await prisma.resumeDocument.findFirst({
      where: { id, userId, isActive: true },
      select: { id: true, storageKey: true }
    });
    
    if (!existing) {
      return res.status(404).json({
        status: 'error',
        message: 'Resume not found'
      });
    }
    
    // Delete from Azure Blob Storage
    if (existing.storageKey) {
      const deleted = await deleteResume(existing.storageKey);
      if (!deleted) {
        resumeLogger.warn('Failed to delete resume from Azure Blob', {
          resumeId: id.slice(0, 8),
          storageKey: existing.storageKey
        });
      }
    }
    
    // Soft delete in database
    await prisma.resumeDocument.update({
      where: { id },
      data: { isActive: false }
    });
    
    resumeLogger.info('Resume deleted', {
      userId: userId.slice(0, 12),
      resumeId: id.slice(0, 8)
    });
    
    return res.json({
      status: 'success',
      message: 'Resume deleted'
    });
  } catch (error: any) {
    resumeLogger.error('Failed to delete resume', { error: error.message });
    return res.status(500).json({
      status: 'error',
      message: 'Failed to delete resume'
    });
  }
});

/**
 * POST /api/resumes/linkedin
 * Create a resume entry from LinkedIn profile data
 */
router.post('/linkedin', requireSession, async (req: Request, res: Response) => {
  const userId = req.userId!;
  
  try {
    const parseResult = linkedInResumeSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid request data',
        errors: parseResult.error.errors
      });
    }
    
    const { profileData, title } = parseResult.data;
    
    // Generate JSON content from profile data
    const jsonContent = JSON.stringify(profileData, null, 2);
    const fileBuffer = Buffer.from(jsonContent, 'utf-8');
    const fileName = `LinkedIn Import - ${new Date().toISOString().split('T')[0]}.json`;
    
    // Upload to Azure Blob Storage
    const uploadResult = await uploadResume(userId, fileName, fileBuffer, 'application/json');
    
    if (!uploadResult.success || !uploadResult.blobName) {
      resumeLogger.error('Failed to upload LinkedIn resume to Azure Blob', {
        userId: userId.slice(0, 12),
        error: uploadResult.error
      });
      return res.status(500).json({
        status: 'error',
        message: 'Failed to upload LinkedIn resume to storage'
      });
    }
    
    // Create resume with storageKey
    const resume = await prisma.resumeDocument.create({
      data: {
        userId,
        fileName,
        mimeType: 'application/json',
        fileSize: jsonContent.length,
        storageKey: uploadResult.blobName,
        source: 'LINKEDIN' as ResumeSource,
        title: title || `LinkedIn Profile - ${profileData.name || 'Import'}`,
        linkedInProfileUrl: profileData.profileUrl,
        parsedMetadata: {
          candidateName: profileData.name,
          email: profileData.email,
          currentTitle: profileData.headline,
          skills: [],
          education: [],
          experience: [],
          certifications: [],
          languages: []
        },
        version: 1,
        isLatest: true,
        isActive: true,
        isPrimary: false
      }
    });
    
    resumeLogger.info('LinkedIn resume created', {
      userId: userId.slice(0, 12),
      resumeId: resume.id.slice(0, 8)
    });
    
    return res.status(201).json({
      status: 'success',
      data: {
        id: resume.id,
        title: resume.title,
        fileName: resume.fileName,
        source: resume.source,
        createdAt: resume.createdAt
      }
    });
  } catch (error: any) {
    resumeLogger.error('Failed to create LinkedIn resume', { error: error.message });
    return res.status(500).json({
      status: 'error',
      message: 'Failed to create LinkedIn resume'
    });
  }
});

export default router;
