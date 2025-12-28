import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';
import { clerkClient } from '@clerk/express';
import { paymentLogger } from '../utils/logger';
import { updateUserCredits, getUserFromDatabase } from './clerkService';
import { addPurchasedCredits, getWalletBalance } from './creditsWalletService';
import { sendPurchaseReceiptEmail, PurchaseEmailData, UserEmailData } from './transactionalEmailService';

// Import payment service for database operations (lazy to avoid circular deps)
let paymentDbService: typeof import('./paymentService') | null = null;
const getPaymentDbService = async () => {
  if (!paymentDbService) {
    paymentDbService = await import('./paymentService');
  }
  return paymentDbService;
};

/**
 * Mercado Pago Service for payment processing
 * Documentation: https://www.mercadopago.com.br/developers/pt/docs
 * 
 * Credential Selection Logic:
 * - Development (NODE_ENV=development): Uses TEST credentials (sandbox)
 * - Production (NODE_ENV=production): Uses PROD credentials (live)
 */

// Environment-based credential selection
const isProduction = process.env.NODE_ENV === 'production';

export const getMercadoPagoCredentials = () => {
  const accessToken = isProduction
    ? process.env.MERCADOPAGO_ACCESS_TOKEN
    : process.env.MERCADOPAGO_TEST_ACCESS_TOKEN || process.env.MERCADOPAGO_ACCESS_TOKEN;
  
  const publicKey = isProduction
    ? process.env.MERCADOPAGO_PUBLIC_KEY
    : process.env.MERCADOPAGO_TEST_PUBLIC_KEY || process.env.MERCADOPAGO_PUBLIC_KEY;

  if (!accessToken) {
    throw new Error(
      `MercadoPago access token not configured. ` +
      `Set ${isProduction ? 'MERCADOPAGO_ACCESS_TOKEN' : 'MERCADOPAGO_TEST_ACCESS_TOKEN'} in your .env file.`
    );
  }

  paymentLogger.info('MercadoPago credentials loaded', {
    environment: isProduction ? 'production' : 'development',
    mode: isProduction ? 'LIVE' : 'SANDBOX',
    publicKeyPrefix: publicKey?.substring(0, 15) + '...',
  });

  return { accessToken, publicKey };
};

export interface CreditPackage {
  id: string;
  name: string;
  credits: number;
  priceUSD: number;   // Display price in USD
  priceBRL: number;   // Payment price in BRL for MercadoPago
  description: string;
}

export const CREDIT_PACKAGES: Record<string, CreditPackage> = {
  starter: {
    id: 'starter',
    name: 'Starter',
    credits: 5,
    priceUSD: 3.99,
    priceBRL: 23.94,
    description: 'Perfect to get started'
  },
  intermediate: {
    id: 'intermediate',
    name: 'Intermediate',
    credits: 10,
    priceUSD: 5.99,
    priceBRL: 35.94,
    description: 'Great for focused preparation'
  },
  professional: {
    id: 'professional',
    name: 'Professional',
    credits: 15,
    priceUSD: 7.99,
    priceBRL: 47.94,
    description: 'Ideal for regular practice'
  }
};

export class MercadoPagoService {
  private client: MercadoPagoConfig;
  private preference: Preference;
  private payment: Payment;

  constructor(accessToken: string) {
    this.client = new MercadoPagoConfig({
      accessToken: accessToken,
      options: {
        timeout: 5000
      }
    });

    this.preference = new Preference(this.client);
    this.payment = new Payment(this.client);
  }

  /**
   * Create payment preference
   */
  async createPreference(packageId: string, userId: string, userEmail: string) {
    try {
      const pkg = CREDIT_PACKAGES[packageId];
      
      if (!pkg) {
        throw new Error('Invalid package ID');
      }

      paymentLogger.info('Creating payment preference', { 
        packageId, 
        userId, 
        userEmail,
        priceUSD: pkg.priceUSD,
        priceBRL: pkg.priceBRL
      });

      const frontendUrl = process.env.FRONTEND_URL;
      const webhookUrl = process.env.WEBHOOK_BASE_URL;

      // Validate frontend URL is set - required for MercadoPago redirects
      if (!frontendUrl) {
        paymentLogger.error('FRONTEND_URL environment variable is not set!');
        throw new Error('Server configuration error: FRONTEND_URL is required for payment processing');
      }

      // Check if frontend URL is localhost (MercadoPago doesn't accept localhost for back_urls)
      const isLocalhost = frontendUrl.includes('localhost') || frontendUrl.includes('127.0.0.1');

      // Build preference data - only include optional fields if URLs are configured
      // NOTE: MercadoPago only accepts BRL, so we use priceBRL for the payment
      const preferenceData: any = {
        items: [
          {
            id: pkg.id,
            title: `Vocaid - ${pkg.name} Package`,
            description: `${pkg.description} - ${pkg.credits} interview credits`,
            quantity: 1,
            unit_price: pkg.priceBRL,  // Use BRL price for MercadoPago
            currency_id: 'BRL'
          }
        ],
        payer: {
          email: userEmail
        },
        external_reference: JSON.stringify({
          userId: userId,
          packageId: packageId,
          credits: pkg.credits
        }),
        statement_descriptor: 'Vocaid',
        metadata: {
          user_id: userId,
          package_id: packageId,
          credits: pkg.credits
        }
      };

      // Only add back_urls and auto_return if NOT localhost
      // MercadoPago requires publicly accessible URLs for redirects
      if (!isLocalhost) {
        preferenceData.back_urls = {
          success: `${frontendUrl}/payment/success`,
          failure: `${frontendUrl}/payment/failure`,
          pending: `${frontendUrl}/payment/pending`
        };
        // Use 'all' to redirect for all payment statuses (approved, pending, rejected)
        preferenceData.auto_return = 'all';
      } else {
        paymentLogger.warn('Localhost detected - skipping back_urls (MercadoPago requires public URLs)');
      }

      // Only add notification_url if webhook URL is configured and not localhost
      if (webhookUrl && !webhookUrl.includes('localhost') && !webhookUrl.includes('127.0.0.1')) {
        preferenceData.notification_url = `${webhookUrl}/webhook/mercadopago`;
      }

      const response = await this.preference.create({ body: preferenceData });

      paymentLogger.info('Preference created successfully', { 
        preferenceId: response.id,
        initPoint: response.init_point 
      });

      // Store payment record in database
      try {
        const paymentDb = await getPaymentDbService();
        await paymentDb.createPayment({
          userId,
          packageId,
          packageName: pkg.name,
          creditsAmount: pkg.credits,
          amountUSD: pkg.priceUSD,
          amountBRL: pkg.priceBRL,
          preferenceId: response.id || undefined
        });
        paymentLogger.info('Payment record created in database', { preferenceId: response.id });
      } catch (dbError: any) {
        // Don't fail if DB write fails - payment can still proceed
        paymentLogger.warn('Failed to create payment record in database', { 
          error: dbError.message,
          preferenceId: response.id 
        });
      }

      return {
        preferenceId: response.id,
        initPoint: response.init_point,
        sandboxInitPoint: response.sandbox_init_point
      };
    } catch (error: any) {
      paymentLogger.error('Error creating preference', { error: error.message });
      throw new Error(`Failed to create preference: ${error.message}`);
    }
  }

  /**
   * Verify payment status
   */
  async verifyPayment(paymentId: string) {
    try {
      const payment = await this.payment.get({ id: paymentId });
      
      return {
        id: payment.id,
        status: payment.status,
        status_detail: payment.status_detail,
        external_reference: payment.external_reference,
        metadata: payment.metadata
      };
    } catch (error: any) {
      paymentLogger.error('Error verifying payment', { paymentId, error: error.message });
      throw new Error(`Failed to verify payment: ${error.message}`);
    }
  }

  /**
   * Get recent payments (for debugging)
   */
  async getRecentPayments() {
    try {
      const result = await this.payment.search({
        options: {
          criteria: 'desc',
          sort: 'date_created',
          limit: 20
        }
      });
      
      return result.results || [];
    } catch (error: any) {
      paymentLogger.error('Error getting recent payments', { error: error.message });
      return [];
    }
  }

  /**
   * Process webhook notification
   */
  async processWebhook(notification: any) {
    try {
      paymentLogger.info('Processing webhook notification', { 
        type: notification.type, 
        dataId: notification.data?.id 
      });

      // Mercado Pago sends type and data.id
      if (notification.type === 'payment') {
        const paymentId = notification.data.id;
        const paymentInfo = await this.verifyPayment(paymentId);

        paymentLogger.info('Payment verification result', { 
          paymentId, 
          status: paymentInfo.status,
          external_reference: paymentInfo.external_reference
        });

        // Only process approved payments
        if (paymentInfo.status === 'approved') {
          // Extract metadata
          const externalReference = JSON.parse(paymentInfo.external_reference || '{}');
          const userId = externalReference.userId;
          const credits = externalReference.credits;
          const packageId = externalReference.packageId;

          if (userId && credits) {
            // Try to update payment in database (non-blocking)
            // First try to update by mercadoPagoId (processSuccessfulPayment)
            let paymentLinked = false;
            try {
              const paymentDb = await getPaymentDbService();
              try {
                await paymentDb.processSuccessfulPayment(String(paymentId), paymentInfo.status_detail);
                paymentLogger.info('Payment updated by mercadoPagoId', { paymentId });
                paymentLinked = true;
              } catch (err) {
                paymentLogger.warn('Could not update payment by mercadoPagoId, falling back to link by user/package', { paymentId, userId, packageId });
                // Fallback: link by user/package if not found by mercadoPagoId
                await paymentDb.linkMercadoPagoPayment(
                  userId,
                  packageId,
                  String(paymentId),
                  paymentInfo.status_detail
                );
                paymentLogger.info('Payment linked in database (fallback)', { paymentId, userId, packageId });
                paymentLinked = true;
              }
            } catch (dbError: any) {
              // This is non-critical - credits will still be added
              paymentLogger.warn('Could not link payment in database (non-critical)', { 
                error: dbError.message,
                paymentId,
                userId
              });
            }

            // Add credits to user - this is the critical operation
            const newBalance = await this.addCreditsToUser(userId, credits, String(paymentId));

            // ========================================
            // SEND PURCHASE RECEIPT EMAIL (non-blocking, idempotent)
            // ========================================
            try {
              // Get user info for email
              const dbUser = await getUserFromDatabase(userId);
              
              if (dbUser && dbUser.email) {
                // Get package info
                const pkg = CREDIT_PACKAGES[packageId];
                
                const purchaseData: PurchaseEmailData = {
                  user: {
                    id: dbUser.id,
                    clerkId: dbUser.clerkId,
                    email: dbUser.email,
                    firstName: dbUser.firstName,
                    lastName: dbUser.lastName,
                    preferredLanguage: dbUser.preferredLanguage
                  },
                  paymentId: String(paymentId),
                  provider: 'mercadopago',
                  packageName: pkg?.name || packageId,
                  creditsAmount: credits,
                  amountPaid: pkg?.priceBRL || 0,
                  currency: 'BRL',
                  newBalance: newBalance,
                  paidAt: new Date()
                };
                
                // Fire and forget
                sendPurchaseReceiptEmail(purchaseData)
                  .then(result => {
                    if (result.success && !result.skipped) {
                      paymentLogger.info('Purchase receipt email sent', { 
                        userId, 
                        paymentId, 
                        messageId: result.messageId 
                      });
                    } else if (result.skipped) {
                      paymentLogger.info('Purchase receipt already sent (idempotent)', { 
                        userId, 
                        paymentId 
                      });
                    } else {
                      paymentLogger.warn('Purchase receipt email failed (non-blocking)', { 
                        userId, 
                        paymentId, 
                        error: result.error 
                      });
                    }
                  })
                  .catch(err => {
                    paymentLogger.error('Purchase receipt email error (non-blocking)', { 
                      userId, 
                      paymentId, 
                      error: err.message 
                    });
                  });
              }
            } catch (emailError: any) {
              // Non-blocking - credits already added
              paymentLogger.warn('Could not prepare receipt email (non-blocking)', { 
                error: emailError.message,
                userId,
                paymentId
              });
            }

            return {
              success: true,
              message: 'Credits added successfully',
              userId,
              credits
            };
          }
        } else if (paymentInfo.status === 'rejected' || paymentInfo.status === 'cancelled') {
          // Extract metadata to find payment
          const externalReference = JSON.parse(paymentInfo.external_reference || '{}');
          const userId = externalReference.userId;
          const packageId = externalReference.packageId;
          
          // Update payment status in database (non-blocking)
          try {
            const paymentDb = await getPaymentDbService();
            await paymentDb.markPaymentFailed(
              userId,
              packageId,
              paymentInfo.status === 'rejected' ? 'REJECTED' : 'CANCELLED',
              paymentInfo.status_detail
            );
          } catch (dbError: any) {
            paymentLogger.warn('Failed to update failed payment in database', { 
              error: dbError.message 
            });
          }
        }
      }

      return {
        success: false,
        message: 'Payment not approved or missing data'
      };
    } catch (error: any) {
      paymentLogger.error('Error processing webhook', { error: error.message });
      throw new Error(`Failed to process webhook: ${error.message}`);
    }
  }

  /**
   * Add credits to user via PostgreSQL database
   * Uses clerkService which updates both PostgreSQL (source of truth) and Clerk metadata
   * Also records the transaction in the credits wallet ledger for audit
   */
  private async addCreditsToUser(userId: string, creditsToAdd: number, paymentId?: string) {
    try {
      console.log(`Adding ${creditsToAdd} credits to user ${userId}`);

      // Use updateUserCredits to update credits in PostgreSQL (source of truth)
      const updatedUser = await updateUserCredits(userId, creditsToAdd, 'add');

      // Also record in the wallet ledger for complete audit trail
      try {
        await addPurchasedCredits(
          userId,
          creditsToAdd,
          paymentId || 'unknown',
          `MercadoPago payment`
        );
        paymentLogger.info('Credits recorded in wallet ledger', { userId, credits: creditsToAdd, paymentId });
      } catch (walletError: any) {
        // Non-blocking - main credits update already succeeded
        paymentLogger.warn('Failed to record in wallet ledger (non-critical)', { 
          error: walletError.message,
          userId,
          credits: creditsToAdd
        });
      }

      console.log(`Credits updated for user ${userId}: new balance = ${updatedUser.credits}`);

      return updatedUser.credits;
    } catch (error: any) {
      console.error('Error adding credits to user:', error);
      throw new Error(`Failed to add credits: ${error.message}`);
    }
  }

  /**
   * Search for payments by preference ID
   * This is used for polling payment status when redirect doesn't work
   */
  async getPaymentByPreferenceId(preferenceId: string): Promise<{
    found: boolean;
    status?: string;
    paymentId?: string;
    userId?: string;
    credits?: number;
  }> {
    try {
      console.log(`Searching for payments with preference ID: ${preferenceId}`);

      // MercadoPago search API - look for payments
      // We need to search by preference_id in a different way
      // Let's get the preference first and check its status
      const preference = await this.preference.get({ preferenceId });
      
      if (!preference) {
        return { found: false };
      }

      // Now search payments with the external_reference we set
      const externalRef = preference.external_reference;
      
      if (externalRef) {
        try {
          const parsed = JSON.parse(externalRef);
          // Check if we can find a completed payment for this user
          const payments = await this.payment.search({
            options: {
              criteria: 'desc',
              sort: 'date_created'
            }
          });

          // Look through recent payments for one matching this preference
          if (payments.results && payments.results.length > 0) {
            for (const payment of payments.results) {
              if (payment.external_reference === externalRef && payment.status === 'approved') {
                return {
                  found: true,
                  status: payment.status,
                  paymentId: String(payment.id),
                  userId: parsed.userId,
                  credits: parsed.credits
                };
              }
            }
          }
        } catch (e) {
          console.error('Error parsing external reference:', e);
        }
      }

      return { found: false };
    } catch (error: any) {
      console.error('Error searching for payment:', error);
      return { found: false };
    }
  }
}
