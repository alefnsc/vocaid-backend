/**
 * Zod Validation Schemas
 * Provides runtime type validation for API requests and database operations
 */

import { z } from 'zod';

// ========================================
// BASE SCHEMAS
// ========================================

// UUID validation
export const uuidSchema = z.string().uuid();

// Clerk User ID validation (format: user_xxxxx)
export const clerkUserIdSchema = z.string().regex(/^user_[a-zA-Z0-9]+$/, {
  message: 'Invalid Clerk user ID format'
});

// Email validation
export const emailSchema = z.string().email();

// ========================================
// USER SCHEMAS
// ========================================

export const createUserSchema = z.object({
  clerkId: clerkUserIdSchema,
  email: emailSchema,
  firstName: z.string().min(1).max(100).optional(),
  lastName: z.string().min(1).max(100).optional(),
  imageUrl: z.string().url().optional().nullable(),
  credits: z.number().int().nonnegative().default(0)
});

export const updateUserSchema = z.object({
  email: emailSchema.optional(),
  firstName: z.string().min(1).max(100).optional(),
  lastName: z.string().min(1).max(100).optional(),
  imageUrl: z.string().url().optional().nullable(),
  credits: z.number().int().nonnegative().optional()
});

export const userParamsSchema = z.object({
  userId: uuidSchema.or(clerkUserIdSchema)
});

// ========================================
// INTERVIEW SCHEMAS
// ========================================

export const interviewStatusSchema = z.enum([
  'PENDING',
  'IN_PROGRESS',
  'COMPLETED',
  'FAILED',
  'CANCELLED'
]);

export const createInterviewSchema = z.object({
  userId: uuidSchema.or(clerkUserIdSchema),
  jobTitle: z.string().min(1).max(200).transform(val => val.trim()),
  companyName: z.string().min(1).max(200).transform(val => val.trim()),
  jobDescription: z.string().min(200).max(50000).transform(val => val.trim()),
  resumeData: z.string().optional(), // Base64 encoded
  resumeFileName: z.string().max(255).optional(),
  resumeMimeType: z.string().max(100).optional()
});

export const updateInterviewSchema = z.object({
  retellCallId: z.string().optional(),
  status: interviewStatusSchema.optional(),
  score: z.number().min(0).max(100).optional(),
  feedbackPdf: z.string().optional(), // Base64 encoded
  feedbackText: z.string().optional(),
  callDuration: z.number().int().nonnegative().optional(),
  startedAt: z.string().datetime().optional(),
  endedAt: z.string().datetime().optional()
});

export const interviewParamsSchema = z.object({
  interviewId: uuidSchema
});

export const interviewQuerySchema = z.object({
  page: z.string().optional().transform(val => val ? parseInt(val, 10) : 1),
  limit: z.string().optional().transform(val => val ? Math.min(parseInt(val, 10), 50) : 10),
  status: interviewStatusSchema.optional(),
  sortBy: z.enum(['createdAt', 'score', 'companyName']).optional().default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).optional().default('desc')
});

// ========================================
// INTERVIEW METRICS SCHEMAS
// ========================================

export const metricCategorySchema = z.enum([
  'communication',
  'technical',
  'behavioral',
  'problem_solving',
  'cultural_fit',
  'overall'
]);

export const createInterviewMetricSchema = z.object({
  interviewId: uuidSchema,
  category: metricCategorySchema,
  metricName: z.string().min(1).max(100),
  score: z.number().min(0).max(10),
  maxScore: z.number().min(1).max(10).default(10),
  feedback: z.string().max(5000).optional()
});

export const batchCreateMetricsSchema = z.object({
  interviewId: uuidSchema,
  metrics: z.array(createInterviewMetricSchema.omit({ interviewId: true }))
});

// ========================================
// PAYMENT SCHEMAS
// ========================================

export const paymentStatusSchema = z.enum([
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'REFUNDED',
  'IN_PROCESS'
]);

export const packageIdSchema = z.enum(['starter', 'intermediate', 'professional']);

export const createPaymentSchema = z.object({
  userId: uuidSchema.or(clerkUserIdSchema),
  packageId: packageIdSchema,
  preferenceId: z.string().optional(),
  amountUSD: z.number().positive(),
  amountBRL: z.number().positive(),
  packageName: z.string(),
  creditsAmount: z.number().int().positive()
});

export const updatePaymentSchema = z.object({
  mercadoPagoId: z.string().optional(),
  status: paymentStatusSchema.optional(),
  statusDetail: z.string().optional(),
  paidAt: z.string().datetime().optional()
});

export const paymentParamsSchema = z.object({
  paymentId: uuidSchema
});

export const paymentQuerySchema = z.object({
  page: z.string().optional().transform(val => val ? parseInt(val, 10) : 1),
  limit: z.string().optional().transform(val => val ? Math.min(parseInt(val, 10), 50) : 10),
  status: paymentStatusSchema.optional()
});

// ========================================
// WEBHOOK SCHEMAS
// ========================================

export const mercadoPagoWebhookSchema = z.object({
  action: z.string(),
  api_version: z.string().optional(),
  data: z.object({
    id: z.string()
  }),
  date_created: z.string().optional(),
  id: z.union([z.string(), z.number()]),
  live_mode: z.boolean().optional(),
  type: z.string(),
  user_id: z.union([z.string(), z.number()]).optional()
});

export const clerkWebhookSchema = z.object({
  type: z.string(),
  data: z.record(z.unknown()),
  object: z.string().optional()
});

// ========================================
// DASHBOARD SCHEMAS
// ========================================

export const dashboardQuerySchema = z.object({
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  period: z.enum(['7d', '30d', '90d', '1y', 'all']).optional().default('30d')
});

// ========================================
// TYPE EXPORTS
// ========================================

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type CreateInterviewInput = z.infer<typeof createInterviewSchema>;
export type UpdateInterviewInput = z.infer<typeof updateInterviewSchema>;
export type InterviewQueryInput = z.infer<typeof interviewQuerySchema>;
export type CreateInterviewMetricInput = z.infer<typeof createInterviewMetricSchema>;
export type BatchCreateMetricsInput = z.infer<typeof batchCreateMetricsSchema>;
export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;
export type UpdatePaymentInput = z.infer<typeof updatePaymentSchema>;
export type PaymentQueryInput = z.infer<typeof paymentQuerySchema>;
export type DashboardQueryInput = z.infer<typeof dashboardQuerySchema>;
