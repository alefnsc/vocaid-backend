/**
 * Webhook Verification Service
 * 
 * Provides signature verification for payment webhooks
 * to prevent unauthorized requests and replay attacks.
 * 
 * Supports:
 * - MercadoPago (HMAC-SHA256)
 * - PayPal (future)
 * 
 * @module services/webhookVerificationService
 */

import crypto from 'crypto';
import { paymentLogger } from '../utils/logger';

// ========================================
// TYPES
// ========================================

export interface WebhookVerificationResult {
  valid: boolean;
  error?: string;
  provider: 'mercadopago' | 'paypal';
}

// ========================================
// MERCADOPAGO VERIFICATION
// ========================================

/**
 * Verify MercadoPago webhook signature
 * 
 * MercadoPago sends the signature in the x-signature header
 * Format: ts=<timestamp>,v1=<signature>
 * 
 * The signature is calculated as:
 * HMAC-SHA256(id.<data_id>;request-id.<x-request-id>;ts.<timestamp>;, secret)
 * 
 * @see https://www.mercadopago.com.br/developers/en/docs/your-integrations/notifications/webhooks
 */
export function verifyMercadoPagoSignature(
  headers: Record<string, string | string[] | undefined>,
  dataId: string
): WebhookVerificationResult {
  const secret = process.env.MERCADOPAGO_WEBHOOK_SECRET;
  
  // If no secret configured, log warning but allow (for development)
  if (!secret) {
    paymentLogger.warn('MERCADOPAGO_WEBHOOK_SECRET not configured - skipping signature verification');
    return { valid: true, provider: 'mercadopago', error: 'No secret configured - verification skipped' };
  }
  
  const xSignature = headers['x-signature'] as string | undefined;
  const xRequestId = headers['x-request-id'] as string | undefined;
  
  if (!xSignature) {
    paymentLogger.warn('Missing x-signature header in MercadoPago webhook');
    return { valid: false, provider: 'mercadopago', error: 'Missing x-signature header' };
  }
  
  if (!xRequestId) {
    paymentLogger.warn('Missing x-request-id header in MercadoPago webhook');
    return { valid: false, provider: 'mercadopago', error: 'Missing x-request-id header' };
  }
  
  try {
    // Parse the x-signature header
    // Format: ts=<timestamp>,v1=<signature>
    const signatureParts: Record<string, string> = {};
    xSignature.split(',').forEach(part => {
      const [key, value] = part.split('=');
      if (key && value) {
        signatureParts[key.trim()] = value.trim();
      }
    });
    
    const timestamp = signatureParts['ts'];
    const receivedSignature = signatureParts['v1'];
    
    if (!timestamp || !receivedSignature) {
      paymentLogger.warn('Invalid x-signature format', { xSignature });
      return { valid: false, provider: 'mercadopago', error: 'Invalid x-signature format' };
    }
    
    // Check timestamp to prevent replay attacks (5 minute window)
    const webhookTime = parseInt(timestamp, 10) * 1000; // Convert to milliseconds
    const now = Date.now();
    const fiveMinutes = 5 * 60 * 1000;
    
    if (Math.abs(now - webhookTime) > fiveMinutes) {
      paymentLogger.warn('Webhook timestamp outside acceptable window', {
        webhookTime: new Date(webhookTime).toISOString(),
        serverTime: new Date(now).toISOString(),
        diffSeconds: Math.abs(now - webhookTime) / 1000
      });
      return { valid: false, provider: 'mercadopago', error: 'Timestamp outside acceptable window' };
    }
    
    // Build the signed payload
    // Format: id.<data_id>;request-id.<x-request-id>;ts.<timestamp>;
    const signedPayload = `id.${dataId};request-id.${xRequestId};ts.${timestamp};`;
    
    // Calculate expected signature
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(signedPayload)
      .digest('hex');
    
    // Use timing-safe comparison to prevent timing attacks
    const signaturesMatch = crypto.timingSafeEqual(
      Buffer.from(receivedSignature),
      Buffer.from(expectedSignature)
    );
    
    if (!signaturesMatch) {
      paymentLogger.warn('MercadoPago webhook signature mismatch', {
        dataId,
        requestId: xRequestId
      });
      return { valid: false, provider: 'mercadopago', error: 'Signature mismatch' };
    }
    
    paymentLogger.info('MercadoPago webhook signature verified successfully', {
      dataId,
      requestId: xRequestId
    });
    
    return { valid: true, provider: 'mercadopago' };
    
  } catch (error: any) {
    paymentLogger.error('Error verifying MercadoPago signature', { error: error.message });
    return { valid: false, provider: 'mercadopago', error: error.message };
  }
}

// ========================================
// PAYPAL VERIFICATION (FUTURE)
// ========================================

/**
 * Verify PayPal webhook signature
 * 
 * PayPal uses a different verification mechanism that requires
 * calling PayPal's verify-webhook-signature API.
 * 
 * @see https://developer.paypal.com/docs/api-basics/notifications/webhooks/notification-messages/
 */
export async function verifyPayPalSignature(
  headers: Record<string, string | string[] | undefined>,
  body: string
): Promise<WebhookVerificationResult> {
  // TODO: Implement PayPal webhook verification
  // This requires calling PayPal's verify-webhook-signature API
  paymentLogger.warn('PayPal webhook verification not yet implemented');
  return { valid: false, provider: 'paypal', error: 'Not implemented' };
}

// ========================================
// IDEMPOTENCY HELPERS
// ========================================

/**
 * Generate an idempotency key for webhook processing
 * Combines provider, payment ID, and action for uniqueness
 */
export function generateWebhookIdempotencyKey(
  provider: 'mercadopago' | 'paypal',
  paymentId: string,
  action?: string
): string {
  const components = [provider, paymentId];
  if (action) {
    components.push(action);
  }
  return components.join(':');
}

/**
 * Check if a webhook has already been processed
 * Uses the payment table to check for existing processing
 */
export async function isWebhookAlreadyProcessed(
  prisma: any,
  idempotencyKey: string
): Promise<boolean> {
  const existing = await prisma.payment.findFirst({
    where: { webhookIdempotencyKey: idempotencyKey },
    select: { webhookProcessedAt: true }
  });
  
  return existing?.webhookProcessedAt != null;
}
