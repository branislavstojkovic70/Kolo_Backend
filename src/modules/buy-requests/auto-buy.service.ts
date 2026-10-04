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
import {
  ListingInventoryService,
  NoUnitsAvailable,
} from '../inventory/listing-inventory.service';
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
 * Why a single match attempt ended. `no-units` is the only one that means "this
 * listing is full" — a lost race just means another wish won this unit and the
 * next candidate should get a turn.
 */
type MatchOutcome = 'matched' | 'race' | 'no-units' | 'failed';

/**
 * Auto-buy: standing BuyRequests are matched against listings synchronously at
 * creation time (of either side). Matching claims **one unit** per wish through
 * the same inventory path a manual buy uses, so one multi-unit listing can serve
 * several different wishes at once. The cron below only cleans up lapsed
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
    private readonly inventory: ListingInventoryService,
  ) {}

  private get enabled(): boolean {
    return this.config.get<boolean>('autoBuy.enabled') ?? true;
  }

  /**
   * A listing just appeared (or freed a unit) — hand its free units to the
   * longest-waiting wishes, FIFO, until the units run out or nobody is left
   * waiting. Returns how many matches were made. Callers on the request path
   * must wrap this in try/catch: a matching failure must never fail the seller's
   * POST /api/listings.
   *
   * `excludeRequestIds`: when a reservation lapses the non-paying wish goes back
   * to ACTIVE, but it must not instantly re-claim the very unit it just sat on —
   * the next buyer in line gets first refusal.
   */
  async tryMatchListing(
    listingId: string,
    excludeRequestIds: string[] = [],
  ): Promise<number> {
    if (!this.enabled) return 0;

    const listing = await this.prisma.listing.findUnique({
      where: { id: listingId },
      select: LISTING_FOR_ORDER,
    });
    if (!listing || listing.status !== ListingStatus.ACTIVE) return 0;

    const candidates = await this.prisma.buyRequest.findMany({
      where: {
        productId: listing.productId,
        status: BuyRequestStatus.ACTIVE,
        buyerId: { not: listing.sellerId }, // never match the seller's own wish
        maxPriceUsd: { gte: listing.priceUsd },
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        ...(excludeRequestIds.length
          ? { id: { notIn: excludeRequestIds } }
          : {}),
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });

    let matched = 0;
    for (const candidate of candidates) {
      const outcome = await this.matchPair(candidate.id, listing.id);
      // Keep going after a win: a quantity-2 listing should satisfy two wishes.
      if (outcome === 'matched') {
        matched++;
        continue;
      }
      // Out of units, or OxaPay is refusing invoices — stop pestering it.
      if (outcome === 'no-units' || outcome === 'failed') break;
      // 'race': this wish got claimed elsewhere, try the next one.
    }
    return matched;
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
      const outcome = await this.matchPair(request.id, listing.id);
      if (outcome === 'matched') return true;
      if (outcome === 'failed') return false;
      // 'no-units' / 'race' — this listing cannot serve us, try the next one.
    }
    return false;
  }

  /**
   * One wish ← one unit. The claim and the wish transition happen in ONE
   * transaction: the inventory lock guarantees the unit, the conditional
   * updateMany on the wish guarantees it is not double-matched, and either
   * failure rolls the whole thing back. The OxaPay invoice is requested after
   * the commit; if it fails the unit and the wish both go back.
   */
  private async matchPair(
    buyRequestId: string,
    listingId: string,
  ): Promise<MatchOutcome> {
    const listing = await this.prisma.listing.findUnique({
      where: { id: listingId },
      select: LISTING_FOR_ORDER,
    });
    const request = await this.prisma.buyRequest.findUnique({
      where: { id: buyRequestId },
      select: { id: true, buyerId: true },
    });
    if (!listing || !request) return 'race';

    const expiresAt = this.inventory.reservationDeadline();

    let order: Awaited<ReturnType<OrdersService['createPendingOrderRow']>>;
    try {
      order = await this.prisma.$transaction(async (tx) => {
        await this.inventory.lockAndAssertUnitAvailable(tx, listingId);

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
        await this.inventory.reserveUnit(tx, {
          listingId,
          buyerId: request.buyerId,
          orderId: created.id,
          expiresAt,
        });
        return created;
      });
    } catch (e) {
      if (e instanceof NoUnitsAvailable) return 'no-units';
      if (e instanceof MatchRaceLost) {
        this.logger.log(
          `Auto-buy race lost: request ${buyRequestId} vs listing ${listingId} — someone else claimed first`,
        );
        return 'race';
      }
      throw e;
    }

    try {
      await this.orders.attachInvoice(order);
    } catch (e) {
      this.logger.error(
        `!!! AUTO-BUY INVOICE FAILED !!! order ${order.id} (request ${buyRequestId}, listing ${listingId}): ` +
          `${e?.message} — rolling the match back, the unit goes back on sale`,
      );
      await this.inventory.releaseUnit(order.id);
      await this.prisma.buyRequest.updateMany({
        where: { id: buyRequestId, status: BuyRequestStatus.MATCHED },
        data: {
          status: BuyRequestStatus.ACTIVE,
          matchedListingId: null,
          matchedOrderId: null,
          matchedAt: null,
        },
      });
      return 'failed';
    }

    this.logger.log(
      `AUTO-BUY MATCH: request ${buyRequestId} ← listing ${listingId} (1 unit), order ${order.id}, ` +
        `held until ${expiresAt.toISOString()}`,
    );
    return 'matched';
  }

  /**
   * The one permitted payment-webhook hook. If the paid order fulfils a buy
   * request, the request becomes FULFILLED. The listing side (reservation →
   * soldCount, SOLD when the last unit settles) belongs to
   * ListingInventoryService and is done by the webhook before this runs.
   * Manual purchases have no matching request and fall straight through.
   */
  async onOrderPaid(order: { id: string }): Promise<void> {
    const request = await this.prisma.buyRequest.findFirst({
      where: { matchedOrderId: order.id, status: BuyRequestStatus.MATCHED },
      select: { id: true },
    });
    if (!request) return; // manual purchase — nothing auto-buy about it

    await this.prisma.buyRequest.update({
      where: { id: request.id },
      data: { status: BuyRequestStatus.FULFILLED },
    });

    this.logger.log(
      `AUTO-BUY FULFILLED: order ${order.id} paid — request ${request.id} FULFILLED`,
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
   * Reservations whose payment window lapsed: order → EXPIRED, the held unit is
   * freed, and a wish that was waiting on it goes back to ACTIVE. Then matching
   * re-runs for that listing — another buyer may already be queued. Applies to
   * manual and auto-buy orders alike; a manual one simply has no wish attached.
   */
  private async expireReservations(): Promise<void> {
    const stale = await this.prisma.listingReservation.findMany({
      where: { expiresAt: { lt: new Date() } },
      select: {
        id: true,
        listingId: true,
        orderId: true,
        order: { select: { id: true, status: true } },
      },
    });

    // listingId → wishes that must not instantly re-claim the unit they lost
    const reMatch = new Map<string, string[]>();

    for (const reservation of stale) {
      // Keyed on the ORDER, not the listing: several wishes can now be matched
      // against the same listing at once, so the listing alone is ambiguous.
      const request = await this.prisma.buyRequest.findFirst({
        where: {
          matchedOrderId: reservation.orderId,
          status: BuyRequestStatus.MATCHED,
        },
        select: { id: true },
      });

      // Paid right at the buzzer but the settle step never ran? Settle it now
      // rather than expiring an order the buyer has already paid for.
      if (reservation.order.status === OrderStatus.PAID) {
        await this.inventory.commitSoldUnit(reservation.orderId);
        await this.onOrderPaid(reservation.order);
        this.logger.warn(
          `Lapsed reservation on a PAID order ${reservation.orderId} — settled it late`,
        );
        continue;
      }

      // Already resolved some other way (webhook expiry, dispute, …): the row is
      // just stale bookkeeping.
      if (reservation.order.status !== OrderStatus.PENDING_PAYMENT) {
        await this.prisma.listingReservation.deleteMany({
          where: { id: reservation.id },
        });
        continue;
      }

      await this.prisma.$transaction(async (tx) => {
        await tx.order.update({
          where: { id: reservation.orderId },
          data: { status: OrderStatus.EXPIRED },
        });
        await tx.listingReservation.deleteMany({ where: { id: reservation.id } });
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
        `RESERVATION EXPIRED: listing ${reservation.listingId} freed 1 unit, ` +
          `order ${reservation.orderId} EXPIRED` +
          (request ? `, request ${request.id} back to ACTIVE` : ''),
      );

      const excluded = reMatch.get(reservation.listingId) ?? [];
      if (request) excluded.push(request.id);
      reMatch.set(reservation.listingId, excluded);
    }

    // One pass per listing — it fills every unit that just came free.
    for (const [listingId, excluded] of reMatch) {
      await this.tryMatchListing(listingId, excluded);
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
   * Safety net: any ACTIVE request with a qualifying listing that still has a
   * free unit should have matched synchronously — catch whatever slipped through
   * (e.g. a tryMatch crash after the listing was committed).
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
