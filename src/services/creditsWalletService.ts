/**
 * Credits Wallet Service
 * 
 * Handles all credit operations with proper transaction support and audit logging.
 * Uses the CreditsWallet and CreditLedger models for atomic operations.
 * 
 * @module services/creditsWalletService
 */

import { PrismaClient, CreditTransactionType, Prisma } from '@prisma/client';
import { dbLogger } from './databaseService';

const prisma = new PrismaClient();

// ========================================
// CONFIGURATION
// ========================================

// New accounts receive 15 free trial credits (was 1)
const FREE_TRIAL_CREDITS = parseInt(process.env.FREE_TRIAL_CREDITS || '5', 10);

// ========================================
// TYPES
// ========================================

export interface CreditTransaction {
  type: CreditTransactionType;
  amount: number;
  description: string;
  referenceType?: string;
  referenceId?: string;
  metadata?: Record<string, any>;
  idempotencyKey?: string;
}

export interface WalletBalance {
  balance: number;
  totalEarned: number;
  totalSpent: number;
  totalPurchased: number;
  totalGranted: number;
}

export interface TransactionResult {
  success: boolean;
  newBalance: number;
  ledgerEntryId: string;
  error?: string;
}

// ========================================
// WALLET OPERATIONS
// ========================================

/**
 * Get or create a user's credits wallet
 */
export async function getOrCreateWallet(userId: string) {
  let wallet = await prisma.creditsWallet.findUnique({
    where: { userId }
  });

  if (!wallet) {
    // Get user's current credits from User table (for migration)
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { credits: true }
    });

    wallet = await prisma.creditsWallet.create({
      data: {
        userId,
        balance: user?.credits || 0,
        totalEarned: user?.credits || 0,
        totalGranted: user?.credits || 0 // Assume existing credits were granted
      }
    });

    dbLogger.info('Created credits wallet for user', { userId, initialBalance: wallet.balance });
  }

  return wallet;
}

/**
 * Get wallet balance for a user
 */
export async function getWalletBalance(userId: string): Promise<WalletBalance> {
  const wallet = await getOrCreateWallet(userId);
  
  return {
    balance: wallet.balance,
    totalEarned: wallet.totalEarned,
    totalSpent: wallet.totalSpent,
    totalPurchased: wallet.totalPurchased,
    totalGranted: wallet.totalGranted
  };
}

/**
 * Check if user has sufficient credits
 */
export async function hasCredits(userId: string, amount: number = 1): Promise<boolean> {
  const wallet = await getOrCreateWallet(userId);
  return wallet.balance >= amount;
}

// ========================================
// CREDIT TRANSACTIONS (with audit logging)
// ========================================

/**
 * Add credits to user's wallet (purchase, grant, refund, etc.)
 * Creates an immutable ledger entry for audit trail.
 */
export async function addCredits(
  userId: string,
  transaction: CreditTransaction
): Promise<TransactionResult> {
  const { type, amount, description, referenceType, referenceId, metadata, idempotencyKey } = transaction;

  if (amount <= 0) {
    return { success: false, newBalance: 0, ledgerEntryId: '', error: 'Amount must be positive' };
  }

  // Check idempotency
  if (idempotencyKey) {
    const existing = await prisma.creditLedger.findUnique({
      where: { idempotencyKey }
    });
    if (existing) {
      dbLogger.info('Duplicate transaction prevented by idempotency key', { idempotencyKey });
      return { success: true, newBalance: existing.balanceAfter, ledgerEntryId: existing.id };
    }
  }

  try {
    // Use transaction for atomicity
    const result = await prisma.$transaction(async (tx) => {
      // Get or create wallet
      let wallet = await tx.creditsWallet.findUnique({ where: { userId } });
      
      if (!wallet) {
        const user = await tx.user.findUnique({ where: { id: userId }, select: { credits: true } });
        wallet = await tx.creditsWallet.create({
          data: {
            userId,
            balance: user?.credits || 0,
            totalEarned: user?.credits || 0,
            totalGranted: user?.credits || 0
          }
        });
      }

      const newBalance = wallet.balance + amount;

      // Update wallet
      const updatedWallet = await tx.creditsWallet.update({
        where: { userId },
        data: {
          balance: newBalance,
          totalEarned: { increment: amount },
          lastCreditAt: new Date(),
          // Update category-specific totals
          ...(type === 'PURCHASE' && { totalPurchased: { increment: amount } }),
          ...(['GRANT', 'PROMO', 'REFERRAL'].includes(type) && { totalGranted: { increment: amount } })
        }
      });

      // Create ledger entry
      const ledgerEntry = await tx.creditLedger.create({
        data: {
          userId,
          type,
          amount,
          balanceAfter: newBalance,
          referenceType,
          referenceId,
          description,
          metadata: metadata ? metadata : Prisma.JsonNull,
          idempotencyKey
        }
      });

      // Sync to User.credits for backward compatibility
      await tx.user.update({
        where: { id: userId },
        data: { credits: newBalance }
      });

      return { wallet: updatedWallet, ledgerEntry };
    });

    dbLogger.info('Credits added successfully', {
      userId,
      type,
      amount,
      newBalance: result.wallet.balance,
      ledgerEntryId: result.ledgerEntry.id
    });

    return {
      success: true,
      newBalance: result.wallet.balance,
      ledgerEntryId: result.ledgerEntry.id
    };
  } catch (error: any) {
    dbLogger.error('Failed to add credits', { userId, type, amount, error: error.message });
    return { success: false, newBalance: 0, ledgerEntryId: '', error: error.message };
  }
}

/**
 * Spend credits from user's wallet
 * Returns false if insufficient balance.
 */
export async function spendCredits(
  userId: string,
  amount: number,
  description: string,
  referenceType?: string,
  referenceId?: string,
  idempotencyKey?: string
): Promise<TransactionResult> {
  if (amount <= 0) {
    return { success: false, newBalance: 0, ledgerEntryId: '', error: 'Amount must be positive' };
  }

  // Check idempotency
  if (idempotencyKey) {
    const existing = await prisma.creditLedger.findUnique({
      where: { idempotencyKey }
    });
    if (existing) {
      dbLogger.info('Duplicate spend prevented by idempotency key', { idempotencyKey });
      return { success: true, newBalance: existing.balanceAfter, ledgerEntryId: existing.id };
    }
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Get wallet with lock
      const wallet = await tx.creditsWallet.findUnique({ where: { userId } });
      
      if (!wallet || wallet.balance < amount) {
        throw new Error('Insufficient credits');
      }

      const newBalance = wallet.balance - amount;

      // Update wallet
      const updatedWallet = await tx.creditsWallet.update({
        where: { userId },
        data: {
          balance: newBalance,
          totalSpent: { increment: amount },
          lastDebitAt: new Date()
        }
      });

      // Create ledger entry
      const ledgerEntry = await tx.creditLedger.create({
        data: {
          userId,
          type: 'SPEND',
          amount,
          balanceAfter: newBalance,
          referenceType,
          referenceId,
          description,
          idempotencyKey
        }
      });

      // Sync to User.credits for backward compatibility
      await tx.user.update({
        where: { id: userId },
        data: { credits: newBalance }
      });

      return { wallet: updatedWallet, ledgerEntry };
    });

    dbLogger.info('Credits spent successfully', {
      userId,
      amount,
      newBalance: result.wallet.balance,
      ledgerEntryId: result.ledgerEntry.id
    });

    return {
      success: true,
      newBalance: result.wallet.balance,
      ledgerEntryId: result.ledgerEntry.id
    };
  } catch (error: any) {
    if (error.message === 'Insufficient credits') {
      dbLogger.warn('Insufficient credits for spend', { userId, amount });
      return { success: false, newBalance: 0, ledgerEntryId: '', error: 'Insufficient credits' };
    }
    dbLogger.error('Failed to spend credits', { userId, amount, error: error.message });
    return { success: false, newBalance: 0, ledgerEntryId: '', error: error.message };
  }
}

/**
 * Restore credits (e.g., when user quits interview early)
 */
export async function restoreCredits(
  userId: string,
  amount: number,
  description: string,
  referenceType?: string,
  referenceId?: string
): Promise<TransactionResult> {
  return addCredits(userId, {
    type: 'RESTORE',
    amount,
    description,
    referenceType,
    referenceId
  });
}

/**
 * Grant free trial credits to a new user
 */
export async function grantFreeTrialCredits(
  userId: string,
  idempotencyKey?: string
): Promise<TransactionResult> {
  return addCredits(userId, {
    type: 'GRANT',
    amount: FREE_TRIAL_CREDITS,
    description: `Free trial credits (${FREE_TRIAL_CREDITS})`,
    referenceType: 'signup',
    idempotencyKey: idempotencyKey || `free_trial_${userId}`
  });
}

/**
 * Initialize wallet with signup bonus (alias for grantFreeTrialCredits)
 * Used when a new user signs up to set up their wallet with initial credits
 */
export async function initializeWalletWithBonus(
  userId: string,
  bonusCredits?: number
): Promise<TransactionResult> {
  const credits = bonusCredits ?? FREE_TRIAL_CREDITS;
  return addCredits(userId, {
    type: 'GRANT',
    amount: credits,
    description: `Signup bonus (${credits} credits)`,
    referenceType: 'signup',
    idempotencyKey: `signup_bonus_${userId}`
  });
}

/**
 * Add purchased credits after successful payment
 */
export async function addPurchasedCredits(
  userId: string,
  amount: number,
  paymentId: string,
  packageName: string
): Promise<TransactionResult> {
  return addCredits(userId, {
    type: 'PURCHASE',
    amount,
    description: `Purchased ${packageName} package (${amount} credits)`,
    referenceType: 'payment',
    referenceId: paymentId,
    idempotencyKey: `payment_${paymentId}`
  });
}

/**
 * Refund credits from a cancelled/refunded payment
 */
export async function refundCredits(
  userId: string,
  amount: number,
  paymentId: string,
  reason: string
): Promise<TransactionResult> {
  return addCredits(userId, {
    type: 'REFUND',
    amount,
    description: `Refund: ${reason}`,
    referenceType: 'payment',
    referenceId: paymentId,
    idempotencyKey: `refund_${paymentId}`
  });
}

// ========================================
// LEDGER QUERIES
// ========================================

/**
 * Get credit transaction history for a user
 */
export async function getTransactionHistory(
  userId: string,
  options: {
    limit?: number;
    offset?: number;
    type?: CreditTransactionType;
  } = {}
) {
  const { limit = 50, offset = 0, type } = options;

  const where: Prisma.CreditLedgerWhereInput = { userId };
  if (type) {
    where.type = type;
  }

  const [transactions, total] = await Promise.all([
    prisma.creditLedger.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset
    }),
    prisma.creditLedger.count({ where })
  ]);

  return { transactions, total, limit, offset };
}

/**
 * Get summary of credit activity for analytics
 */
export async function getCreditsSummary(userId: string) {
  const wallet = await getOrCreateWallet(userId);
  
  // Get recent transactions
  const recentTransactions = await prisma.creditLedger.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 10
  });

  // Get transaction counts by type
  const transactionsByType = await prisma.creditLedger.groupBy({
    by: ['type'],
    where: { userId },
    _count: true,
    _sum: { amount: true }
  });

  return {
    wallet: {
      balance: wallet.balance,
      totalEarned: wallet.totalEarned,
      totalSpent: wallet.totalSpent,
      totalPurchased: wallet.totalPurchased,
      totalGranted: wallet.totalGranted,
      lastCreditAt: wallet.lastCreditAt,
      lastDebitAt: wallet.lastDebitAt
    },
    recentTransactions,
    transactionsByType
  };
}

// ========================================
// EXPORTS
// ========================================

export default {
  getOrCreateWallet,
  getWalletBalance,
  hasCredits,
  addCredits,
  spendCredits,
  restoreCredits,
  grantFreeTrialCredits,
  addPurchasedCredits,
  refundCredits,
  getTransactionHistory,
  getCreditsSummary
};
