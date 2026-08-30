import {
  Controller,
  HttpCode,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { WebhooksService } from './webhooks.service';

@ApiTags('webhooks')
@Controller('webhooks/oxapay')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    private readonly webhooks: WebhooksService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Post('payment')
  @HttpCode(200)
  @ApiOperation({
    summary: 'OxaPay payment callback (public, called by OxaPay only)',
    description:
      'Raw body + `HMAC` header signed with the **merchant** key. Cannot be called from this ' +
      'page — it is documented so the FE team can see what actually flips an order to `PAID`. ' +
      'On `status: "paid"` the order gets `paidAt = now` and `vestedAt = paidAt + VESTING_DAYS`; ' +
      'on `expired`/`failed` it becomes `EXPIRED`. Duplicate callbacks are ignored via the ' +
      '`WebhookEvent` unique index, and the response is always `200 OK` once the signature is ' +
      'valid — anything else makes OxaPay retry forever.',
  })
  @ApiOkResponse({
    description: 'Always the literal string OK',
    schema: { example: 'OK' },
  })
  async payment(@Req() req: RawBodyRequest<Request>): Promise<string> {
    const raw = req.rawBody ?? Buffer.alloc(0);
    // Logged before verification — during a demo this is the only debugging we get.
    this.logger.log(`Payment webhook received: ${raw.toString('utf8')}`);

    const ok = this.webhooks.verifySignature(
      raw,
      req.headers['hmac'] as string | undefined,
      this.config.get<string>('oxapay.merchantApiKey'),
    );

    if (!ok) {
      this.logger.error(
        `REJECTED payment webhook — bad HMAC. header=${req.headers['hmac']} body=${raw.toString('utf8')}`,
      );
      throw new UnauthorizedException('Invalid signature');
    }

    let body: any;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      this.logger.error(
        `Payment webhook body was not JSON: ${raw.toString('utf8')}`,
      );
      return 'OK';
    }

    const trackId = body?.track_id
      ? String(body.track_id)
      : String(body?.order_id ?? 'unknown');
    const status = String(body?.status ?? 'unknown').toLowerCase();

    // Idempotency before any order mutation.
    const fresh = await this.webhooks.recordEvent(
      'payment',
      trackId,
      status,
      body,
    );
    if (!fresh) return 'OK';

    try {
      await this.webhooks.handlePayment(body);
    } catch (e) {
      // Never 500 to OxaPay — it would retry forever.
      this.logger.error(
        `Payment webhook processing failed: ${e?.message}`,
        e?.stack,
      );
    }

    return 'OK';
  }

  @Public()
  @Post('payout')
  @HttpCode(200)
  @ApiOperation({
    summary: 'OxaPay payout callback (public, called by OxaPay only)',
    description:
      'Raw body + `HMAC` header signed with the **payout** key. `complete`/`completed` flips ' +
      'the withdrawal to `COMPLETED`; `failed`/`rejected` marks it `FAILED` and unlinks its ' +
      'orders so the funds drop back into the `available` bucket.',
  })
  @ApiOkResponse({
    description: 'Always the literal string OK',
    schema: { example: 'OK' },
  })
  async payout(@Req() req: RawBodyRequest<Request>): Promise<string> {
    const raw = req.rawBody ?? Buffer.alloc(0);
    this.logger.log(`Payout webhook received: ${raw.toString('utf8')}`);

    // Payout callbacks are signed with the PAYOUT key, not the merchant key.
    const ok = this.webhooks.verifySignature(
      raw,
      req.headers['hmac'] as string | undefined,
      this.config.get<string>('oxapay.payoutApiKey'),
    );

    if (!ok) {
      this.logger.error(
        `REJECTED payout webhook — bad HMAC. header=${req.headers['hmac']} body=${raw.toString('utf8')}`,
      );
      throw new UnauthorizedException('Invalid signature');
    }

    let body: any;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      this.logger.error(
        `Payout webhook body was not JSON: ${raw.toString('utf8')}`,
      );
      return 'OK';
    }

    const trackId = String(body?.track_id ?? 'unknown');
    const status = String(body?.status ?? 'unknown').toLowerCase();

    const fresh = await this.webhooks.recordEvent(
      'payout',
      trackId,
      status,
      body,
    );
    if (!fresh) return 'OK';

    try {
      await this.webhooks.handlePayout(body);
    } catch (e) {
      this.logger.error(
        `Payout webhook processing failed: ${e?.message}`,
        e?.stack,
      );
    }

    return 'OK';
  }
}
