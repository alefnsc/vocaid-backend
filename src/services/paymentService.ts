/**
 * Payment Service
 * Handles payment-related database operations
 */

import { prisma, dbLogger } from './databaseService';
import { Prisma, PaymentStatus } from '@prisma/client';

// ========================================
// PAYMENT CRUD OPERATIONS
// ========================================

interface CreatePaymentData {
  userId: string; // Can be UUID or Clerk ID
  packageId: string;
  packageName: string;
  creditsAmount: number;
  amountUSD: number;
  amountBRL: number;
  preferenceId?: string;
}

interface UpdatePaymentData {
  mercadoPagoId?: string;
  status?: PaymentStatus;
  statusDetail?: string;
  paidAt?: Date;
}

interface PaymentQueryOptions {
  page?: number;
  limit?: number;
  status?: PaymentStatus;
}

/**
 * Create a new payment record
 */
export async function createPayment(data: CreatePaymentData) {
  dbLogger.info('Creating payment record', { 
    userId: data.userId, 
    packageId: data.packageId,
    amount: `$${data.amountUSD} / R$${data.amountBRL}`
  });

  // Resolve user ID (might be Clerk ID or UUID)
  let resolvedUserId = data.userId;
  
  if (data.userId.startsWith('user_')) {
    const user = await prisma.user.findUnique({
      where: { clerkId: data.userId },
      select: { id: true }
    });
    
    if (!user) {
      throw new Error(`User not found for Clerk ID: ${data.userId}`);
    }
    
    resolvedUserId = user.id;
  }

  const payment = await prisma.payment.create({
    data: {
      userId: resolvedUserId,
      packageId: data.packageId,
      packageName: data.packageName,
      creditsAmount: data.creditsAmount,
      amountUSD: data.amountUSD,
      amountBRL: data.amountBRL,
      preferenceId: data.preferenceId,
      status: 'PENDING'
    }
  });

  dbLogger.info('Payment record created', { paymentId: payment.id });
  return payment;
}

/**
 * Get payment by ID
 */
export async function getPaymentById(id: string) {
  return prisma.payment.findUnique({
    where: { id },
    include: {
      user: {
        select: {
          id: true,
          clerkId: true,
          firstName: true,
          lastName: true,
          email: true
        }
      }
    }
  });
}

/**
 * Get payment by MercadoPago ID
 */
export async function getPaymentByMercadoPagoId(mercadoPagoId: string) {
  return prisma.payment.findUnique({
    where: { mercadoPagoId }
  });
}

/**
 * Get payment by preference ID
 */
export async function getPaymentByPreferenceId(preferenceId: string) {
  return prisma.payment.findFirst({
    where: { preferenceId },
    include: {
      user: {
        select: {
          id: true,
          clerkId: true,
          credits: true
        }
      }
    }
  });
}

/**
 * Get user's payments with pagination
 */
export async function getUserPayments(
  clerkId: string,
  options: PaymentQueryOptions = {}
) {
  const {
    page = 1,
    limit = 10,
    status
  } = options;

  const skip = (page - 1) * limit;

  const where: Prisma.PaymentWhereInput = {
    user: { clerkId }
  };

  if (status) {
    where.status = status;
  }

  const total = await prisma.payment.count({ where });

  const payments = await prisma.payment.findMany({
    where,
    skip,
    take: limit,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      packageId: true,
      packageName: true,
      creditsAmount: true,
      amountUSD: true,
      amountBRL: true,
      status: true,
      statusDetail: true,
      paidAt: true,
      createdAt: true
    }
  });

  return {
    payments,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      hasMore: skip + payments.length < total
    }
  };
}

/**
 * Update payment
 */
export async function updatePayment(id: string, data: UpdatePaymentData) {
  dbLogger.info('Updating payment', { paymentId: id, updates: Object.keys(data) });

  return prisma.payment.update({
    where: { id },
    data
  });
}

/**
 * Update payment by MercadoPago ID
 */
export async function updatePaymentByMercadoPagoId(
  mercadoPagoId: string, 
  data: UpdatePaymentData
) {
  dbLogger.info('Updating payment by MercadoPago ID', { 
    mercadoPagoId, 
    updates: Object.keys(data) 
  });

  return prisma.payment.update({
    where: { mercadoPagoId },
    data
  });
}

/**
 * Process successful payment (update status and add credits)
 */
export async function processSuccessfulPayment(
  mercadoPagoId: string,
  statusDetail?: string
) {
  dbLogger.info('Processing successful payment', { mercadoPagoId });

  // Use transaction to ensure atomicity
  const result = await prisma.$transaction(async (tx) => {
    // Find payment
    const payment = await tx.payment.findUnique({
      where: { mercadoPagoId },
      include: {
        user: {
          select: { id: true, clerkId: true, credits: true }
        }
      }
    });

    if (!payment) {
      throw new Error(`Payment not found: ${mercadoPagoId}`);
    }

    // Check if already processed
    if (payment.status === 'APPROVED') {
      dbLogger.warn('Payment already processed', { mercadoPagoId });
      return { payment, alreadyProcessed: true };
    }

    // Update payment status
    const updatedPayment = await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: 'APPROVED',
        statusDetail,
        paidAt: new Date()
      }
    });

    // Add credits to user
    const updatedUser = await tx.user.update({
      where: { id: payment.userId },
      data: {
        credits: { increment: payment.creditsAmount }
      }
    });

    dbLogger.info('Payment processed successfully', {
      paymentId: payment.id,
      userId: payment.userId,
      creditsAdded: payment.creditsAmount,
      newBalance: updatedUser.credits
    });

    return {
      payment: updatedPayment,
      user: updatedUser,
      alreadyProcessed: false
    };
  });

  return result;
}

/**
 * Process failed/rejected payment
 */
export async function processFailedPayment(
  mercadoPagoId: string,
  status: 'REJECTED' | 'CANCELLED',
  statusDetail?: string
) {
  dbLogger.info('Processing failed payment', { mercadoPagoId, status });

  return prisma.payment.update({
    where: { mercadoPagoId },
    data: {
      status,
      statusDetail
    }
  });
}

/**
 * Get payment statistics for dashboard
 */
export async function getPaymentStats(clerkId: string) {
  const user = await prisma.user.findUnique({
    where: { clerkId },
    select: { id: true }
  });

  if (!user) {
    return null;
  }

  // Aggregate approved payments
  const stats = await prisma.payment.aggregate({
    where: {
      userId: user.id,
      status: 'APPROVED'
    },
    _sum: {
      amountUSD: true,
      amountBRL: true,
      creditsAmount: true
    },
    _count: { id: true }
  });

  // Payment history for chart
  const paymentHistory = await prisma.payment.findMany({
    where: {
      userId: user.id,
      status: 'APPROVED'
    },
    select: {
      packageName: true,
      creditsAmount: true,
      amountUSD: true,
      paidAt: true
    },
    orderBy: { paidAt: 'asc' },
    take: 50
  });

  return {
    totalPayments: stats._count.id,
    totalSpentUSD: stats._sum.amountUSD || 0,
    totalSpentBRL: stats._sum.amountBRL || 0,
    totalCreditsPurchased: stats._sum.creditsAmount || 0,
    paymentHistory
  };
}
