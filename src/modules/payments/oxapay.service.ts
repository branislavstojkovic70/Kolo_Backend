import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';

const OXAPAY_BASE = 'https://api.oxapay.com/v1';

export interface CreateInvoiceParams {
  orderId: string;
  amountUsd: string;
  description: string;
}

export interface InvoiceResult {
  track_id: string;
  payment_url: string;
  expired_at?: number;
}

export interface CreatePayoutParams {
  withdrawalId: string;
  address: string;
  amountUsd: string;
  currency: string;
  network: string;
}

export interface PayoutResult {
  track_id: string;
  status: string;
}

/** Every OxaPay HTTP call lives in this file. API changes are a one-file fix. */
@Injectable()
export class OxapayService {
  private readonly logger = new Logger(OxapayService.name);

  constructor(private readonly config: ConfigService) {}

  private get mockAll(): boolean {
    return process.env.OXAPAY_MOCK === 'true';
  }

  /** No merchant key configured, or OXAPAY_MOCK=true → fake the invoice. */
  private get isMock(): boolean {
    return !this.config.get<string>('oxapay.merchantApiKey') || this.mockAll;
  }

  /** No payout key configured, or OXAPAY_MOCK=true → fake the payout. */
  private get isPayoutMock(): boolean {
    return !this.config.get<string>('oxapay.payoutApiKey') || this.mockAll;
  }

  async createInvoice(params: CreateInvoiceParams): Promise<InvoiceResult> {
    const publicApiUrl =
      this.config.get<string>('publicApiUrl') || 'http://localhost:3000';
    const frontendUrl = this.config.get<string>('frontendUrl');

    const body = {
      amount: Number(params.amountUsd),
      currency: 'USD',
      lifetime: 60,
      fee_paid_by_payer: 1,
      order_id: params.orderId,
      description: params.description,
      callback_url: `${publicApiUrl}/api/webhooks/oxapay/payment`,
      return_url: `${frontendUrl}/orders/${params.orderId}`,
      sandbox: this.config.get<boolean>('oxapay.sandbox') ?? false,
    };

    if (this.isMock) {
      const mock: InvoiceResult = {
        track_id: `mock_${randomUUID()}`,
        payment_url: `${publicApiUrl}/api/dev/mock-pay/${params.orderId}`,
      };
      this.logger.warn(
        `*** OXAPAY MOCK *** no live invoice created for order ${params.orderId}. ` +
          `Request would have been: ${JSON.stringify(body)} — returning ${JSON.stringify(mock)}`,
      );
      return mock;
    }

    return this.post<InvoiceResult>('/payment/invoice', body, {
      merchant_api_key: this.config.get<string>(
        'oxapay.merchantApiKey',
      ) as string,
    });
  }

  async createPayout(params: CreatePayoutParams): Promise<PayoutResult> {
    const publicApiUrl =
      this.config.get<string>('publicApiUrl') || 'http://localhost:3000';

    const body = {
      address: params.address,
      currency: params.currency,
      amount: Number(params.amountUsd),
      network: params.network,
      callback_url: `${publicApiUrl}/api/webhooks/oxapay/payout`,
      description: `withdrawal ${params.withdrawalId}`,
    };

    if (this.isPayoutMock) {
      const mock: PayoutResult = {
        track_id: `mockpayout_${randomUUID()}`,
        status: 'confirming',
      };
      this.logger.warn(
        `*** OXAPAY MOCK *** no live payout sent for withdrawal ${params.withdrawalId}. ` +
          `Request would have been: ${JSON.stringify(body)} — returning ${JSON.stringify(mock)}`,
      );
      return mock;
    }

    return this.post<PayoutResult>('/payout', body, {
      payout_api_key: this.config.get<string>('oxapay.payoutApiKey') as string,
    });
  }

  private async post<T>(
    path: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<T> {
    const url = `${OXAPAY_BASE}${path}`;
    this.logger.log(`POST ${url} → ${JSON.stringify(body)}`);

    let res: Response;
    let text: string;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
      text = await res.text();
    } catch (e) {
      this.logger.error(`POST ${url} failed to connect: ${e?.message}`);
      throw new Error(`OxaPay request failed: ${e?.message}`);
    }

    this.logger.log(`POST ${url} ← ${res.status} ${text}`);

    if (!res.ok) {
      throw new Error(`OxaPay ${path} returned ${res.status}: ${text}`);
    }

    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`OxaPay ${path} returned non-JSON: ${text}`);
    }

    const data = parsed?.data ?? parsed;
    if (!data?.track_id) {
      throw new Error(`OxaPay ${path} returned no track_id: ${text}`);
    }

    return data as T;
  }
}
