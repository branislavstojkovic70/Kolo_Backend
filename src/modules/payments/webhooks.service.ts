import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ListingStatus,
  OrderStatus,
  Prisma,
  WithdrawalStatus,
} from '@prisma/client';
import { createHmac, timingSafeEqual } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { AutoBuyService } from '../buy-requests/auto-buy.service';

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(forwardRef(() => AutoBuyService))
    private readonly autoBuy: AutoBuyService,
  ) {}

  /** hmac_sha512(rawBody, key), constant-time compared. Never throws on length mismatch. */
  verifySignature(
    rawBody: Buffer,
    header: string | undefined,
    key: string | undefined,
  ): boolean {
    if (!header || !key) return false;

    const expected = createHmac('sha512', key).update(rawBody).digest('hex');
    const received = header.trim().toLowerCase();

    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(received, 'utf8');
    if (a.length !== b.length) return false; // timingSafeEqual throws on unequal lengths

    return timingSafeEqual(a, b);
  }

  /**
   * Idempotency guard. Returns false when this exact (type, trackId, status) was
   * already processed, so the caller can bail out before touching any order.
   */
  async recordEvent(
    type: string,
    trackId: string,
    status: string,
    payload: any,
  ): Promise<boolean> {
    try {
      await this.prisma.webhookEvent.create({
        data: { provider: 'oxapay', type, trackId, status, payload },
      });
      return true;
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        this.logger.warn(
          `Duplicate ${type} webhook ignored: trackId=${trackId} status=${status}`,
        );
        return false;
      }
      throw e;
    }
  }

  async handlePayment(body: any): Promise<void> {
    const trackId: string | undefined = body?.track_id
      ? String(body.track_id)
      : undefined;
    const orderId: string | undefined = body?.order_id
      ? String(body.order_id)
      : undefined;
    const status = String(body?.status ?? '').toLowerCase();

    const order = trackId
      ? ((await this.prisma.order.findUnique({
          where: { oxapayTrackId: trackId },
        })) ??
        (orderId
          ? await this.prisma.order.findUnique({ where: { id: orderId } })
          : null))
      : orderId
        ? await this.prisma.order.findUnique({ where: { id: orderId } })
        : null;

    if (!order) {
      this.logger.error(
        `!!! PAYMENT WEBHOOK FOR UNKNOWN ORDER !!! track_id=${trackId} order_id=${orderId} status=${status}`,
      );
      return;
    }

    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      this.logger.log(
        `Ignoring "${status}" for order ${order.id}: already ${order.status}, not PENDING_PAYMENT`,
      );
      return;
    }

    if (status === 'paid') {
      const paidAt = new Date();
      const vestingDays = this.config.get<number>('vestingDays') ?? 30;
      // VESTING_DAYS=0 → vestedAt === paidAt, i.e. withdrawable immediately. Never null.
      const vestedAt = new Date(
        paidAt.getTime() + vestingDays * 24 * 60 * 60 * 1000,
      );

      await this.prisma.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.PAID, paidAt, vestedAt },
      });

      this.logger.log(
        `Order ${order.id} PAID. paidAt=${paidAt.toISOString()} vestedAt=${vestedAt.toISOString()} (VESTING_DAYS=${vestingDays})`,
      );

      // Auto-buy hook: a paid order that fulfils a BuyRequest marks it FULFILLED
      // and the listing SOLD. Manual purchases fall straight through, and a
      // failure here must never break the webhook's 200.
      try {
        await this.autoBuy.onOrderPaid(order);
      } catch (e) {
        this.logger.error(
          `AutoBuy onOrderPaid failed for order ${order.id}: ${e?.message}`,
          e?.stack,
        );
      }
      return;
    }

    if (status === 'expired' || status === 'failed') {
      await this.prisma.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.EXPIRED },
      });
      // The unit this order claimed goes back on the shelf. Guarded by the
      // PENDING_PAYMENT check above, so one order can never release twice.
      await this.releaseListingUnit(order.listingId);
      this.logger.log(`Order ${order.id} EXPIRED (webhook status "${status}")`);
      return;
    }

    this.logger.log(
      `Ignoring payment webhook status "${status}" for order ${order.id}`,
    );
  }

  /**
   * Mirror of OrdersService.releaseUnit — an expired invoice frees the unit it
   * claimed and brings a sold-out listing back to the marketplace.
   */
  private async releaseListingUnit(listingId: string) {
    await this.prisma.listing.updateMany({
      where: { id: listingId, soldCount: { gt: 0 } },
      data: { soldCount: { decrement: 1 } },
    });
    await this.prisma.listing.updateMany({
      where: {
        id: listingId,
        status: ListingStatus.SOLD_OUT,
        soldCount: { lt: this.prisma.listing.fields.quantity },
      },
      data: { status: ListingStatus.ACTIVE },
    });
  }

  async handlePayout(body: any): Promise<void> {
    const trackId: string | undefined = body?.track_id
      ? String(body.track_id)
      : undefined;
    const status = String(body?.status ?? '').toLowerCase();

    const withdrawal = trackId
      ? await this.prisma.withdrawal.findUnique({
          where: { oxapayTrackId: trackId },
        })
      : null;

    if (!withdrawal) {
      this.logger.error(
        `!!! PAYOUT WEBHOOK FOR UNKNOWN WITHDRAWAL !!! track_id=${trackId} status=${status}`,
      );
      return;
    }

    const open: WithdrawalStatus[] = [
      WithdrawalStatus.PENDING,
      WithdrawalStatus.PROCESSING,
    ];
    if (!open.includes(withdrawal.status)) {
      this.logger.log(
        `Ignoring "${status}" for withdrawal ${withdrawal.id}: already ${withdrawal.status}`,
      );
      return;
    }

    if (status === 'complete' || status === 'completed') {
      await this.prisma.withdrawal.update({
        where: { id: withdrawal.id },
        data: { status: WithdrawalStatus.COMPLETED, completedAt: new Date() },
      });
      this.logger.log(`Withdrawal ${withdrawal.id} COMPLETED`);
      return;
    }

    if (status === 'failed' || status === 'rejected') {
      // Unlink so the orders drop back into the available bucket.
      await this.prisma.$transaction([
        this.prisma.order.updateMany({
          where: { withdrawalId: withdrawal.id },
          data: { withdrawalId: null },
        }),
        this.prisma.withdrawal.update({
          where: { id: withdrawal.id },
          data: {
            status: WithdrawalStatus.FAILED,
            error: `Payout ${status} by OxaPay`,
          },
        }),
      ]);
      this.logger.warn(
        `Withdrawal ${withdrawal.id} FAILED ("${status}") — orders unlinked`,
      );
      return;
    }

    this.logger.log(
      `Ignoring payout webhook status "${status}" for withdrawal ${withdrawal.id}`,
    );
  }
}
