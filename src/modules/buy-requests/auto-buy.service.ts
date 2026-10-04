import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  BuyRequestStatus,
  ListingStatus,
  OrderStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { OrdersService } from '../orders/orders.service';

/** Thrown inside the claim transaction when a concurrent claim got there first. */
class MatchRaceLost extends Error {}

const LISTING_FOR_ORDER = {
  id: true,
  sellerId: true,
  title: true,
  priceUsd: true,
  productId: true,
  status: true,
  product: { select: { retailPriceUsd: true } },
} satisfies Prisma.ListingSelect;

/**
 * Auto-buy: standing BuyRequests are matched against listings synchronously at
 * creation time (of either side). The cron below only cleans up expired
 * reservations/requests and acts as a safety net for anything the synchronous
 * path missed. Money-wise this is a plain order — the buyer pays the OxaPay
 * invoice themselves; there is no internal deposit balance.
 */
@Injectable()
export class AutoBuyService {
  private readonly logger = new Logger(AutoBuyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly orders: OrdersService,
  ) {}

  private get enabled(): boolean {
    return this.config.get<boolean>('autoBuy.enabled') ?? true;
  }

  private reservationDeadline(): Date {
    const minutes = this.config.get<number>('autoBuy.reservationMinutes') ?? 15;
    return new Date(Date.now() + minutes * 60_000);
  }

  /**
   * A listing just appeared (or came back) — give it to the oldest waiting
   * BuyRequest (FIFO: first to register wins). Returns true if a match claimed
   * the listing. Callers on the request path must wrap this in try/catch — a
   * matching failure must never fail the seller's POST /api/listings.
   *
   * `excludeRequestId`: on reservation expiry the non-paying request goes back
   * to ACTIVE but must not immediately re-claim the very listing it just sat
   * on — the next buyer in line gets it.
   */
  async tryMatchListing(
    listingId: string,
    excludeRequestId?: string,
  ): Promise<boolean> {
    if (!this.enabled) return false;

    const listing = await this.prisma.listing.findUnique({
      where: { id: listingId },
      select: { ...LISTING_FOR_ORDER, status: true },
    });
    if (!listing || listing.status !== ListingStatus.ACTIVE) return false;

    const candidates = await this.prisma.buyRequest.findMany({
      where: {
        productId: listing.productId,
        status: BuyRequestStatus.ACTIVE,
        buyerId: { not: listing.sellerId }, // never match the seller's own wish
        maxPriceUsd: { gte: listing.priceUsd },
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        ...(excludeRequestId ? { id: { not: excludeRequestId } } : {}),
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });

    // FIFO; if a claim races and loses, the next-in-line request gets its turn.
    for (const candidate of candidates) {
      if (await this.matchPair(candidate.id, listing.id)) return true;
    }
    return false;
  }

  /**
   * A wish was just registered — if a qualifying listing ALREADY exists it must
   * fire right away, cheapest listing first, not wait for the cron.
   */
  async tryMatchRequest(buyRequestId: string): Promise<boolean> {
    if (!this.enabled) return false;

    const request = await this.prisma.buyRequest.findUnique({
      where: { id: buyRequestId },
      select: {
        id: true,
        buyerId: true,
        productId: true,
        maxPriceUsd: true,
        status: true,
        expiresAt: true,
      },
    });
    if (!request || request.status !== BuyRequestStatus.ACTIVE) return false;
    if (request.expiresAt && request.expiresAt <= new Date()) return false;

    const listings = await this.prisma.listing.findMany({
      where: {
        productId: request.productId,
        status: ListingStatus.ACTIVE,
        sellerId: { not: request.buyerId },
        priceUsd: { lte: request.maxPriceUsd },
      },
      orderBy: [{ priceUsd: 'asc' }, { createdAt: 'asc' }],
      select: { id: true },
    });

    for (const listing of listings) {
      if (await this.matchPair(request.id, listing.id)) return true;
    }
    return false;
  }

  /**
   * Claim both sides defensively in ONE transaction (conditional updateMany on
   * status — a lost race rolls everything back, no order), create the order via
   * the shared OrdersService path, then ask OxaPay for the invoice. An invoice
   * failure is compensated: listing and request go back to ACTIVE, the order
   * stays PENDING_PAYMENT with a null trackId. A listing is never left RESERVED
   * without a live payment window.
   */
  private async matchPair(
    buyRequestId: string,
    listingId: string,
  ): Promise<boolean> {
    const listing = await this.prisma.listing.findUnique({
      where: { id: listingId },
      select: LISTING_FOR_ORDER,
    });
    const request = await this.prisma.buyRequest.findUnique({
      where: { id: buyRequestId },
      select: { id: true, buyerId: true, maxPriceUsd: true },
    });
    if (!listing || !request) return false;

    const reservedUntil = this.reservationDeadline();

    let order: Awaited<ReturnType<OrdersService['createPendingOrderRow']>>;
    try {
      order = await this.prisma.$transaction(async (tx) => {
        // Claim the listing: must still be ACTIVE with a free unit. The claim
        // takes one unit (like a manual order) AND reserves the whole listing.
        // TODO: a multi-unit listing is fully off the market while reserved and
        // goes SOLD outright on payment — acceptable for the MVP.
        const claimedListing = await tx.listing.updateMany({
          where: {
            id: listingId,
            status: ListingStatus.ACTIVE,
            soldCount: { lt: this.prisma.listing.fields.quantity },
          },
          data: {
            status: ListingStatus.RESERVED,
            reservedForId: request.buyerId,
            reservedUntil,
            soldCount: { increment: 1 },
          },
        });
        if (claimedListing.count === 0) throw new MatchRaceLost();

        const claimedRequest = await tx.buyRequest.updateMany({
          where: { id: buyRequestId, status: BuyRequestStatus.ACTIVE },
          data: {
            status: BuyRequestStatus.MATCHED,
            matchedListingId: listingId,
            matchedAt: new Date(),
          },
        });
        if (claimedRequest.count === 0) throw new MatchRaceLost();

        const created = await this.orders.createPendingOrderRow(
          request.buyerId,
          listing,
          tx,
        );
        await tx.buyRequest.update({
          where: { id: buyRequestId },
          data: { matchedOrderId: created.id },
        });
        return created;
      });
    } catch (e) {
      if (e instanceof MatchRaceLost) {
        this.logger.log(
          `Auto-buy race lost: request ${buyRequestId} vs listing ${listingId} — someone else claimed first`,
        );
        return false;
      }
      throw e;
    }

    try {
      await this.orders.attachInvoice(order);
    } catch (e) {
      this.logger.error(
        `!!! AUTO-BUY INVOICE FAILED !!! order ${order.id} (request ${buyRequestId}, listing ${listingId}): ` +
          `${e?.message} — rolling the match back, listing returns to ACTIVE`,
      );
      await this.prisma.$transaction([
        this.prisma.listing.updateMany({
          where: { id: listingId, status: ListingStatus.RESERVED },
          data: {
            status: ListingStatus.ACTIVE,
            reservedForId: null,
            reservedUntil: null,
            soldCount: { decrement: 1 },
          },
        }),
        this.prisma.buyRequest.updateMany({
          where: { id: buyRequestId, status: BuyRequestStatus.MATCHED },
          data: {
            status: BuyRequestStatus.ACTIVE,
            matchedListingId: null,
            matchedOrderId: null,
            matchedAt: null,
          },
        }),
      ]);
      return false;
    }

    this.logger.log(
      `AUTO-BUY MATCH: request ${buyRequestId} ← listing ${listingId}, order ${order.id}, ` +
        `reserved until ${reservedUntil.toISOString()}`,
    );
    return true;
  }

  /**
   * The one permitted payment-webhook hook. If the paid order fulfils a buy
   * request: request FULFILLED, listing SOLD, reservation cleared. Manual
   * purchases have no matching request and fall straight through.
   */
  async onOrderPaid(order: { id: string; listingId: string }): Promise<void> {
    const request = await this.prisma.buyRequest.findFirst({
      where: { matchedOrderId: order.id, status: BuyRequestStatus.MATCHED },
      select: { id: true },
    });
    if (!request) return; // manual purchase — nothing auto-buy about it

    await this.prisma.$transaction([
      this.prisma.buyRequest.update({
        where: { id: request.id },
        data: { status: BuyRequestStatus.FULFILLED },
      }),
      this.prisma.listing.updateMany({
        where: { id: order.listingId, status: ListingStatus.RESERVED },
        data: {
          status: ListingStatus.SOLD,
          reservedForId: null,
          reservedUntil: null,
        },
      }),
    ]);

    this.logger.log(
      `AUTO-BUY FULFILLED: order ${order.id} paid — request ${request.id} FULFILLED, listing ${order.listingId} SOLD`,
    );
  }

  /**
   * Cleanup only — matching itself is synchronous. Idempotent, never throws out
   * of the handler, gated by AUTO_BUY_ENABLED.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async cleanup(): Promise<void> {
    if (!this.enabled) return;

    try {
      await this.expireReservations();
    } catch (e) {
      this.logger.error(`Auto-buy reservation sweep failed: ${e?.message}`);
    }
    try {
      await this.expireRequests();
    } catch (e) {
      this.logger.error(`Auto-buy request-expiry sweep failed: ${e?.message}`);
    }
    try {
      await this.safetySweep();
    } catch (e) {
      this.logger.error(`Auto-buy safety sweep failed: ${e?.message}`);
    }
  }

  /**
   * Reservations whose payment window lapsed: order → EXPIRED, listing → back
   * to ACTIVE, request → back to ACTIVE so it can match again. Then immediately
   * re-run matching for the listing — a second buyer may already be waiting.
   */
  private async expireReservations(): Promise<void> {
    const stale = await this.prisma.listing.findMany({
      where: {
        status: ListingStatus.RESERVED,
        reservedUntil: { lt: new Date() },
      },
      select: { id: true },
    });

    for (const { id: listingId } of stale) {
      const request = await this.prisma.buyRequest.findFirst({
        where: {
          matchedListingId: listingId,
          status: BuyRequestStatus.MATCHED,
        },
        select: { id: true, matchedOrderId: true },
      });
      const order = request?.matchedOrderId
        ? await this.prisma.order.findUnique({
            where: { id: request.matchedOrderId },
            select: { id: true, listingId: true, status: true },
          })
        : null;

      // Paid at the buzzer but the webhook hook didn't finish? Fulfil, not expire.
      if (order && order.status !== OrderStatus.PENDING_PAYMENT) {
        if (order.status === OrderStatus.PAID) {
          await this.onOrderPaid(order);
          continue;
        }
        // Order already EXPIRED via webhook: it released its unit there, so the
        // listing only needs un-reserving here, without a second decrement.
        await this.prisma.$transaction(async (tx) => {
          await tx.listing.updateMany({
            where: { id: listingId, status: ListingStatus.RESERVED },
            data: {
              status: ListingStatus.ACTIVE,
              reservedForId: null,
              reservedUntil: null,
            },
          });
          if (request) {
            await tx.buyRequest.updateMany({
              where: { id: request.id, status: BuyRequestStatus.MATCHED },
              data: {
                status: BuyRequestStatus.ACTIVE,
                matchedListingId: null,
                matchedOrderId: null,
                matchedAt: null,
              },
            });
          }
        });
        this.logger.log(
          `Auto-buy reservation cleared on listing ${listingId} (order already ${order.status})`,
        );
        await this.tryMatchListing(listingId, request?.id);
        continue;
      }

      await this.prisma.$transaction(async (tx) => {
        if (order) {
          await tx.order.update({
            where: { id: order.id },
            data: { status: OrderStatus.EXPIRED },
          });
        }
        await tx.listing.updateMany({
          where: { id: listingId, status: ListingStatus.RESERVED },
          data: {
            status: ListingStatus.ACTIVE,
            reservedForId: null,
            reservedUntil: null,
            // give the claimed unit back — mirrors the webhook expiry path
            ...(order ? { soldCount: { decrement: 1 } } : {}),
          },
        });
        if (request) {
          await tx.buyRequest.updateMany({
            where: { id: request.id, status: BuyRequestStatus.MATCHED },
            data: {
              status: BuyRequestStatus.ACTIVE,
              matchedListingId: null,
              matchedOrderId: null,
              matchedAt: null,
            },
          });
        }
      });

      this.logger.log(
        `AUTO-BUY RESERVATION EXPIRED: listing ${listingId} back to ACTIVE` +
          (order ? `, order ${order.id} EXPIRED` : '') +
          (request ? `, request ${request.id} back to ACTIVE` : ''),
      );

      await this.tryMatchListing(listingId, request?.id);
    }
  }

  private async expireRequests(): Promise<void> {
    const expired = await this.prisma.buyRequest.updateMany({
      where: { status: BuyRequestStatus.ACTIVE, expiresAt: { lt: new Date() } },
      data: { status: BuyRequestStatus.EXPIRED },
    });
    if (expired.count > 0) {
      this.logger.log(`Auto-buy: ${expired.count} buy request(s) EXPIRED`);
    }
  }

  /**
   * Safety net: any ACTIVE request with a qualifying ACTIVE listing should have
   * matched synchronously — catch whatever slipped through (e.g. a tryMatch
   * crash after the listing was committed).
   */
  private async safetySweep(): Promise<void> {
    const requests = await this.prisma.buyRequest.findMany({
      where: {
        status: BuyRequestStatus.ACTIVE,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: { createdAt: 'asc' }, // FIFO across requests
      select: { id: true },
    });

    for (const { id } of requests) {
      const matched = await this.tryMatchRequest(id);
      if (matched) {
        this.logger.warn(
          `Auto-buy safety sweep matched request ${id} — the synchronous path had missed it`,
        );
      }
    }
  }
}
