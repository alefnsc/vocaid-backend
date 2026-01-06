/**
 * Interview Routes Tests
 *
 * Focused tests for /api/interviews router.
 */

import request from 'supertest';
import express from 'express';

// Mock logger to avoid dependency on .child() and transports
jest.mock('../../utils/logger', () => {
  const childLogger: any = {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  };
  childLogger.child = jest.fn(() => childLogger);
  return {
    __esModule: true,
    default: childLogger,
  };
});

// Mock session middleware so we can test 401 vs authed
jest.mock('../../middleware/sessionAuthMiddleware', () => ({
  requireSession: (req: any, res: any, next: any) => {
    const userId = req.header('x-test-user');
    if (!userId) {
      return res.status(401).json({ status: 'error', message: 'Authentication required' });
    }
    req.userId = userId;
    next();
  },
}));

// Mock prisma used directly by the routes
jest.mock('../../services/databaseService', () => ({
  prisma: {
    interview: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
    resumeDocument: {
      findFirst: jest.fn(),
      update: jest.fn(),
    },
  },
  dbLogger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock interview service functions invoked by routes
jest.mock('../../services/interviewService', () => ({
  createInterview: jest.fn(),
  getUserInterviews: jest.fn(),
  getInterviewById: jest.fn(),
  updateInterview: jest.fn(),
  cloneInterview: jest.fn(),
  getSuggestedRetakes: jest.fn(),
  getInterviewHistory: jest.fn(),
  createInterviewFromResume: jest.fn(),
}));

jest.mock('../../services/postCallProcessingService', () => ({
  postCallProcessingService: {
    getProcessingStatus: jest.fn(),
  },
}));

import interviewRoutes from '../../routes/interviewRoutes';
import { prisma } from '../../services/databaseService';
import * as interviewService from '../../services/interviewService';
import { postCallProcessingService } from '../../services/postCallProcessingService';
import logger from '../../utils/logger';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/interviews', interviewRoutes);
  return app;
}

describe('Interview Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/interviews', () => {
    it('returns 401 when unauthenticated', async () => {
      const app = createApp();
      await request(app)
        .post('/api/interviews')
        .send({})
        .expect(401);
    });

    it('creates interview when authenticated', async () => {
      const app = createApp();

      (interviewService.createInterview as jest.Mock).mockResolvedValue({
        id: '550e8400-e29b-41d4-a716-446655440000',
        userId: 'user_1',
        jobTitle: 'Software Engineer',
        companyName: 'Acme',
        jobDescription: 'A'.repeat(60),
        resumeId: '550e8400-e29b-41d4-a716-446655440001',
        language: 'zh-CN',
        status: 'PENDING',
      });

      const response = await request(app)
        .post('/api/interviews')
        .set('x-test-user', 'user_1')
        .send({
          jobTitle: 'Software Engineer',
          companyName: 'Acme',
          jobDescription: 'A'.repeat(60),
          resumeId: '550e8400-e29b-41d4-a716-446655440001',
          language: 'zh-CN',
          country: 'BR',
          seniority: 'mid',
        })
        .expect(200);

      expect(response.body.status).toBe('success');
      expect(response.body.data.id).toBe('550e8400-e29b-41d4-a716-446655440000');
      expect(interviewService.createInterview).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user_1',
          language: 'zh-CN',
        })
      );
    });
  });

  describe('PATCH /api/interviews/:id', () => {
    it('returns 404 if interview not owned', async () => {
      const app = createApp();
      (prisma.interview.findFirst as jest.Mock).mockResolvedValue(null);

      await request(app)
        .patch('/api/interviews/550e8400-e29b-41d4-a716-446655440000')
        .set('x-test-user', 'user_1')
        .send({ status: 'IN_PROGRESS' })
        .expect(404);
    });

    it('updates interview when owned', async () => {
      const app = createApp();
      (prisma.interview.findFirst as jest.Mock).mockResolvedValue({ id: '550e8400-e29b-41d4-a716-446655440000' });
      (interviewService.updateInterview as jest.Mock).mockResolvedValue({
        id: '550e8400-e29b-41d4-a716-446655440000',
        status: 'IN_PROGRESS',
      });
      (prisma.interview.update as jest.Mock).mockResolvedValue({
        id: '550e8400-e29b-41d4-a716-446655440000',
        status: 'IN_PROGRESS',
      });

      const response = await request(app)
        .patch('/api/interviews/550e8400-e29b-41d4-a716-446655440000')
        .set('x-test-user', 'user_1')
        .send({
          status: 'IN_PROGRESS',
          retellCallId: 'call_123',
          startedAt: new Date().toISOString(),
        });

      if (response.status !== 200) {
        const lastLoggedError = (logger as any).error?.mock?.calls?.slice(-1)?.[0];
        throw new Error(
          `Unexpected status ${response.status}: ${JSON.stringify(response.body)} | lastLog=${JSON.stringify(lastLoggedError)}`
        );
      }

      expect(response.body.status).toBe('success');
      expect(interviewService.updateInterview).toHaveBeenCalled();
    });
  });

  describe('GET /api/interviews/:id/postcall-status', () => {
    it('returns consolidated processing status', async () => {
      const app = createApp();
      (prisma.interview.findFirst as jest.Mock).mockResolvedValue({ id: '550e8400-e29b-41d4-a716-446655440000' });
      (postCallProcessingService.getProcessingStatus as jest.Mock).mockResolvedValue({
        status: 'partial',
        hasTranscript: true,
        hasMetrics: false,
        hasStudyPlan: false,
        overallScore: 72,
      });
      (prisma.interview.findUnique as jest.Mock).mockResolvedValue({
        status: 'COMPLETED',
        feedbackText: null,
        feedbackDocumentId: '550e8400-e29b-41d4-a716-446655440099',
      });

      const response = await request(app)
        .get('/api/interviews/550e8400-e29b-41d4-a716-446655440000/postcall-status')
        .set('x-test-user', 'user_1')
        .expect(200);

      expect(response.body.status).toBe('success');
      expect(response.body.data).toEqual(
        expect.objectContaining({
          processingStatus: 'partial',
          hasTranscript: true,
          hasMetrics: false,
          hasStudyPlan: false,
          hasFeedback: true,
          overallScore: 72,
          interviewStatus: 'COMPLETED',
        })
      );
    });
  });
});
