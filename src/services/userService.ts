/**
 * User Service
 * Handles user-related database operations with Clerk synchronization
 */

import { prisma, dbLogger } from './databaseService';
import { Prisma } from '@prisma/client';
import { clerkClient } from '@clerk/clerk-sdk-node';

// ========================================
// USER CRUD OPERATIONS
// ========================================

/**
 * Find or create user by Clerk ID
 * This is the primary method for ensuring user exists in local DB
 */
export async function findOrCreateUser(clerkId: string) {
  dbLogger.info('Finding or creating user', { clerkId });

  // First, try to find existing user
  let user = await prisma.user.findUnique({
    where: { clerkId }
  });

  if (user) {
    dbLogger.info('User found in database', { userId: user.id, clerkId });
    return user;
  }

  // User doesn't exist, fetch from Clerk and create
  try {
    const clerkUser = await clerkClient.users.getUser(clerkId);
    
    user = await prisma.user.create({
      data: {
        clerkId: clerkUser.id,
        email: clerkUser.emailAddresses[0]?.emailAddress || '',
        firstName: clerkUser.firstName,
        lastName: clerkUser.lastName,
        imageUrl: clerkUser.imageUrl,
        credits: (clerkUser.publicMetadata?.credits as number) || 0
      }
    });

    dbLogger.info('User created from Clerk data', { userId: user.id, clerkId });
    return user;
  } catch (error: any) {
    dbLogger.error('Failed to create user from Clerk', { clerkId, error: error.message });
    throw new Error(`Failed to sync user from Clerk: ${error.message}`);
  }
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
 * Get user by Clerk ID
 */
export async function getUserByClerkId(clerkId: string) {
  return prisma.user.findUnique({
    where: { clerkId },
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
  clerkId: string, 
  data: Prisma.UserUpdateInput
) {
  dbLogger.info('Updating user', { clerkId, updates: Object.keys(data) });

  return prisma.user.update({
    where: { clerkId },
    data
  });
}

/**
 * Update user credits
 */
export async function updateUserCredits(
  clerkId: string, 
  credits: number, 
  operation: 'add' | 'subtract' | 'set'
) {
  dbLogger.info('Updating user credits', { clerkId, credits, operation });

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
    where: { clerkId },
    data: updateData
  });

  dbLogger.info('User credits updated', { 
    clerkId, 
    newCredits: user.credits, 
    operation 
  });

  return user;
}

/**
 * Sync user data from Clerk webhook
 */
export async function syncUserFromClerk(
  clerkId: string,
  data: {
    email?: string;
    firstName?: string | null;
    lastName?: string | null;
    imageUrl?: string | null;
  }
) {
  dbLogger.info('Syncing user from Clerk webhook', { clerkId });

  return prisma.user.upsert({
    where: { clerkId },
    create: {
      clerkId,
      email: data.email || '',
      firstName: data.firstName,
      lastName: data.lastName,
      imageUrl: data.imageUrl,
      credits: 1 // Give 1 free credit on signup
    },
    update: {
      email: data.email,
      firstName: data.firstName,
      lastName: data.lastName,
      imageUrl: data.imageUrl
    }
  });
}

/**
 * Delete user (cascade deletes interviews and payments)
 */
export async function deleteUser(clerkId: string) {
  dbLogger.warn('Deleting user', { clerkId });

  return prisma.user.delete({
    where: { clerkId }
  });
}

/**
 * Get user dashboard statistics
 */
export async function getUserDashboardStats(clerkId: string) {
  const user = await prisma.user.findUnique({
    where: { clerkId },
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

  return {
    userId: user.id,
    credits: user.credits,
    totalInterviews: completedInterviews,
    averageScore: Math.round(averageScore * 10) / 10,
    totalSpent: Math.round(totalSpent * 100) / 100,
    totalCreditsPurchased,
    scoreEvolution
  };
}
