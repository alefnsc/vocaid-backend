/**
 * Test Setup
 * 
 * Configure environment and global test utilities
 */

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.EMAIL_PROVIDER_MODE = 'mock';
process.env.ADMIN_SECRET_KEY = 'test-admin-secret-key-12345';
process.env.CRON_SECRET = 'test-cron-secret-12345';
process.env.EMAIL_FROM = 'test@vocaid.ai';
process.env.FRONTEND_URL = 'http://localhost:3000';

// Increase timeout for async operations
jest.setTimeout(30000);

// Mock Prisma client for unit tests
jest.mock('@prisma/client', () => {
  const mockPrismaClient = {
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    transactionalEmail: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
      groupBy: jest.fn()
    },
    emailLog: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn()
    },
    interview: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn()
    },
    user: {
      findUnique: jest.fn(),
      findMany: jest.fn()
    }
  };
  
  return {
    PrismaClient: jest.fn(() => mockPrismaClient),
    EmailSendStatus: {
      PENDING: 'PENDING',
      SENDING: 'SENDING',
      SENT: 'SENT',
      FAILED: 'FAILED'
    },
    TransactionalEmailType: {
      WELCOME: 'WELCOME',
      CREDITS_PURCHASE_RECEIPT: 'CREDITS_PURCHASE_RECEIPT',
      PASSWORD_RESET: 'PASSWORD_RESET',
      INTERVIEW_REMINDER: 'INTERVIEW_REMINDER',
      LOW_CREDITS_WARNING: 'LOW_CREDITS_WARNING',
      INTERVIEW_COMPLETE: 'INTERVIEW_COMPLETE'
    },
    EmailProvider: {
      RESEND: 'RESEND'
    }
  };
});

// Mock logger to suppress output during tests
jest.mock('../utils/logger', () => {
  const childLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };

  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn(() => childLogger),
  };

  return {
    __esModule: true,
    default: logger,
    wsLogger: childLogger,
    retellLogger: childLogger,
    feedbackLogger: childLogger,
    paymentLogger: childLogger,
    authLogger: childLogger,
    dbLogger: childLogger,
    apiLogger: childLogger,
    httpLogger: childLogger,
  };
});

// Global test utilities
export const testUtils = {
  generateUUID: () => {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  },
  
  createMockUser: (overrides = {}) => ({
    id: 'test-user-id',
    email: 'test@example.com',
    firstName: 'Test',
    lastName: 'User',
    preferredLanguage: 'en',
    ...overrides
  }),
  
  createMockInterview: (overrides = {}) => ({
    id: testUtils.generateUUID(),
    userId: 'test-user-id',
    jobTitle: 'Software Engineer',
    companyName: 'Test Company',
    status: 'COMPLETED',
    emailSendStatus: 'PENDING',
    ...overrides
  })
};

// Cleanup after all tests
afterAll(async () => {
  // Add any global cleanup here
  jest.clearAllMocks();
});
