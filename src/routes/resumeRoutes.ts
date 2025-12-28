/**
 * Resume Routes
 * 
 * API endpoints for resume repository with scoring support.
 * 
 * Routes:
 * - GET /api/resumes - List user's resumes
 * - POST /api/resumes/upload - Upload new resume
 * - GET /api/resumes/:id - Get resume metadata
 * - GET /api/resumes/:id/download - Download resume file
 * - POST /api/resumes/:id/score - Score resume for a role
 * - GET /api/resumes/scores - Get scores filtered by role
 * - POST /api/resumes/linkedin - Create resume from LinkedIn data
 * 
 * @module routes/resumeRoutes
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { PrismaClient, ResumeSource } from '@prisma/client';
import logger from '../utils/logger';
import { scoreResume, getResumeScores } from '../services/resumeScoringService';

const router = Router();
const prisma = new PrismaClient();
const resumeLogger = logger.child({ component: 'resume-routes' });

// ========================================
// VALIDATION SCHEMAS
// ========================================

const clerkUserIdSchema = z.string().regex(/^user_[a-zA-Z0-9]+$/);

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

const scoreResumeSchema = z.object({
  roleTitle: z.string().min(1).max(255),
  jobDescription: z.string().max(10000).optional(),
  forceRefresh: z.boolean().optional()
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
// MIDDLEWARE
// ========================================

function getClerkUserId(req: Request): string | null {
  return (req.headers['x-user-id'] as string) || req.body?.userId || null;
}

async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const clerkId = getClerkUserId(req);
  
  if (!clerkId) {
    return res.status(401).json({
      status: 'error',
      message: 'Authentication required'
    });
  }
  
  try {
    clerkUserIdSchema.parse(clerkId);
    (req as any).clerkUserId = clerkId;
    next();
  } catch {
    return res.status(401).json({
      status: 'error',
      message: 'Invalid user ID format'
    });
  }
}

// Helper to get internal user ID from Clerk ID
async function getUserId(clerkId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { clerkId },
    select: { id: true }
  });
  return user?.id || null;
}

// ========================================
// ROUTES
// ========================================

/**
 * GET /api/resumes
 * List all resumes for the authenticated user
 */
router.get('/', requireAuth, async (req: Request, res: Response) => {
  const clerkId = (req as any).clerkUserId;
  
  try {
    const userId = await getUserId(clerkId);
    if (!userId) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found'
      });
    }
    
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
    
    resumeLogger.info('Resumes listed', { userId: clerkId.slice(0, 12), count: data.length });
    
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
router.post('/upload', requireAuth, async (req: Request, res: Response) => {
  const clerkId = (req as any).clerkUserId;
  
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
    
    const userId = await getUserId(clerkId);
    if (!userId) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found'
      });
    }
    
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
    
    // Create resume
    const resume = await prisma.resumeDocument.create({
      data: {
        userId,
        fileName,
        mimeType,
        fileSize,
        base64Data,
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
      userId: clerkId.slice(0, 12),
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
router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  const clerkId = (req as any).clerkUserId;
  const { id } = req.params;
  
  try {
    const userId = await getUserId(clerkId);
    if (!userId) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found'
      });
    }
    
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
router.get('/:id/download', requireAuth, async (req: Request, res: Response) => {
  const clerkId = (req as any).clerkUserId;
  const { id } = req.params;
  
  try {
    const userId = await getUserId(clerkId);
    if (!userId) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found'
      });
    }
    
    const resume = await prisma.resumeDocument.findFirst({
      where: {
        id,
        userId,
        isActive: true
      },
      select: {
        fileName: true,
        mimeType: true,
        base64Data: true
      }
    });
    
    if (!resume) {
      return res.status(404).json({
        status: 'error',
        message: 'Resume not found'
      });
    }
    
    // Decode base64 and send file
    const fileBuffer = Buffer.from(resume.base64Data, 'base64');
    
    res.setHeader('Content-Type', resume.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${resume.fileName}"`);
    res.setHeader('Content-Length', fileBuffer.length);
    
    return res.send(fileBuffer);
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
router.patch('/:id', requireAuth, async (req: Request, res: Response) => {
  const clerkId = (req as any).clerkUserId;
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
    
    const userId = await getUserId(clerkId);
    if (!userId) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found'
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
router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  const clerkId = (req as any).clerkUserId;
  const { id } = req.params;
  
  try {
    const userId = await getUserId(clerkId);
    if (!userId) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found'
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
    
    // Soft delete
    await prisma.resumeDocument.update({
      where: { id },
      data: { isActive: false }
    });
    
    resumeLogger.info('Resume deleted', {
      userId: clerkId.slice(0, 12),
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
 * POST /api/resumes/:id/score
 * Score a resume for a specific role
 */
router.post('/:id/score', requireAuth, async (req: Request, res: Response) => {
  const clerkId = (req as any).clerkUserId;
  const { id } = req.params;
  
  try {
    const parseResult = scoreResumeSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid request data',
        errors: parseResult.error.errors
      });
    }
    
    const { roleTitle, forceRefresh } = parseResult.data;
    
    const userId = await getUserId(clerkId);
    if (!userId) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found'
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
    
    // Score the resume
    const result = await scoreResume(id, roleTitle, forceRefresh);
    
    if (!result) {
      return res.status(500).json({
        status: 'error',
        message: 'Failed to score resume'
      });
    }
    
    return res.json({
      status: 'success',
      data: result
    });
  } catch (error: any) {
    resumeLogger.error('Failed to score resume', { error: error.message });
    return res.status(500).json({
      status: 'error',
      message: 'Failed to score resume'
    });
  }
});

/**
 * GET /api/resumes/scores
 * Get all scores filtered by role
 */
router.get('/scores', requireAuth, async (req: Request, res: Response) => {
  const clerkId = (req as any).clerkUserId;
  const { roleTitle } = req.query;
  
  try {
    const userId = await getUserId(clerkId);
    if (!userId) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found'
      });
    }
    
    // Get all user's resumes with their scores
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
        source: true,
        scores: {
          where: roleTitle ? {
            roleTitle: { equals: roleTitle as string, mode: 'insensitive' }
          } : undefined,
          select: {
            roleTitle: true,
            score: true,
            provider: true,
            breakdown: true,
            computedAt: true
          },
          orderBy: { score: 'desc' }
        }
      }
    });
    
    return res.json({
      status: 'success',
      data: resumes
    });
  } catch (error: any) {
    resumeLogger.error('Failed to get resume scores', { error: error.message });
    return res.status(500).json({
      status: 'error',
      message: 'Failed to get resume scores'
    });
  }
});

/**
 * POST /api/resumes/linkedin
 * Create a resume entry from LinkedIn profile data
 */
router.post('/linkedin', requireAuth, async (req: Request, res: Response) => {
  const clerkId = (req as any).clerkUserId;
  
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
    
    const userId = await getUserId(clerkId);
    if (!userId) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found'
      });
    }
    
    // Generate JSON content from profile data
    const jsonContent = JSON.stringify(profileData, null, 2);
    const base64Data = Buffer.from(jsonContent).toString('base64');
    const fileName = `LinkedIn Import - ${new Date().toISOString().split('T')[0]}.json`;
    
    // Create resume
    const resume = await prisma.resumeDocument.create({
      data: {
        userId,
        fileName,
        mimeType: 'application/json',
        fileSize: jsonContent.length,
        base64Data,
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
      userId: clerkId.slice(0, 12),
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
