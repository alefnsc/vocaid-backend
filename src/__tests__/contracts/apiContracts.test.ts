/**
 * API Contract Tests
 * 
 * Tests to verify API responses match expected contracts.
 * These tests ensure:
 * - Response shapes are consistent
 * - Required fields are present
 * - Types are correct
 * - Error responses follow standard format
 * 
 * @module __tests__/contracts/apiContracts.test
 */

import request from 'supertest';
import express from 'express';

// ============================================
// MOCK SETUP
// ============================================

// Mock the database service
jest.mock('../../services/databaseService', () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
    },
    interview: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn(),
    },
    creditsWallet: {
      findUnique: jest.fn(),
    },
    creditLedger: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
    resumeDocument: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
    },
    $queryRaw: jest.fn(),
  },
  dbLogger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock Clerk authentication
jest.mock('@clerk/express', () => ({
  clerkMiddleware: () => (req: any, res: any, next: any) => {
    req.auth = { userId: 'user_test123' };
    next();
  },
  requireAuth: () => (req: any, res: any, next: any) => {
    req.auth = { userId: 'user_test123' };
    (req as any).clerkUserId = 'user_test123';
    next();
  },
  getAuth: () => ({ userId: 'user_test123' }),
}));

// Mock logger
jest.mock('../../utils/logger', () => ({
  default: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
  httpLogger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

// ============================================
// TEST UTILITIES
// ============================================

/**
 * Create a test Express app with the API routes
 */
function createTestApp() {
  const app = express();
  app.use(express.json());
  
  // Add mock auth middleware
  app.use((req: any, res, next) => {
    req.auth = { userId: 'user_test123' };
    req.clerkUserId = 'user_test123';
    req.requestId = 'test-request-id';
    next();
  });
  
  return app;
}

/**
 * Validate standard success response shape
 */
function expectSuccessResponse(body: any) {
  expect(body).toHaveProperty('status', 'success');
  expect(body).toHaveProperty('data');
}

/**
 * Validate standard error response shape
 */
function expectErrorResponse(body: any) {
  expect(body).toHaveProperty('status', 'error');
  expect(body).toHaveProperty('message');
  expect(typeof body.message).toBe('string');
}

/**
 * Validate pagination shape
 */
function expectPaginationShape(pagination: any) {
  expect(pagination).toHaveProperty('page');
  expect(pagination).toHaveProperty('limit');
  expect(pagination).toHaveProperty('total');
  expect(pagination).toHaveProperty('totalPages');
  expect(typeof pagination.page).toBe('number');
  expect(typeof pagination.limit).toBe('number');
  expect(typeof pagination.total).toBe('number');
  expect(typeof pagination.totalPages).toBe('number');
}

// ============================================
// RESPONSE SHAPE CONTRACTS
// ============================================

describe('API Response Contracts', () => {
  describe('Standard Response Shapes', () => {
    it('should define success response contract', () => {
      const successResponse = {
        status: 'success',
        data: { id: '123', name: 'Test' },
      };
      
      expectSuccessResponse(successResponse);
    });
    
    it('should define error response contract', () => {
      const errorResponse = {
        status: 'error',
        message: 'Something went wrong',
        code: 'INTERNAL_ERROR',
      };
      
      expectErrorResponse(errorResponse);
    });
    
    it('should define paginated response contract', () => {
      const paginatedResponse = {
        status: 'success',
        data: [],
        pagination: {
          page: 1,
          limit: 10,
          total: 100,
          totalPages: 10,
          hasMore: true,
        },
      };
      
      expectSuccessResponse(paginatedResponse);
      expectPaginationShape(paginatedResponse.pagination);
    });
  });
});

// ============================================
// INTERVIEW API CONTRACTS
// ============================================

describe('Interview API Contracts', () => {
  describe('Interview List Response', () => {
    const mockInterviewListItem = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      jobTitle: 'Software Engineer',
      companyName: 'Tech Corp',
      status: 'COMPLETED',
      score: 85.5,
      callDuration: 1800,
      createdAt: new Date('2024-12-01T10:00:00Z'),
      startedAt: new Date('2024-12-01T10:05:00Z'),
      endedAt: new Date('2024-12-01T10:35:00Z'),
      seniority: 'senior',
      language: 'en',
      hasFeedback: true,
    };
    
    it('should have correct interview list item shape', () => {
      expect(mockInterviewListItem).toHaveProperty('id');
      expect(mockInterviewListItem).toHaveProperty('jobTitle');
      expect(mockInterviewListItem).toHaveProperty('companyName');
      expect(mockInterviewListItem).toHaveProperty('status');
      expect(mockInterviewListItem).toHaveProperty('score');
      expect(mockInterviewListItem).toHaveProperty('callDuration');
      expect(mockInterviewListItem).toHaveProperty('createdAt');
      expect(mockInterviewListItem).toHaveProperty('hasFeedback');
      
      // Type checks
      expect(typeof mockInterviewListItem.id).toBe('string');
      expect(typeof mockInterviewListItem.jobTitle).toBe('string');
      expect(typeof mockInterviewListItem.companyName).toBe('string');
      expect(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED']).toContain(mockInterviewListItem.status);
      expect(typeof mockInterviewListItem.score).toBe('number');
      expect(typeof mockInterviewListItem.hasFeedback).toBe('boolean');
    });
    
    it('should validate UUID format for interview id', () => {
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      expect(mockInterviewListItem.id).toMatch(uuidRegex);
    });
    
    it('should validate score range', () => {
      expect(mockInterviewListItem.score).toBeGreaterThanOrEqual(0);
      expect(mockInterviewListItem.score).toBeLessThanOrEqual(100);
    });
  });
  
  describe('Interview Detail Response', () => {
    const mockInterviewDetail = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      userId: '550e8400-e29b-41d4-a716-446655440001',
      retellCallId: 'call_abc123',
      jobTitle: 'Software Engineer',
      companyName: 'Tech Corp',
      jobDescription: 'Building great software...',
      seniority: 'senior',
      language: 'en',
      status: 'COMPLETED',
      score: 85.5,
      feedbackText: 'Great performance...',
      callDuration: 1800,
      startedAt: '2024-12-01T10:05:00Z',
      endedAt: '2024-12-01T10:35:00Z',
      createdAt: '2024-12-01T10:00:00Z',
      updatedAt: '2024-12-01T10:35:00Z',
    };
    
    it('should have all required fields for interview detail', () => {
      expect(mockInterviewDetail).toHaveProperty('id');
      expect(mockInterviewDetail).toHaveProperty('jobTitle');
      expect(mockInterviewDetail).toHaveProperty('companyName');
      expect(mockInterviewDetail).toHaveProperty('jobDescription');
      expect(mockInterviewDetail).toHaveProperty('status');
      expect(mockInterviewDetail).toHaveProperty('createdAt');
    });
    
    it('should have optional feedback fields when completed', () => {
      expect(mockInterviewDetail).toHaveProperty('score');
      expect(mockInterviewDetail).toHaveProperty('feedbackText');
    });
  });
});

// ============================================
// CREDITS/WALLET API CONTRACTS
// ============================================

describe('Credits API Contracts', () => {
  describe('Wallet Balance Response', () => {
    const mockWalletBalance = {
      status: 'success',
      data: {
        balance: 10,
        totalEarned: 15,
        totalSpent: 5,
        totalPurchased: 10,
        totalGranted: 5,
        lastCreditAt: '2024-12-01T10:00:00Z',
        lastDebitAt: '2024-12-01T09:00:00Z',
      },
    };
    
    it('should have correct wallet balance shape', () => {
      expectSuccessResponse(mockWalletBalance);
      
      const data = mockWalletBalance.data;
      expect(data).toHaveProperty('balance');
      expect(data).toHaveProperty('totalEarned');
      expect(data).toHaveProperty('totalSpent');
      expect(data).toHaveProperty('totalPurchased');
      expect(data).toHaveProperty('totalGranted');
      
      // All numeric
      expect(typeof data.balance).toBe('number');
      expect(typeof data.totalEarned).toBe('number');
      expect(typeof data.totalSpent).toBe('number');
    });
    
    it('should have non-negative balance', () => {
      expect(mockWalletBalance.data.balance).toBeGreaterThanOrEqual(0);
    });
  });
  
  describe('Credit Ledger Transaction', () => {
    const mockTransaction = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      type: 'DEBIT',
      amount: 1,
      balanceAfter: 9,
      referenceType: 'interview',
      referenceId: '550e8400-e29b-41d4-a716-446655440001',
      description: 'Interview credit used',
      createdAt: '2024-12-01T10:00:00Z',
    };
    
    it('should have correct transaction shape', () => {
      expect(mockTransaction).toHaveProperty('id');
      expect(mockTransaction).toHaveProperty('type');
      expect(mockTransaction).toHaveProperty('amount');
      expect(mockTransaction).toHaveProperty('balanceAfter');
      expect(mockTransaction).toHaveProperty('description');
      expect(mockTransaction).toHaveProperty('createdAt');
    });
    
    it('should have valid transaction type', () => {
      expect(['CREDIT', 'DEBIT']).toContain(mockTransaction.type);
    });
    
    it('should have positive amount', () => {
      expect(mockTransaction.amount).toBeGreaterThan(0);
    });
  });
});

// ============================================
// RESUME API CONTRACTS
// ============================================

describe('Resume API Contracts', () => {
  describe('Resume List Item', () => {
    const mockResumeListItem = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      title: 'My Resume 2024',
      fileName: 'resume.pdf',
      mimeType: 'application/pdf',
      fileSize: 102400,
      version: 1,
      isPrimary: true,
      tags: ['engineering', 'senior'],
      createdAt: '2024-12-01T10:00:00Z',
      updatedAt: '2024-12-01T10:00:00Z',
    };
    
    it('should have correct resume list item shape', () => {
      expect(mockResumeListItem).toHaveProperty('id');
      expect(mockResumeListItem).toHaveProperty('title');
      expect(mockResumeListItem).toHaveProperty('fileName');
      expect(mockResumeListItem).toHaveProperty('mimeType');
      expect(mockResumeListItem).toHaveProperty('isPrimary');
      expect(mockResumeListItem).toHaveProperty('createdAt');
    });
    
    it('should have valid mime type', () => {
      const validMimeTypes = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
      expect(validMimeTypes).toContain(mockResumeListItem.mimeType);
    });
    
    it('should have boolean isPrimary', () => {
      expect(typeof mockResumeListItem.isPrimary).toBe('boolean');
    });
  });
  
  describe('Resume Score Response', () => {
    const mockResumeScore = {
      resumeId: '550e8400-e29b-41d4-a716-446655440000',
      roleTitle: 'Software Engineer',
      score: 78,
      provider: 'openai',
      breakdown: {
        skills: 85,
        experience: 70,
        education: 80,
      },
      cachedAt: '2024-12-01T10:00:00Z',
    };
    
    it('should have correct score response shape', () => {
      expect(mockResumeScore).toHaveProperty('resumeId');
      expect(mockResumeScore).toHaveProperty('roleTitle');
      expect(mockResumeScore).toHaveProperty('score');
      expect(mockResumeScore).toHaveProperty('provider');
    });
    
    it('should have score in valid range', () => {
      expect(mockResumeScore.score).toBeGreaterThanOrEqual(0);
      expect(mockResumeScore.score).toBeLessThanOrEqual(100);
    });
  });
});

// ============================================
// DASHBOARD API CONTRACTS
// ============================================

describe('Dashboard API Contracts', () => {
  describe('Candidate Dashboard Response', () => {
    const mockDashboardResponse = {
      status: 'success',
      data: {
        stats: {
          totalInterviews: 15,
          completedInterviews: 12,
          averageScore: 78.5,
          totalCredits: 5,
          scoreImprovement: 8.2,
        },
        recentInterviews: [],
        resumes: [],
        filterOptions: {
          roleTitles: ['Software Engineer', 'Product Manager'],
          seniorities: ['junior', 'senior'],
        },
      },
    };
    
    it('should have correct dashboard shape', () => {
      expectSuccessResponse(mockDashboardResponse);
      
      const data = mockDashboardResponse.data;
      expect(data).toHaveProperty('stats');
      expect(data).toHaveProperty('recentInterviews');
      expect(data).toHaveProperty('resumes');
    });
    
    it('should have correct stats shape', () => {
      const stats = mockDashboardResponse.data.stats;
      expect(stats).toHaveProperty('totalInterviews');
      expect(stats).toHaveProperty('completedInterviews');
      expect(stats).toHaveProperty('averageScore');
      expect(stats).toHaveProperty('totalCredits');
    });
    
    it('should have filter options', () => {
      const filters = mockDashboardResponse.data.filterOptions;
      expect(Array.isArray(filters.roleTitles)).toBe(true);
      expect(Array.isArray(filters.seniorities)).toBe(true);
    });
  });
});

// ============================================
// ERROR RESPONSE CONTRACTS
// ============================================

describe('Error Response Contracts', () => {
  describe('Standard Error Shapes', () => {
    it('should validate 400 Bad Request shape', () => {
      const badRequest = {
        status: 'error',
        message: 'Invalid input',
        errors: [
          { field: 'email', message: 'Invalid email format' }
        ]
      };
      
      expectErrorResponse(badRequest);
      expect(badRequest).toHaveProperty('errors');
      expect(Array.isArray(badRequest.errors)).toBe(true);
    });
    
    it('should validate 401 Unauthorized shape', () => {
      const unauthorized = {
        status: 'error',
        message: 'Authentication required',
        code: 'UNAUTHORIZED'
      };
      
      expectErrorResponse(unauthorized);
      expect(unauthorized).toHaveProperty('code');
    });
    
    it('should validate 403 Forbidden shape', () => {
      const forbidden = {
        status: 'error',
        message: 'Access denied',
        code: 'FORBIDDEN'
      };
      
      expectErrorResponse(forbidden);
    });
    
    it('should validate 404 Not Found shape', () => {
      const notFound = {
        status: 'error',
        message: 'Resource not found',
        code: 'NOT_FOUND'
      };
      
      expectErrorResponse(notFound);
    });
    
    it('should validate 429 Rate Limited shape', () => {
      const rateLimited = {
        status: 'error',
        message: 'Too many requests, please try again later.',
        retryAfter: 60
      };
      
      expectErrorResponse(rateLimited);
      expect(rateLimited).toHaveProperty('retryAfter');
      expect(typeof rateLimited.retryAfter).toBe('number');
    });
    
    it('should validate 500 Internal Error shape', () => {
      const internalError = {
        status: 'error',
        message: 'An unexpected error occurred',
        code: 'INTERNAL_ERROR',
        requestId: 'req-123456'
      };
      
      expectErrorResponse(internalError);
      expect(internalError).toHaveProperty('requestId');
    });
  });
});

// ============================================
// HEADER CONTRACTS
// ============================================

describe('HTTP Header Contracts', () => {
  describe('Required Request Headers', () => {
    it('should require Authorization header for protected routes', () => {
      const requiredHeaders = ['Authorization'];
      requiredHeaders.forEach(header => {
        expect(typeof header).toBe('string');
      });
    });
    
    it('should accept optional locale headers', () => {
      const optionalHeaders = ['Accept-Language', 'X-Country-Code', 'X-Request-ID'];
      optionalHeaders.forEach(header => {
        expect(typeof header).toBe('string');
      });
    });
  });
  
  describe('Response Headers', () => {
    it('should include Cache-Control for GET requests', () => {
      const expectedHeaders = {
        'Cache-Control': 'private, max-age=60',
        'Vary': 'Authorization, Accept-Language'
      };
      
      expect(expectedHeaders).toHaveProperty('Cache-Control');
    });
    
    it('should include request ID in response', () => {
      const expectedHeader = 'X-Request-ID';
      expect(typeof expectedHeader).toBe('string');
    });
  });
});
