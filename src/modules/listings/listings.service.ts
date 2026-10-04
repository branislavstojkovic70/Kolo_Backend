import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ListingStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { toFixed2 } from '../../common/money';
import { AutoBuyService } from '../buy-requests/auto-buy.service';
import { ListingInventoryService } from '../inventory/listing-inventory.service';
import { mapProduct, PRODUCT_SELECT } from '../products/products.service';
import { CreateListingDto } from './dto/create-listing.dto';
import { UpdateListingDto } from './dto/update-listing.dto';
import { ListingSort, QueryListingsDto } from './dto/query-listings.dto';

/**
 * Explicit select — deliveryInfo is simply not fetched, so no listing endpoint can
 * leak it even by accident. Only the orders module may read it, for the paid buyer.
 */
const LISTING_SELECT = {
  id: true,
  sellerId: true,
  productId: true,
  title: true,
  description: true,
  category: true,
  imageUrl: true,
  priceUsd: true,
  quantity: true,
  soldCount: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  seller: { select: { id: true, username: true, imageUrl: true } },
  // so the FE can strike through the official price next to the seller's price
  product: { select: PRODUCT_SELECT },
} satisfies Prisma.ListingSelect;

type SelectedListing = Prisma.ListingGetPayload<{
  select: typeof LISTING_SELECT;
}>;

const ORDER_BY: Record<ListingSort, Prisma.ListingOrderByWithRelationInput> = {
  [ListingSort.NEWEST]: { createdAt: 'desc' },
  [ListingSort.OLDEST]: { createdAt: 'asc' },
  [ListingSort.PRICE_ASC]: { priceUsd: 'asc' },
  [ListingSort.PRICE_DESC]: { priceUsd: 'desc' },
};

@Injectable()
export class ListingsService {
  private readonly logger = new Logger(ListingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly autoBuy: AutoBuyService,
    private readonly inventory: ListingInventoryService,
  ) {}

  /** search / category / price-range, shared by the public feed and "my listings". */
  private filters(q: QueryListingsDto): Prisma.ListingWhereInput {
    return {
      ...(q.search
        ? { title: { contains: q.search, mode: 'insensitive' } }
        : {}),
      ...(q.category
        ? { category: { equals: q.category, mode: 'insensitive' } }
        : {}),
      ...(q.minPrice !== undefined || q.maxPrice !== undefined
        ? {
            priceUsd: {
              ...(q.minPrice !== undefined ? { gte: q.minPrice } : {}),
              ...(q.maxPrice !== undefined ? { lte: q.maxPrice } : {}),
            },
          }
        : {}),
    };
  }

  private map(l: SelectedListing, availableCount: number) {
    return {
      ...l,
      priceUsd: toFixed2(l.priceUsd),
      // quantity - soldCount - units held by unpaid orders. The number the FE
      // should gate its buy button on; quantity/soldCount stay as they were.
      availableCount,
      product: mapProduct(l.product),
    };
  }

  /** One availability query for a whole page, then map. */
  private async mapPage(listings: SelectedListing[]) {
    const available = await this.inventory.availableCounts(
      listings.map((l) => l.id),
    );
    return listings.map((l) => this.map(l, available.get(l.id) ?? 0));
  }

  async findPublic(q: QueryListingsDto) {
    // Listings with every unit sold or currently held are not on offer. Prisma
    // cannot express the arithmetic in a `where`, so the full ones are excluded
    // by id and the rest of the feed query stays exactly as it was.
    const fullIds = await this.inventory.fullListingIds();

    const where: Prisma.ListingWhereInput = {
      status: ListingStatus.ACTIVE,
      ...(fullIds.length ? { id: { notIn: fullIds } } : {}),
      ...this.filters(q),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.listing.findMany({
        where,
        select: LISTING_SELECT,
        orderBy: ORDER_BY[q.sort] ?? ORDER_BY[ListingSort.NEWEST],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
      this.prisma.listing.count({ where }),
    ]);

    return {
      items: await this.mapPage(items),
      total,
      page: q.page,
      limit: q.limit,
      pages: Math.ceil(total / q.limit),
    };
  }

  /**
   * Detail stays readable even at `availableCount: 0` — a deep link to a listing
   * whose units are momentarily all held must render "fully reserved", not a 404
   * that turns back into a 200 fifteen minutes later.
   */
  async findOnePublic(id: string) {
    const listing = await this.prisma.listing.findFirst({
      where: { id, status: { not: ListingStatus.DELETED } },
      select: LISTING_SELECT,
    });
    if (!listing) throw new NotFoundException('Listing not found');

    const available = await this.inventory.availableCounts([listing.id]);
    return this.map(listing, available.get(listing.id) ?? 0);
  }

  async findMine(sellerId: string, q: QueryListingsDto) {
    const where: Prisma.ListingWhereInput = {
      sellerId,
      status: { not: ListingStatus.DELETED },
      ...this.filters(q),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.listing.findMany({
        where,
        select: LISTING_SELECT,
        orderBy: ORDER_BY[q.sort] ?? ORDER_BY[ListingSort.NEWEST],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
      this.prisma.listing.count({ where }),
    ]);

    // The seller also sees who is holding which unit and until when.
    const ids = items.map((l) => l.id);
    const [mapped, reservations] = await Promise.all([
      this.mapPage(items),
      this.inventory.activeReservationsFor(ids),
    ]);

    return {
      items: mapped.map((l) => ({
        ...l,
        reservations: reservations.get(l.id) ?? [],
      })),
      total,
      page: q.page,
      limit: q.limit,
      pages: Math.ceil(total / q.limit),
    };
  }

  /**
   * Marketplace headline numbers, computed in the database. The frontend used to
   * average a page of listings client-side, which quietly went wrong past one page.
   */
  async stats() {
    const [[row], categoryRows] = await Promise.all([
      this.prisma.$queryRaw<
        { total: bigint; value: string | null; median: string | null }[]
      >`
        SELECT COUNT(*)::bigint                                          AS total,
               COALESCE(SUM("priceUsd"), 0)::text                        AS value,
               COALESCE(
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY "priceUsd"), 0
               )::text                                                   AS median
        FROM "Listing"
        WHERE "status" = 'ACTIVE'
      `,
      // Also the source for the marketplace category dropdown.
      this.prisma.listing.findMany({
        where: { status: ListingStatus.ACTIVE, category: { not: null } },
        distinct: ['category'],
        select: { category: true },
        orderBy: { category: 'asc' },
      }),
    ]);

    return {
      total: Number(row?.total ?? 0),
      categories: categoryRows
        .map((c) => c.category)
        .filter((c): c is string => !!c),
      catalogueValueUsd: toFixed2(new Prisma.Decimal(row?.value ?? 0)),
      medianPriceUsd: toFixed2(new Prisma.Decimal(row?.median ?? 0)),
    };
  }

  async create(sellerId: string, dto: CreateListingDto) {
    // Only catalog products can be listed. title/category are copied from the
    // product so every existing read keeps its exact shape.
    const product = await this.prisma.product.findUnique({
      where: { id: dto.productId },
      select: {
        id: true,
        name: true,
        category: true,
        imageUrl: true,
        active: true,
      },
    });
    if (!product || !product.active) {
      throw new BadRequestException(
        'Unknown product — pick one from GET /api/products',
      );
    }

    const listing = await this.prisma.listing.create({
      data: {
        sellerId,
        productId: product.id,
        title: product.name,
        category: product.category,
        description: dto.description,
        imageUrl: dto.imageUrl ?? product.imageUrl,
        priceUsd: new Prisma.Decimal(dto.priceUsd).toFixed(2),
        deliveryInfo: dto.deliveryInfo,
        quantity: dto.quantity ?? 1,
      },
      select: LISTING_SELECT,
    });

    // Auto-buy: standing wishes may claim units the instant the listing exists —
    // as many units as there are waiting buyers. A matching failure must NEVER
    // fail the seller's POST; worst case the cron's safety sweep picks the pairs
    // up a minute later.
    try {
      await this.autoBuy.tryMatchListing(listing.id);
    } catch (e) {
      this.logger.error(
        `Auto-buy matching failed for new listing ${listing.id}: ${e?.message}`,
        e?.stack,
      );
    }

    // Re-read: matching may have consumed units, so availableCount and status
    // must reflect the post-match reality.
    const fresh =
      (await this.prisma.listing.findUnique({
        where: { id: listing.id },
        select: LISTING_SELECT,
      })) ?? listing;
    const available = await this.inventory.availableCounts([fresh.id]);
    return this.map(fresh, available.get(fresh.id) ?? 0);
  }

  async update(id: string, sellerId: string, dto: UpdateListingDto) {
    const current = await this.assertOwner(id, sellerId);

    // Shrinking below what is already sold OR currently held by an unpaid order
    // would break the inventory invariant, so it is a 400 rather than a silent
    // clamp. Held units are included: those buyers may still pay.
    if (dto.quantity !== undefined) {
      const available = await this.inventory.availableCounts([id]);
      const held =
        current.quantity - current.soldCount - (available.get(id) ?? 0);
      const committed = current.soldCount + held;
      if (dto.quantity < committed) {
        throw new BadRequestException(
          `${current.soldCount} sold and ${held} reserved by buyers who are paying right now — ` +
            `the quantity cannot go below ${committed}`,
        );
      }
    }

    const quantity = dto.quantity ?? current.quantity;
    const fullySold = current.soldCount >= quantity;

    // Stock has the last word: every unit paid for means SOLD no matter what was
    // asked for, and restocking a SOLD listing puts it back on the marketplace.
    // Reservations do not enter into it — a listing whose free units are merely
    // held stays exactly as the seller left it (ACTIVE or PAUSED).
    const status = fullySold
      ? ListingStatus.SOLD
      : (dto.status ??
        (current.status === ListingStatus.SOLD ||
        current.status === ListingStatus.SOLD_OUT
          ? ListingStatus.ACTIVE
          : current.status));

    // productId, title and category are deliberately not updatable — the product
    // is fixed at creation and title/category always mirror it.
    const listing = await this.prisma.listing.update({
      where: { id },
      data: {
        description: dto.description,
        imageUrl: dto.imageUrl,
        deliveryInfo: dto.deliveryInfo,
        status,
        ...(dto.quantity !== undefined ? { quantity: dto.quantity } : {}),
        ...(dto.priceUsd !== undefined
          ? { priceUsd: new Prisma.Decimal(dto.priceUsd).toFixed(2) }
          : {}),
      },
      select: LISTING_SELECT,
    });
    const available = await this.inventory.availableCounts([listing.id]);
    return this.map(listing, available.get(listing.id) ?? 0);
  }

  async remove(id: string, sellerId: string) {
    await this.assertOwner(id, sellerId);
    // Soft-delete is allowed even with units held: the reservations live in their
    // own rows and are unaffected, so a buyer mid-payment can still complete and
    // settle. Hiding the listing does not cancel anyone's order.
    await this.prisma.listing.update({
      where: { id },
      data: { status: ListingStatus.DELETED },
    });
    return { id, status: ListingStatus.DELETED };
  }

  private async assertOwner(id: string, sellerId: string) {
    const listing = await this.prisma.listing.findUnique({
      where: { id },
      select: {
        sellerId: true,
        status: true,
        quantity: true,
        soldCount: true,
      },
    });
    if (!listing || listing.status === ListingStatus.DELETED) {
      throw new NotFoundException('Listing not found');
    }
    if (listing.sellerId !== sellerId) {
      throw new ForbiddenException('You do not own this listing');
    }
    return listing;
  }
}
