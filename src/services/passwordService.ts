/**
 * Password Service
 * 
 * Handles password hashing (Argon2id), validation, and reset token management.
 * This is the foundation for DB-based auth.
 * 
 * @module services/passwordService
 */

import * as argon2 from 'argon2';
import * as crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import logger from '../utils/logger';

const prisma = new PrismaClient();
const passwordLogger = logger.child({ service: 'password' });

// ========================================
// PASSWORD POLICY CONSTANTS
// ========================================

/**
 * Password Policy:
 * - At least 8 characters
 * - At least 3 of the following 4 classes:
 *   - Lower case letters (a-z)
 *   - Upper case letters (A-Z)
 *   - Numbers (0-9)
 *   - Special characters (!@#$%^&*()_+-=[]{}|;':",.<>?/`~)
 * - No more than 2 identical characters in a row
 */
export const PASSWORD_POLICY = {
  minLength: 8,
  requiredClasses: 3,
  maxConsecutiveIdentical: 2,
};

// ========================================
// PASSWORD VALIDATION
// ========================================

export interface PasswordValidationResult {
  isValid: boolean;
  errors: string[];
  checks: {
    length: boolean;
    hasLowercase: boolean;
    hasUppercase: boolean;
    hasNumber: boolean;
    hasSpecial: boolean;
    classCount: number;
    noConsecutiveRepeats: boolean;
  };
}

/**
 * Validate password against policy
 */
export function validatePassword(password: string): PasswordValidationResult {
  const errors: string[] = [];
  
  // Length check
  const lengthOk = password.length >= PASSWORD_POLICY.minLength;
  if (!lengthOk) {
    errors.push(`Password must be at least ${PASSWORD_POLICY.minLength} characters`);
  }
  
  // Character class checks
  const hasLowercase = /[a-z]/.test(password);
  const hasUppercase = /[A-Z]/.test(password);
  const hasNumber = /[0-9]/.test(password);
  const hasSpecial = /[!@#$%^&*()_+\-=\[\]{}|;':",.<>?/`~\\]/.test(password);
  
  const classCount = [hasLowercase, hasUppercase, hasNumber, hasSpecial].filter(Boolean).length;
  
  if (classCount < PASSWORD_POLICY.requiredClasses) {
    errors.push(
      `Password must contain at least ${PASSWORD_POLICY.requiredClasses} of the following: ` +
      'lowercase letters, uppercase letters, numbers, special characters'
    );
  }
  
  // Consecutive identical characters check
  const consecutivePattern = /(.)\1{2,}/;
  const noConsecutiveRepeats = !consecutivePattern.test(password);
  
  if (!noConsecutiveRepeats) {
    errors.push('Password cannot have more than 2 identical characters in a row');
  }
  
  return {
    isValid: errors.length === 0,
    errors,
    checks: {
      length: lengthOk,
      hasLowercase,
      hasUppercase,
      hasNumber,
      hasSpecial,
      classCount,
      noConsecutiveRepeats,
    },
  };
}

// ========================================
// PASSWORD HASHING (Argon2id)
// ========================================

/**
 * Argon2id configuration (OWASP recommended)
 * Using argon2id which is resistant to both GPU and side-channel attacks
 */
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 65536,    // 64 MB
  timeCost: 3,          // 3 iterations
  parallelism: 4,       // 4 parallel threads
};

/**
 * Hash a password using Argon2id
 */
export async function hashPassword(password: string): Promise<string> {
  try {
    const hash = await argon2.hash(password, ARGON2_OPTIONS);
    return hash;
  } catch (error: any) {
    passwordLogger.error('Failed to hash password', { error: error.message });
    throw new Error('Password hashing failed');
  }
}

/**
 * Verify a password against a hash
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch (error: any) {
    passwordLogger.error('Failed to verify password', { error: error.message });
    return false;
  }
}

// ========================================
// PASSWORD RESET TOKENS
// ========================================

const RESET_TOKEN_BYTES = 32; // 256 bits
const RESET_TOKEN_EXPIRY_HOURS = 1; // 1 hour

/**
 * Generate a cryptographically secure reset token
 * Returns both the raw token (to send to user) and the hash (to store)
 */
export function generateResetToken(): { rawToken: string; tokenHash: string } {
  const rawToken = crypto.randomBytes(RESET_TOKEN_BYTES).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  
  return { rawToken, tokenHash };
}

/**
 * Hash a reset token for lookup
 */
export function hashResetToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Create a password reset token for a user
 */
export async function createPasswordResetToken(
  userId: string,
  ipAddress?: string,
  userAgent?: string
): Promise<{ rawToken: string; expiresAt: Date }> {
  const { rawToken, tokenHash } = generateResetToken();
  const expiresAt = new Date(Date.now() + RESET_TOKEN_EXPIRY_HOURS * 60 * 60 * 1000);
  
  // Invalidate any existing tokens for this user
  await prisma.passwordResetToken.updateMany({
    where: {
      userId,
      usedAt: null,
    },
    data: {
      usedAt: new Date(), // Mark as used to invalidate
    },
  });
  
  // Create new token
  await prisma.passwordResetToken.create({
    data: {
      userId,
      tokenHash,
      expiresAt,
      ipAddress,
      userAgent,
    },
  });
  
  passwordLogger.info('Password reset token created', { userId });
  
  return { rawToken, expiresAt };
}

/**
 * Validate and consume a password reset token
 * Returns the userId if valid, null otherwise
 */
export async function consumePasswordResetToken(
  rawToken: string
): Promise<{ userId: string } | null> {
  const tokenHash = hashResetToken(rawToken);
  
  const token = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });
  
  if (!token) {
    passwordLogger.warn('Password reset token not found');
    return null;
  }
  
  if (token.usedAt) {
    passwordLogger.warn('Password reset token already used', { tokenId: token.id });
    return null;
  }
  
  if (token.expiresAt < new Date()) {
    passwordLogger.warn('Password reset token expired', { tokenId: token.id });
    return null;
  }
  
  // Mark token as used
  await prisma.passwordResetToken.update({
    where: { id: token.id },
    data: { usedAt: new Date() },
  });
  
  passwordLogger.info('Password reset token consumed', { userId: token.userId });
  
  return { userId: token.userId };
}

// ========================================
// PASSWORD UPDATE
// ========================================

/**
 * Update a user's password (after validation)
 */
export async function updateUserPassword(
  userId: string,
  newPassword: string
): Promise<boolean> {
  // Validate password first
  const validation = validatePassword(newPassword);
  if (!validation.isValid) {
    passwordLogger.warn('Password update rejected - policy violation', { 
      userId, 
      errors: validation.errors 
    });
    throw new Error(validation.errors.join('. '));
  }
  
  const passwordHash = await hashPassword(newPassword);
  
  await prisma.user.update({
    where: { id: userId },
    data: {
      passwordHash,
    },
  });
  
  passwordLogger.info('Password updated successfully', { userId });
  
  return true;
}

/**
 * Set password for a user (first-time setup, e.g., after OAuth)
 * Same as update but with different semantics
 */
export async function setUserPassword(
  userId: string,
  password: string
): Promise<boolean> {
  return updateUserPassword(userId, password);
}

/**
 * Check if a user has a password set
 */
export async function userHasPassword(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true },
  });
  
  return !!user?.passwordHash;
}

/**
 * Authenticate user with email and password
 */
export async function authenticateUser(
  email: string,
  password: string
): Promise<{ userId: string } | null> {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
    select: { id: true, passwordHash: true, isActive: true },
  });
  
  if (!user || !user.passwordHash) {
    passwordLogger.debug('Auth failed - user not found or no password', { email });
    return null;
  }
  
  if (!user.isActive) {
    passwordLogger.debug('Auth failed - user inactive', { email });
    return null;
  }
  
  const isValid = await verifyPassword(password, user.passwordHash);
  
  if (!isValid) {
    passwordLogger.debug('Auth failed - invalid password', { email });
    return null;
  }
  
  passwordLogger.info('User authenticated successfully', { userId: user.id });
  
  return { userId: user.id };
}

// ========================================
// EXPORTS
// ========================================

export default {
  validatePassword,
  hashPassword,
  verifyPassword,
  generateResetToken,
  hashResetToken,
  createPasswordResetToken,
  consumePasswordResetToken,
  updateUserPassword,
  setUserPassword,
  userHasPassword,
  authenticateUser,
  PASSWORD_POLICY,
};
