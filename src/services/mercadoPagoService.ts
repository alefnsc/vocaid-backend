import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';
import { clerkClient } from '@clerk/clerk-sdk-node';

/**
 * Mercado Pago Service for payment processing
 * Documentation: https://www.mercadopago.com.br/developers/pt/docs
 */

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

      console.log('Creating payment preference for:', { 
        packageId, 
        userId, 
        userEmail,
        priceUSD: `$${pkg.priceUSD}`,
        priceBRL: `R$ ${pkg.priceBRL}`
      });

      const frontendUrl = process.env.FRONTEND_URL;
      const webhookUrl = process.env.WEBHOOK_BASE_URL;
      
      console.log('Payment URLs:', { frontendUrl, webhookUrl });

      // Validate frontend URL is set - required for MercadoPago redirects
      if (!frontendUrl) {
        console.error('FRONTEND_URL environment variable is not set!');
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
            title: `Voxly - ${pkg.name} Package`,
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
        statement_descriptor: 'Voxly',
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
        console.log('⚠️ Localhost detected - skipping back_urls and auto_return (MercadoPago requires public URLs)');
      }

      // Only add notification_url if webhook URL is configured and not localhost
      if (webhookUrl && !webhookUrl.includes('localhost') && !webhookUrl.includes('127.0.0.1')) {
        preferenceData.notification_url = `${webhookUrl}/webhook/mercadopago`;
      }

      console.log('Creating preference with back_urls:', preferenceData.back_urls || 'SKIPPED (localhost)');
      console.log('Auto return:', preferenceData.auto_return || 'SKIPPED (localhost)');
      console.log('Notification URL:', preferenceData.notification_url || 'SKIPPED');

      const response = await this.preference.create({ body: preferenceData });

      console.log('Preference created successfully:', response.id);
      console.log('Init point:', response.init_point);
      console.log('Sandbox init point:', response.sandbox_init_point);

      return {
        preferenceId: response.id,
        initPoint: response.init_point,
        sandboxInitPoint: response.sandbox_init_point
      };
    } catch (error: any) {
      console.error('Error creating preference:', error);
      console.error('Error details:', error.cause || error.response?.data || error.message);
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
      console.error('Error verifying payment:', error);
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
      console.error('Error getting recent payments:', error);
      return [];
    }
  }

  /**
   * Process webhook notification
   */
  async processWebhook(notification: any) {
    try {
      console.log('Processing webhook notification:', notification);

      // Mercado Pago sends type and data.id
      if (notification.type === 'payment') {
        const paymentId = notification.data.id;
        const paymentInfo = await this.verifyPayment(paymentId);

        console.log('Payment info:', paymentInfo);

        // Only process approved payments
        if (paymentInfo.status === 'approved') {
          // Extract metadata
          const externalReference = JSON.parse(paymentInfo.external_reference || '{}');
          const userId = externalReference.userId;
          const credits = externalReference.credits;

          if (userId && credits) {
            // Add credits to user via Clerk
            await this.addCreditsToUser(userId, credits);

            return {
              success: true,
              message: 'Credits added successfully',
              userId,
              credits
            };
          }
        }
      }

      return {
        success: false,
        message: 'Payment not approved or missing data'
      };
    } catch (error: any) {
      console.error('Error processing webhook:', error);
      throw new Error(`Failed to process webhook: ${error.message}`);
    }
  }

  /**
   * Add credits to user via Clerk metadata
   */
  private async addCreditsToUser(userId: string, creditsToAdd: number) {
    try {
      console.log(`Adding ${creditsToAdd} credits to user ${userId}`);

      // Get current user
      const user = await clerkClient.users.getUser(userId);
      const currentCredits = (user.publicMetadata.credits as number) || 0;
      const newCredits = currentCredits + creditsToAdd;

      // Update user metadata
      await clerkClient.users.updateUser(userId, {
        publicMetadata: {
          ...user.publicMetadata,
          credits: newCredits
        }
      });

      console.log(`Credits updated: ${currentCredits} -> ${newCredits}`);

      return newCredits;
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
