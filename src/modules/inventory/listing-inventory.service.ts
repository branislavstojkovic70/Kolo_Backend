import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ListingStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/** A claim was refused because the listing had no free unit at that moment. */
export class NoUnitsAvailable extends Error {
  constructor(public readonly listingId: string) {
    super(`Listing ${listingId} has no available unit`);
    this.name = 'NoUnitsAvailable';
  }
}

/**
 * THE definition of an "active" reservation, written once. A reservation holds
 * its unit while its deadline is in the future AND its order is still unpaid —
 * so a unit frees itself the moment the window lapses, even before the cron has
 * got round to deleting the row.
 */
const HELD_UNITS = Prisma.sql`
  SELECT r."listingId" AS lid, COALESCE(SUM(r."quantity"), 0)::int AS held
  FROM "ListingReservation" r
  JOIN "Order" o ON o."id" = r."orderId"
  WHERE r."expiresAt" > now() AND o."status" = 'PENDING_PAYMENT'
  GROUP BY r."listingId"
`;

/** One held unit as the seller sees it in GET /api/listings/mine. */
export interface ActiveReservation {
  id: string;
  buyerId: string;
  buyerUsername: string | null;
  orderId: string;
  quantity: number;
  expiresAt: Date;
}

/**
 * Listing inventory — the single owner of the availability rule:
 *
 *     availableCount = quantity - soldCount - sum(active reservations)
 *
 * and of its invariant: **soldCount plus active reservations never exceeds
 * quantity.** Both the manual buy and the auto-buy matcher claim through
 * `lockAndAssertUnitAvailable` + `reserveUnit`; nothing else may touch
 * `soldCount` or the reservation table.
 *
 * Concurrency: we take a row lock with `SELECT … FOR UPDATE` on the listing at
 * the top of the claim transaction (option **b**). A plain conditional
 * `updateMany` cannot express "only if availableCount >= 1" because the held
 * units live in another table, and a raw UPDATE with a correlated subquery would
 * lean on Postgres re-evaluating that subquery during EvalPlanQual — subtle
 * behaviour we are not willing to bet money logic on. The explicit lock is
 * boring and provable instead: concurrent claims on one listing serialize, and
 * because Prisma runs on Postgres' default READ COMMITTED, the loser's
 * availability query takes a fresh snapshot *after* it acquires the lock and
 * therefore sees the winner's committed reservation. Different listings never
 * block each other, and each transaction locks exactly one row, so there is no
 * deadlock cycle.
 */
@Injectable()
export class ListingInventoryService {
  private readonly logger = new Logger(ListingInventoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** How long a claimed unit is held while the buyer pays. */
  reservationDeadline(): Date {
    const minutes = this.config.get<number>('autoBuy.reservationMinutes') ?? 15;
    return new Date(Date.now() + minutes * 60_000);
  }

  /**
   * Step 1 of a claim: lock the listing row, then verify it is still buyable and
   * still has a free unit. Throws `NoUnitsAvailable` otherwise. MUST be called
   * as the first statement of the caller's transaction, and the caller must
   * create the order + `reserveUnit` inside that same transaction.
   */
  async lockAndAssertUnitAvailable(
    tx: Prisma.TransactionClient,
    listingId: string,
  ): Promise<void> {
    // The lock itself. Serializes every other claim on this listing.
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Listing" WHERE "id" = ${listingId} FOR UPDATE
    `;
    if (locked.length === 0) throw new NoUnitsAvailable(listingId);

    // Read availability only now — under the lock, on a fresh snapshot.
    const [row] = await tx.$queryRaw<
      { status: ListingStatus; available: number }[]
    >`
      SELECT l."status",
             l."quantity" - l."soldCount" - COALESCE(h.held, 0) AS available
      FROM "Listing" l
      LEFT JOIN (${HELD_UNITS}) h ON h.lid = l."id"
      WHERE l."id" = ${listingId}
    `;

    if (!row || row.status !== ListingStatus.ACTIVE) {
      throw new NoUnitsAvailable(listingId);
    }
    if (Number(row.available) < 1) throw new NoUnitsAvailable(listingId);
  }

  /** Step 2 of a claim: the order now exists, so record the held unit. */
  async reserveUnit(
    tx: Prisma.TransactionClient,
    params: {
      listingId: string;
      buyerId: string;
      orderId: string;
      expiresAt: Date;
    },
  ) {
    return tx.listingReservation.create({
      data: {
        listingId: params.listingId,
        buyerId: params.buyerId,
        orderId: params.orderId,
        quantity: 1,
        expiresAt: params.expiresAt,
      },
    });
  }

  /**
   * Give a held unit back without selling it — invoice failure, expiry,
   * cancellation. Idempotent: returns false when there was nothing to release.
   */
  async releaseUnit(orderId: string): Promise<boolean> {
    const { count } = await this.prisma.listingReservation.deleteMany({
      where: { orderId },
    });
    if (count > 0) {
      this.logger.log(`Reservation released for order ${orderId}`);
    }
    return count > 0;
  }

  /**
   * The order was paid: the reservation becomes a sale. Deleting the reservation
   * row is what makes this exactly-once — a replayed webhook finds nothing to
   * delete and does not double-count. Flips the listing to SOLD when the last
   * unit settles.
   */
  async commitSoldUnit(orderId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const reservation = await tx.listingReservation.findUnique({
        where: { orderId },
        select: { id: true, listingId: true, quantity: true },
      });
      if (!reservation) {
        this.logger.warn(
          `commitSoldUnit: order ${orderId} had no reservation — nothing to settle`,
        );
        return;
      }

      // Lock before touching soldCount so a concurrent claim cannot read a stale
      // availableCount and hand out the unit we are about to consume.
      await tx.$queryRaw`SELECT "id" FROM "Listing" WHERE "id" = ${reservation.listingId} FOR UPDATE`;

      const deleted = await tx.listingReservation.deleteMany({
        where: { id: reservation.id },
      });
      if (deleted.count === 0) return; // lost the race to another settler

      const listing = await tx.listing.findUnique({
        where: { id: reservation.listingId },
        select: { quantity: true, soldCount: true, status: true },
      });
      if (!listing) return;

      // The invariant wins over the counter: a payment that arrives after the
      // window lapsed and after the freed unit was resold must not push
      // soldCount past quantity.
      // TODO: an oversell needs a human (refund via dispute) — we only shout.
      if (listing.soldCount + reservation.quantity > listing.quantity) {
        this.logger.error(
          `!!! OVERSOLD !!! listing ${reservation.listingId}: order ${orderId} paid after its ` +
            `reservation lapsed and the unit was resold (soldCount=${listing.soldCount}/${listing.quantity}). ` +
            `Money was taken — resolve manually.`,
        );
        return;
      }

      const soldCount = listing.soldCount + reservation.quantity;
      await tx.listing.update({
        where: { id: reservation.listingId },
        data: {
          soldCount,
          // Only a fully settled listing leaves the marketplace. A listing whose
          // remaining units are merely reserved stays ACTIVE.
          ...(soldCount >= listing.quantity
            ? { status: ListingStatus.SOLD }
            : {}),
        },
      });

      this.logger.log(
        `Unit settled on listing ${reservation.listingId} (order ${orderId}): ` +
          `soldCount=${soldCount}/${listing.quantity}` +
          (soldCount >= listing.quantity ? ' → SOLD' : ''),
      );
    });
  }

  /** availableCount per listing id, for the read endpoints. */
  async availableCounts(listingIds: string[]): Promise<Map<string, number>> {
    if (listingIds.length === 0) return new Map();

    const rows = await this.prisma.$queryRaw<
      { id: string; available: number }[]
    >`
      SELECT l."id",
             l."quantity" - l."soldCount" - COALESCE(h.held, 0) AS available
      FROM "Listing" l
      LEFT JOIN (${HELD_UNITS}) h ON h.lid = l."id"
      WHERE l."id" IN (${Prisma.join(listingIds)})
    `;

    return new Map(rows.map((r) => [r.id, Math.max(0, Number(r.available))]));
  }

  /**
   * The active reservations per listing, for the seller's own view — "2 of your
   * 5 units are held right now, by whom and until when".
   */
  async activeReservationsFor(
    listingIds: string[],
  ): Promise<Map<string, ActiveReservation[]>> {
    if (listingIds.length === 0) return new Map();

    const rows = await this.prisma.$queryRaw<
      (ActiveReservation & { listingId: string })[]
    >`
      SELECT r."id", r."listingId", r."buyerId", r."orderId", r."quantity",
             r."expiresAt", u."username" AS "buyerUsername"
      FROM "ListingReservation" r
      JOIN "Order" o ON o."id" = r."orderId"
      JOIN "User" u ON u."id" = r."buyerId"
      WHERE r."expiresAt" > now()
        AND o."status" = 'PENDING_PAYMENT'
        AND r."listingId" IN (${Prisma.join(listingIds)})
      ORDER BY r."expiresAt" ASC
    `;

    const byListing = new Map<string, ActiveReservation[]>();
    for (const { listingId, ...reservation } of rows) {
      const list = byListing.get(listingId) ?? [];
      list.push(reservation);
      byListing.set(listingId, list);
    }
    return byListing;
  }

  /**
   * ACTIVE listings with nothing left to give right now. The public feed hides
   * these: Prisma cannot express the arithmetic in a `where`, and rewriting the
   * whole filtered/sorted/paginated feed query in raw SQL would be a far bigger
   * change than excluding a handful of ids.
   */
  async fullListingIds(): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT l."id"
      FROM "Listing" l
      LEFT JOIN (${HELD_UNITS}) h ON h.lid = l."id"
      WHERE l."status" = 'ACTIVE'
        AND l."quantity" - l."soldCount" - COALESCE(h.held, 0) <= 0
    `;
    return rows.map((r) => r.id);
  }
}
