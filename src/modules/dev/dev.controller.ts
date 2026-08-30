import {
  Body,
  Controller,
  Get,
  Header,
  Logger,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { createHmac } from 'crypto';
import { IsIn, IsString } from 'class-validator';
import { Public } from '../../common/decorators/public.decorator';
import { PrismaService } from '../../prisma/prisma.service';

class SimulateDto {
  @IsString()
  @IsIn(['paid', 'expired'])
  status: 'paid' | 'expired';
}

class SimulatePayoutDto {
  @IsString()
  @IsIn(['completed', 'failed'])
  status: 'completed' | 'failed';
}

/**
 * DEV ONLY. Stands in for OxaPay's hosted checkout: it builds a realistic callback,
 * signs it with the merchant key, and POSTs it to the real webhook over HTTP so the
 * signature check and idempotency guard are genuinely exercised.
 */
@ApiExcludeController()
@Controller('dev')
export class DevController {
  private readonly logger = new Logger(DevController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private assertDev() {
    if (process.env.NODE_ENV === 'production') throw new NotFoundException();
  }

  @Public()
  @Get('mock-pay/:orderId')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async page(@Param('orderId') orderId: string): Promise<string> {
    this.assertDev();

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, titleSnapshot: true, amountUsd: true, status: true },
    });
    if (!order) throw new NotFoundException('Order not found');

    const esc = (s: string) =>
      s.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);

    return `<!doctype html>
<html><head><meta charset="utf-8"><title>Mock OxaPay checkout</title>
<style>
 body{font-family:system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#111}
 .card{border:1px solid #ddd;border-radius:10px;padding:1.25rem}
 .amt{font-size:2rem;font-weight:700;margin:.25rem 0}
 .muted{color:#666;font-size:.9rem}
 button{font-size:1rem;padding:.7rem 1.1rem;border-radius:8px;border:0;cursor:pointer;margin-right:.5rem}
 .pay{background:#0a7d32;color:#fff}.exp{background:#eee;color:#333}
 pre{background:#f6f6f6;padding:.75rem;border-radius:8px;white-space:pre-wrap;word-break:break-all}
</style></head><body>
<p class="muted">⚠️ MOCK CHECKOUT — no real crypto is moved.</p>
<div class="card">
  <div class="muted">${esc(order.titleSnapshot)}</div>
  <div class="amt">$${order.amountUsd.toFixed(2)}</div>
  <div class="muted">Order ${esc(order.id)} — currently <b>${order.status}</b></div>
  <p>
    <button class="pay" onclick="go('paid')">Simulate payment</button>
    <button class="exp" onclick="go('expired')">Simulate expiry</button>
  </p>
  <pre id="out">Ready.</pre>
</div>
<script>
async function go(status){
  const out=document.getElementById('out');
  out.textContent='Sending signed '+status+' callback…';
  const r=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status})});
  out.textContent=JSON.stringify(await r.json(),null,2);
}
</script>
</body></html>`;
  }

  @Public()
  @Post('mock-pay/:orderId')
  async simulate(@Param('orderId') orderId: string, @Body() dto: SimulateDto) {
    this.assertDev();

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });
    if (!order) throw new NotFoundException('Order not found');

    const amount = Number(order.amountUsd);
    const payload = {
      type: 'payment',
      track_id: order.oxapayTrackId ?? `mock_${order.id}`,
      order_id: order.id,
      status: dto.status,
      amount,
      currency: 'USD',
      pay_amount: amount,
      pay_currency: 'USDT',
      network: 'TRC20',
      fee_paid_by_payer: 1,
      tx_hash: `mocktx_${order.id}`,
      date: Math.floor(Date.now() / 1000),
    };

    const raw = JSON.stringify(payload);
    const key = this.config.get<string>('oxapay.merchantApiKey') ?? '';
    const hmac = createHmac('sha512', key).update(raw).digest('hex');

    const port = this.config.get<number>('port') ?? 3000;
    const url = `http://127.0.0.1:${port}/api/webhooks/oxapay/payment`;

    this.logger.warn(
      `*** SIMULATING OXAPAY CALLBACK *** ${dto.status} → ${url} ${raw}`,
    );

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', HMAC: hmac },
      body: raw,
    });
    const text = await res.text();

    return { sent: payload, webhookStatus: res.status, webhookBody: text };
  }

  @Public()
  @Post('mock-payout/:withdrawalId')
  async simulatePayout(
    @Param('withdrawalId') withdrawalId: string,
    @Body() dto: SimulatePayoutDto,
  ) {
    this.assertDev();

    const withdrawal = await this.prisma.withdrawal.findUnique({
      where: { id: withdrawalId },
    });
    if (!withdrawal) throw new NotFoundException('Withdrawal not found');

    const payload = {
      type: 'payout',
      track_id: withdrawal.oxapayTrackId ?? `mockpayout_${withdrawal.id}`,
      status: dto.status,
      amount: Number(withdrawal.amountUsd),
      currency: withdrawal.currency,
      network: withdrawal.network,
      address: withdrawal.address,
      description: `withdrawal ${withdrawal.id}`,
      tx_hash: `mocktx_${withdrawal.id}`,
      date: Math.floor(Date.now() / 1000),
    };

    const raw = JSON.stringify(payload);
    // Payout callbacks are signed with the PAYOUT key.
    const key = this.config.get<string>('oxapay.payoutApiKey') ?? '';
    const hmac = createHmac('sha512', key).update(raw).digest('hex');

    const port = this.config.get<number>('port') ?? 3000;
    const url = `http://127.0.0.1:${port}/api/webhooks/oxapay/payout`;

    this.logger.warn(
      `*** SIMULATING OXAPAY PAYOUT CALLBACK *** ${dto.status} → ${url} ${raw}`,
    );

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', HMAC: hmac },
      body: raw,
    });
    const text = await res.text();

    return { sent: payload, webhookStatus: res.status, webhookBody: text };
  }
}
