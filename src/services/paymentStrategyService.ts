/**
 * Payment Strategy Service
 * 
 * Implements the Strategy Pattern for payment providers.
 * Allows seamless switching between PayPal and MercadoPago based on user region.
 * 
 * Design Principles:
 * - Single Responsibility: Each provider class handles only its provider logic
 * - Open/Closed: New providers can be added without modifying existing code
 * - Dependency Inversion: High-level modules depend on abstractions (IPaymentProvider)
 * 
 * @module services/paymentStrategyService
 */

import { paymentLogger } from '../utils/logger';
import {
  PaymentProviderType,
  IPaymentProvider,
  CreatePaymentParams,
  PaymentPreferenceResponse,
  WebhookResult,
  PaymentStatusResult,
  RegionCode,
  SupportedLanguageCode,
  getPaymentProviderForRegion,
} from '../types/multilingual';
import { getPreferredPaymentProvider } from './userPreferencesService';

// ========================================
// CREDIT PACKAGES (Multi-currency)
// ========================================

export interface CreditPackage {
  id: string;
  name: string;
  credits: number;
  prices: {
    USD: number;
    BRL: number;
    EUR: number;
    MXN: number;
    ARS: number;
    GBP: number;
  };
  description: Record<SupportedLanguageCode, string>;
}

export const CREDIT_PACKAGES: Record<string, CreditPackage> = {
  starter: {
    id: 'starter',
    name: 'Starter',
    credits: 5,
    prices: {
      USD: 3.99,
      BRL: 23.94,
      EUR: 3.69,
      MXN: 69.99,
      ARS: 3999,
      GBP: 3.19,
    },
    description: {
      'en-US': 'Perfect to get started',
      'en-GB': 'Perfect to get started',
      'pt-BR': 'Perfeito para começar',
      'es-ES': 'Perfecto para empezar',
      'es-MX': 'Perfecto para empezar',
      'es-AR': 'Perfecto para empezar',
      'fr-FR': 'Parfait pour commencer',
      'ru-RU': 'Идеально для начала',
      'zh-CN': '入门的完美选择',
      'hi-IN': 'शुरू करने के लिए बिल्कुल सही',
    },
  },
  intermediate: {
    id: 'intermediate',
    name: 'Intermediate',
    credits: 10,
    prices: {
      USD: 5.99,
      BRL: 35.94,
      EUR: 5.49,
      MXN: 109.99,
      ARS: 5999,
      GBP: 4.79,
    },
    description: {
      'en-US': 'Great for focused preparation',
      'en-GB': 'Great for focused preparation',
      'pt-BR': 'Ótimo para preparação focada',
      'es-ES': 'Excelente para preparación enfocada',
      'es-MX': 'Excelente para preparación enfocada',
      'es-AR': 'Excelente para preparación enfocada',
      'fr-FR': 'Idéal pour une préparation ciblée',
      'ru-RU': 'Отлично для целенаправленной подготовки',
      'zh-CN': '专注准备的最佳选择',
      'hi-IN': 'केंद्रित तैयारी के लिए बढ़िया',
    },
  },
  professional: {
    id: 'professional',
    name: 'Professional',
    credits: 15,
    prices: {
      USD: 7.99,
      BRL: 47.94,
      EUR: 7.29,
      MXN: 149.99,
      ARS: 7999,
      GBP: 6.39,
    },
    description: {
      'en-US': 'Ideal for regular practice',
      'en-GB': 'Ideal for regular practice',
      'pt-BR': 'Ideal para prática regular',
      'es-ES': 'Ideal para práctica regular',
      'es-MX': 'Ideal para práctica regular',
      'es-AR': 'Ideal para práctica regular',
      'fr-FR': 'Idéal pour une pratique régulière',
      'ru-RU': 'Идеально для регулярной практики',
      'zh-CN': '定期练习的理想选择',
      'hi-IN': 'नियमित अभ्यास के लिए आदर्श',
    },
  },
};

// ========================================
// MERCADO PAGO PROVIDER
// ========================================

import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';

class MercadoPagoProvider implements IPaymentProvider {
  readonly type: PaymentProviderType = 'mercadopago';
  readonly name = 'Mercado Pago';
  readonly supportedCurrencies = ['BRL', 'ARS', 'MXN', 'CLP', 'COP', 'PEN', 'UYU'];
  readonly supportedRegions: RegionCode[] = ['LATAM'];

  private client: MercadoPagoConfig | null = null;
  private preference: Preference | null = null;
  private payment: Payment | null = null;

  private getClient(): MercadoPagoConfig {
    if (!this.client) {
      const accessToken = this.getAccessToken();
      if (!accessToken) {
        throw new Error('MercadoPago access token not configured');
      }
      this.client = new MercadoPagoConfig({
        accessToken,
        options: { timeout: 5000 },
      });
      this.preference = new Preference(this.client);
      this.payment = new Payment(this.client);
    }
    return this.client;
  }

  private getAccessToken(): string | undefined {
    const isProduction = process.env.NODE_ENV === 'production';
    return isProduction
      ? process.env.MERCADOPAGO_ACCESS_TOKEN
      : process.env.MERCADOPAGO_TEST_ACCESS_TOKEN || process.env.MERCADOPAGO_ACCESS_TOKEN;
  }

  isAvailable(): boolean {
    return !!this.getAccessToken();
  }

  supportsRegion(region: RegionCode): boolean {
    return this.supportedRegions.includes(region);
  }

  async createPaymentPreference(params: CreatePaymentParams): Promise<PaymentPreferenceResponse> {
    this.getClient(); // Initialize if needed

    paymentLogger.info('Creating MercadoPago preference', {
      userId: params.userId,
      packageId: params.packageId,
      amount: params.amountLocal,
      currency: params.currency,
    });

    const isLocalhost = params.successUrl.includes('localhost');
    const isProduction = process.env.NODE_ENV === 'production';

    const preferenceData: any = {
      items: [
        {
          id: params.packageId,
          title: `Vocaid - ${params.packageName}`,
          description: `${params.credits} interview credits`,
          quantity: 1,
          unit_price: params.amountLocal,
          currency_id: params.currency,
        },
      ],
      payer: {
        email: params.userEmail,
      },
      external_reference: JSON.stringify({
        userId: params.userId,
        packageId: params.packageId,
        credits: params.credits,
        provider: 'mercadopago',
      }),
      statement_descriptor: 'Vocaid',
      metadata: {
        user_id: params.userId,
        package_id: params.packageId,
        credits: params.credits,
        language: params.language,
      },
    };

    // Only add back_urls for non-localhost
    if (!isLocalhost) {
      preferenceData.back_urls = {
        success: params.successUrl,
        failure: params.failureUrl,
        pending: params.pendingUrl || params.successUrl,
      };
      preferenceData.auto_return = 'all';
    }

    // Add webhook URL if configured
    if (params.webhookUrl && !params.webhookUrl.includes('localhost')) {
      preferenceData.notification_url = params.webhookUrl;
    }

    const response = await this.preference!.create({ body: preferenceData });

    paymentLogger.info('MercadoPago preference created', {
      preferenceId: response.id,
    });

    return {
      id: response.id!,
      initPoint: (isProduction ? response.init_point : response.sandbox_init_point) || response.init_point!,
      provider: 'mercadopago',
      sandboxMode: !isProduction,
    };
  }

  async handleWebhook(payload: any, headers: Record<string, string>): Promise<WebhookResult> {
    this.getClient();

    const paymentId = payload.data?.id || payload.id;
    
    if (!paymentId) {
      throw new Error('Payment ID not found in webhook payload');
    }

    const paymentData = await this.payment!.get({ id: paymentId });
    
    let externalRef: any = {};
    try {
      externalRef = JSON.parse(paymentData.external_reference || '{}');
    } catch (e) {
      paymentLogger.warn('Failed to parse external_reference', { paymentId });
    }

    const statusMap: Record<string, WebhookResult['status']> = {
      approved: 'approved',
      pending: 'pending',
      in_process: 'pending',
      rejected: 'rejected',
      cancelled: 'cancelled',
    };

    return {
      success: paymentData.status === 'approved',
      paymentId: paymentId.toString(),
      externalId: paymentId.toString(),
      status: statusMap[paymentData.status || ''] || 'pending',
      statusDetail: paymentData.status_detail,
      creditsToAdd: paymentData.status === 'approved' ? externalRef.credits : undefined,
      userId: externalRef.userId,
    };
  }

  async getPaymentStatus(paymentId: string): Promise<PaymentStatusResult> {
    this.getClient();

    const paymentData = await this.payment!.get({ id: paymentId });

    const statusMap: Record<string, PaymentStatusResult['status']> = {
      approved: 'approved',
      pending: 'pending',
      in_process: 'pending',
      rejected: 'rejected',
      cancelled: 'cancelled',
    };

    return {
      status: statusMap[paymentData.status || ''] || 'unknown',
      statusDetail: paymentData.status_detail,
      paidAt: paymentData.date_approved ? new Date(paymentData.date_approved) : undefined,
      amount: paymentData.transaction_amount,
      currency: paymentData.currency_id,
    };
  }
}

// ========================================
// PAYPAL PROVIDER
// ========================================

/**
 * PayPal Provider implementation
 * Uses PayPal REST API for global payments
 */
class PayPalProvider implements IPaymentProvider {
  readonly type: PaymentProviderType = 'paypal';
  readonly name = 'PayPal';
  readonly supportedCurrencies = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY'];
  readonly supportedRegions: RegionCode[] = ['NORTH_AMERICA', 'EUROPE', 'ASIA_PACIFIC', 'GLOBAL'];

  private accessToken: string | null = null;
  private tokenExpiry: number = 0;

  private getCredentials() {
    const isProduction = process.env.NODE_ENV === 'production';
    return {
      clientId: isProduction
        ? process.env.PAYPAL_CLIENT_ID
        : process.env.PAYPAL_SANDBOX_CLIENT_ID || process.env.PAYPAL_CLIENT_ID,
      clientSecret: isProduction
        ? process.env.PAYPAL_CLIENT_SECRET
        : process.env.PAYPAL_SANDBOX_CLIENT_SECRET || process.env.PAYPAL_CLIENT_SECRET,
      baseUrl: isProduction
        ? 'https://api-m.paypal.com'
        : 'https://api-m.sandbox.paypal.com',
    };
  }

  isAvailable(): boolean {
    const { clientId, clientSecret } = this.getCredentials();
    return !!(clientId && clientSecret);
  }

  supportsRegion(region: RegionCode): boolean {
    return this.supportedRegions.includes(region);
  }

  private async getAccessToken(): Promise<string> {
    // Return cached token if still valid
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    const { clientId, clientSecret, baseUrl } = this.getCredentials();

    if (!clientId || !clientSecret) {
      throw new Error('PayPal credentials not configured');
    }

    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const response = await fetch(`${baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    if (!response.ok) {
      throw new Error(`PayPal authentication failed: ${response.status}`);
    }

    const data = await response.json() as { access_token: string; expires_in: number };
    this.accessToken = data.access_token;
    this.tokenExpiry = Date.now() + (data.expires_in - 60) * 1000; // Refresh 1 min early

    return this.accessToken!;
  }

  async createPaymentPreference(params: CreatePaymentParams): Promise<PaymentPreferenceResponse> {
    const { baseUrl } = this.getCredentials();
    const token = await this.getAccessToken();
    const isProduction = process.env.NODE_ENV === 'production';

    paymentLogger.info('Creating PayPal order', {
      userId: params.userId,
      packageId: params.packageId,
      amount: params.amountUSD,
    });

    const orderPayload = {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: params.packageId,
          description: `Vocaid - ${params.packageName} (${params.credits} credits)`,
          custom_id: JSON.stringify({
            userId: params.userId,
            packageId: params.packageId,
            credits: params.credits,
            provider: 'paypal',
          }),
          amount: {
            currency_code: 'USD',
            value: params.amountUSD.toFixed(2),
          },
        },
      ],
      application_context: {
        brand_name: 'Vocaid',
        landing_page: 'LOGIN',
        user_action: 'PAY_NOW',
        return_url: params.successUrl,
        cancel_url: params.failureUrl,
        locale: this.mapLanguageToPayPalLocale(params.language),
      },
    };

    const response = await fetch(`${baseUrl}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(orderPayload),
    });

    if (!response.ok) {
      const error = await response.text();
      paymentLogger.error('PayPal order creation failed', { error });
      throw new Error(`PayPal order creation failed: ${response.status}`);
    }

    interface PayPalOrderResponse {
      id: string;
      links: Array<{ rel: string; href: string }>;
    }

    const order = await response.json() as PayPalOrderResponse;
    const approveLink = order.links.find((l) => l.rel === 'approve');

    paymentLogger.info('PayPal order created', {
      orderId: order.id,
    });

    return {
      id: order.id,
      initPoint: approveLink?.href || '',
      provider: 'paypal',
      sandboxMode: !isProduction,
    };
  }

  async handleWebhook(payload: any, headers: Record<string, string>): Promise<WebhookResult> {
    // Verify webhook signature (in production)
    const orderId = payload.resource?.id;
    const eventType = payload.event_type;

    if (!orderId) {
      throw new Error('Order ID not found in webhook payload');
    }

    let customData: any = {};
    try {
      const customId = payload.resource?.purchase_units?.[0]?.custom_id;
      customData = JSON.parse(customId || '{}');
    } catch (e) {
      paymentLogger.warn('Failed to parse custom_id', { orderId });
    }

    const statusMap: Record<string, WebhookResult['status']> = {
      'CHECKOUT.ORDER.APPROVED': 'approved',
      'PAYMENT.CAPTURE.COMPLETED': 'approved',
      'PAYMENT.CAPTURE.PENDING': 'pending',
      'PAYMENT.CAPTURE.DENIED': 'rejected',
      'CHECKOUT.ORDER.CANCELLED': 'cancelled',
    };

    return {
      success: eventType === 'PAYMENT.CAPTURE.COMPLETED',
      paymentId: orderId,
      externalId: orderId,
      status: statusMap[eventType] || 'pending',
      statusDetail: eventType,
      creditsToAdd: eventType === 'PAYMENT.CAPTURE.COMPLETED' ? customData.credits : undefined,
      userId: customData.userId,
    };
  }

  async getPaymentStatus(paymentId: string): Promise<PaymentStatusResult> {
    const { baseUrl } = this.getCredentials();
    const token = await this.getAccessToken();

    const response = await fetch(`${baseUrl}/v2/checkout/orders/${paymentId}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      return { status: 'unknown' };
    }

    interface PayPalOrderStatusResponse {
      status: string;
      update_time?: string;
      purchase_units?: Array<{
        amount?: { value?: string; currency_code?: string };
      }>;
    }

    const order = await response.json() as PayPalOrderStatusResponse;

    const statusMap: Record<string, PaymentStatusResult['status']> = {
      COMPLETED: 'approved',
      APPROVED: 'approved',
      CREATED: 'pending',
      SAVED: 'pending',
      VOIDED: 'cancelled',
    };

    return {
      status: statusMap[order.status] || 'unknown',
      statusDetail: order.status,
      paidAt: order.update_time ? new Date(order.update_time) : undefined,
      amount: parseFloat(order.purchase_units?.[0]?.amount?.value || '0'),
      currency: order.purchase_units?.[0]?.amount?.currency_code,
    };
  }

  private mapLanguageToPayPalLocale(language: SupportedLanguageCode): string {
    const localeMap: Record<SupportedLanguageCode, string> = {
      'en-US': 'en_US',
      'en-GB': 'en_GB',
      'pt-BR': 'pt_BR',
      'es-ES': 'es_ES',
      'es-MX': 'es_MX',
      'es-AR': 'es_AR',
      'fr-FR': 'fr_FR',
      'ru-RU': 'ru_RU',
      'zh-CN': 'zh_CN',
      'hi-IN': 'en_IN', // PayPal doesn't support Hindi, fallback to English India
    };
    return localeMap[language] || 'en_US';
  }
}

// ========================================
// PAYMENT GATEWAY (Strategy Context)
// ========================================

/**
 * Payment Gateway - Strategy Context
 * Selects and delegates to the appropriate payment provider
 */
export class PaymentGateway {
  private providers: Map<PaymentProviderType, IPaymentProvider> = new Map();

  constructor() {
    // Register available providers
    this.registerProvider(new MercadoPagoProvider());
    this.registerProvider(new PayPalProvider());
  }

  private registerProvider(provider: IPaymentProvider): void {
    this.providers.set(provider.type, provider);
  }

  /**
   * Get provider for a specific type
   */
  getProvider(type: PaymentProviderType): IPaymentProvider {
    const provider = this.providers.get(type);
    if (!provider) {
      throw new Error(`Payment provider not found: ${type}`);
    }
    return provider;
  }

  /**
   * Get the best provider for a user based on their region
   */
  async getProviderForUser(clerkId: string): Promise<IPaymentProvider> {
    const { provider: providerType, isFallback } = await getPreferredPaymentProvider(clerkId);
    
    const provider = this.getProvider(providerType);
    
    if (!provider.isAvailable()) {
      // Try fallback
      const fallbackType: PaymentProviderType = providerType === 'mercadopago' ? 'paypal' : 'mercadopago';
      const fallback = this.getProvider(fallbackType);
      
      if (!fallback.isAvailable()) {
        throw new Error('No payment provider available');
      }
      
      paymentLogger.warn('Using fallback payment provider', {
        primary: providerType,
        fallback: fallbackType,
      });
      
      return fallback;
    }
    
    return provider;
  }

  /**
   * Get provider for a specific region
   */
  getProviderForRegion(region: RegionCode): IPaymentProvider {
    const providerType = getPaymentProviderForRegion(region);
    return this.getProvider(providerType);
  }

  /**
   * Create payment with automatic provider selection
   */
  async createPayment(
    clerkId: string,
    params: Omit<CreatePaymentParams, 'userId'>
  ): Promise<PaymentPreferenceResponse & { selectedProvider: PaymentProviderType }> {
    const provider = await this.getProviderForUser(clerkId);
    
    const result = await provider.createPaymentPreference({
      ...params,
      userId: clerkId,
    });
    
    return {
      ...result,
      selectedProvider: provider.type,
    };
  }

  /**
   * Get all available providers
   */
  getAvailableProviders(): IPaymentProvider[] {
    return Array.from(this.providers.values()).filter(p => p.isAvailable());
  }

  /**
   * Check if any provider is available
   */
  hasAvailableProvider(): boolean {
    return this.getAvailableProviders().length > 0;
  }
}

// ========================================
// SINGLETON INSTANCE
// ========================================

let paymentGatewayInstance: PaymentGateway | null = null;

export function getPaymentGateway(): PaymentGateway {
  if (!paymentGatewayInstance) {
    paymentGatewayInstance = new PaymentGateway();
  }
  return paymentGatewayInstance;
}

// ========================================
// HELPER FUNCTIONS
// ========================================

/**
 * Get package price in the appropriate currency for a region
 */
export function getPackagePrice(
  packageId: string,
  currency: keyof CreditPackage['prices']
): number {
  const pkg = CREDIT_PACKAGES[packageId];
  if (!pkg) {
    throw new Error(`Package not found: ${packageId}`);
  }
  return pkg.prices[currency] || pkg.prices.USD;
}

/**
 * Get currency code for a region
 */
export function getCurrencyForRegion(region: RegionCode): keyof CreditPackage['prices'] {
  const currencyMap: Record<RegionCode, keyof CreditPackage['prices']> = {
    LATAM: 'BRL', // Default to BRL for LATAM
    NORTH_AMERICA: 'USD',
    EUROPE: 'EUR',
    ASIA_PACIFIC: 'USD',
    GLOBAL: 'USD',
  };
  return currencyMap[region];
}

export default PaymentGateway;
