/**
 * Phone Routes
 *
 * Cookie-session protected endpoints for OTP phone verification.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireSession } from '../middleware/sessionAuthMiddleware';
import * as phoneVerificationService from '../services/phoneVerificationService';

const router = Router();

const sendOtpSchema = z.object({
  phoneNumber: z.string().min(4),
  language: z.string().optional(),
});

const verifyOtpSchema = z.object({
  phoneNumber: z.string().min(4),
  code: z.string().min(3),
});

/**
 * GET /api/phone/status
 */
router.get('/status', requireSession, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const status = await phoneVerificationService.getPhoneVerificationStatus(userId);
    return res.json({ status: 'success', data: status });
  } catch (error: any) {
    return res.status(500).json({
      status: 'error',
      message: error?.message || 'Failed to fetch phone status',
    });
  }
});

/**
 * POST /api/phone/send-otp
 */
router.post('/send-otp', requireSession, async (req: Request, res: Response) => {
  const parsed = sendOtpSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ status: 'error', message: 'Invalid request' });
  }

  try {
    const userId = req.userId!;
    const { phoneNumber, language } = parsed.data;
    const result = await phoneVerificationService.sendOTP(phoneNumber, userId, language);

    if (!result.success) {
      return res.status(400).json({
        status: 'error',
        message: result.error || 'Failed to send verification code',
        remainingAttempts: result.remainingAttempts,
        rateLimited: result.rateLimited,
        code: (result as any).code,
      });
    }

    return res.json({
      status: 'success',
      message: 'Verification code sent',
      remainingAttempts: result.remainingAttempts,
    });
  } catch (error: any) {
    return res.status(500).json({
      status: 'error',
      message: error?.message || 'Failed to send verification code',
    });
  }
});

/**
 * POST /api/phone/verify-otp
 */
router.post('/verify-otp', requireSession, async (req: Request, res: Response) => {
  const parsed = verifyOtpSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ status: 'error', message: 'Invalid request' });
  }

  try {
    const userId = req.userId!;
    const { phoneNumber, code } = parsed.data;
    const result = await phoneVerificationService.verifyOTP(phoneNumber, code, userId);

    if (!result.success) {
      return res.status(400).json({
        status: 'error',
        message: result.error || 'Failed to verify code',
        verified: false,
        attemptsRemaining: result.attemptsRemaining,
      });
    }

    return res.json({
      status: 'success',
      message: result.valid ? 'Phone verified' : 'Invalid code',
      verified: result.valid,
      attemptsRemaining: result.attemptsRemaining,
    });
  } catch (error: any) {
    return res.status(500).json({
      status: 'error',
      message: error?.message || 'Failed to verify code',
    });
  }
});

/**
 * POST /api/phone/skip-for-credits
 * 
 * Records that user skipped phone verification during onboarding.
 * Used for dashboard CTA targeting (reminder to verify for credits).
 */
router.post('/skip-for-credits', requireSession, async (req: Request, res: Response) => {
  const userId = req.userId!;
  const startTime = Date.now();
  
  console.log('[PhoneRoutes] skip-for-credits: request received', { userId });
  
  try {
    const success = await phoneVerificationService.skipPhoneVerificationForCredits(userId);

    const duration = Date.now() - startTime;
    
    if (!success) {
      console.warn('[PhoneRoutes] skip-for-credits: failed to record', { 
        userId, 
        durationMs: duration 
      });
      return res.status(400).json({ status: 'error', message: 'Failed to record skip preference' });
    }

    console.log('[PhoneRoutes] skip-for-credits: success', { 
      userId, 
      durationMs: duration 
    });
    
    return res.json({ status: 'success', message: 'Skip preference recorded' });
  } catch (error: any) {
    const duration = Date.now() - startTime;
    console.error('[PhoneRoutes] skip-for-credits: exception', { 
      userId, 
      error: error?.message,
      durationMs: duration 
    });
    
    return res.status(500).json({
      status: 'error',
      message: error?.message || 'Failed to record skip preference',
    });
  }
});

export default router;
