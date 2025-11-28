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
  price: number;
  description: string;
}

export const CREDIT_PACKAGES: Record<string, CreditPackage> = {
  starter: {
    id: 'starter',
    name: 'Starter',
    credits: 5,
    price: 15.00,
    description: 'Perfect to get started'
  },
  intermediate: {
    id: 'intermediate',
    name: 'Intermediate',
    credits: 10,
    price: 28.00,
    description: 'Great for focused preparation'
  },
  professional: {
    id: 'professional',
    name: 'Professional',
    credits: 15,
    price: 40.00,
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

      console.log('Creating payment preference for:', { packageId, userId, userEmail });

      const frontendUrl = process.env.FRONTEND_URL;
      const webhookUrl = process.env.WEBHOOK_BASE_URL;
      
      console.log('Payment URLs:', { frontendUrl, webhookUrl });

      // Build preference data - only include optional fields if URLs are configured
      const preferenceData: any = {
        items: [
          {
            id: pkg.id,
            title: `Voxly - ${pkg.name} Package`,
            description: `${pkg.description} - ${pkg.credits} interview credits`,
            quantity: 1,
            unit_price: pkg.price,
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
        statement_descriptor: 'VOXLY AI',
        metadata: {
          user_id: userId,
          package_id: packageId,
          credits: pkg.credits
        }
      };

      // Only add back_urls if frontend URL is properly configured
      if (frontendUrl && frontendUrl !== 'http://localhost:3000') {
        preferenceData.back_urls = {
          success: `${frontendUrl}/payment/success`,
          failure: `${frontendUrl}/payment/failure`,
          pending: `${frontendUrl}/payment/pending`
        };
        preferenceData.auto_return = 'approved';
      }

      // Only add notification_url if webhook URL is configured
      if (webhookUrl) {
        preferenceData.notification_url = `${webhookUrl}/webhook/mercadopago`;
      }

      const response = await this.preference.create({ body: preferenceData });

      console.log('Preference created successfully:', response.id);

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
}
