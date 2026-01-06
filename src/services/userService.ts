/**
 * User Service
 * Handles user-related database operations
 */

import { prisma, dbLogger } from './databaseService';
import { Prisma } from '@prisma/client';

// ========================================
// USER CRUD OPERATIONS
// ========================================

/**
 * Find user by ID (DB UUID)
 */
export async function findUserById(userId: string) {
  dbLogger.info('Finding user by ID', { userId });

  const user = await prisma.user.findUnique({
    where: { id: userId }
  });

  if (user) {
    dbLogger.info('User found in database', { userId: user.id });
    return user;
  }

  dbLogger.warn('User not found', { userId });
  return null;
}

/**
 * Alias for findUserById (backward compatibility)
 */
export async function findOrCreateUser(userId: string) {
  return findUserById(userId);
}

/**
 * Get user by internal UUID
 */
export async function getUserById(id: string) {
  return prisma.user.findUnique({
    where: { id },
    include: {
      _count: {
        select: {
          interviews: true,
          payments: true
        }
      }
    }
  });
}

/**
 * Update user profile
 */
export async function updateUser(
  userId: string, 
  data: Prisma.UserUpdateInput
) {
  dbLogger.info('Updating user', { userId, updates: Object.keys(data) });

  return prisma.user.update({
    where: { id: userId },
    data
  });
}

/**
 * Update user credits
 */
export async function updateUserCredits(
  userId: string, 
  credits: number, 
  operation: 'add' | 'subtract' | 'set'
) {
  dbLogger.info('Updating user credits', { userId, credits, operation });

  const updateData: Prisma.UserUpdateInput = {};

  switch (operation) {
    case 'add':
      updateData.credits = { increment: credits };
      break;
    case 'subtract':
      updateData.credits = { decrement: credits };
      break;
    case 'set':
      updateData.credits = credits;
      break;
  }

  const user = await prisma.user.update({
    where: { id: userId },
    data: updateData
  });

  dbLogger.info('User credits updated', { 
    userId, 
    newCredits: user.credits, 
    operation 
  });

  return user;
}

/**
 * Delete user (cascade deletes interviews and payments)
 */
export async function deleteUser(userId: string) {
  dbLogger.warn('Deleting user', { userId });

  return prisma.user.delete({
    where: { id: userId }
  });
}

/**
 * Get user dashboard statistics
 */
export async function getUserDashboardStats(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      interviews: {
        where: { status: 'COMPLETED' },
        select: {
          score: true,
          createdAt: true
        },
        orderBy: { createdAt: 'asc' }
      },
      payments: {
        where: { status: 'APPROVED' },
        select: {
          amountUSD: true,
          creditsAmount: true,
          createdAt: true
        }
      }
    }
  });

  if (!user) {
    return null;
  }

  // Calculate statistics
  const completedInterviews = user.interviews.length;
  const averageScore = completedInterviews > 0
    ? user.interviews.reduce((sum, i) => sum + (i.score || 0), 0) / completedInterviews
    : 0;
  
  const totalSpent = user.payments.reduce((sum, p) => sum + p.amountUSD, 0);
  const totalCreditsPurchased = user.payments.reduce((sum, p) => sum + p.creditsAmount, 0);

  // Score evolution (for chart)
  const scoreEvolution = user.interviews.map(i => ({
    date: i.createdAt,
    score: i.score
  }));

  // Calculate interviews this month
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const interviewsThisMonth = user.interviews.filter(i => 
    new Date(i.createdAt) >= startOfMonth
  ).length;

  // Calculate score change (compare last month vs current month)
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);
  
  const lastMonthInterviews = user.interviews.filter(i => {
    const date = new Date(i.createdAt);
    return date >= startOfLastMonth && date <= endOfLastMonth;
  });
  
  const thisMonthInterviews = user.interviews.filter(i => 
    new Date(i.createdAt) >= startOfMonth
  );
  
  const lastMonthAvg = lastMonthInterviews.length > 0
    ? lastMonthInterviews.reduce((sum, i) => sum + (i.score || 0), 0) / lastMonthInterviews.length
    : 0;
  
  const thisMonthAvg = thisMonthInterviews.length > 0
    ? thisMonthInterviews.reduce((sum, i) => sum + (i.score || 0), 0) / thisMonthInterviews.length
    : 0;
  
  const scoreChange = lastMonthAvg > 0 
    ? Math.round(((thisMonthAvg - lastMonthAvg) / lastMonthAvg) * 100)
    : 0;

  return {
    userId: user.id,
    credits: user.credits,
    creditsRemaining: user.credits,
    totalInterviews: completedInterviews,
    completedInterviews,
    averageScore: Math.round(averageScore * 10) / 10,
    totalSpent: Math.round(totalSpent * 100) / 100,
    totalCreditsPurchased,
    scoreEvolution,
    interviewsThisMonth,
    scoreChange
  };
}
