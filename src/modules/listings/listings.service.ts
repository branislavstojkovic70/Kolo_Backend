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
  // auto-buy reservation — null unless the listing is RESERVED
  reservedUntil: true,
  reservedForId: true,
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

  private map(l: SelectedListing) {
    return {
      ...l,
      priceUsd: toFixed2(l.priceUsd),
      product: mapProduct(l.product),
    };
  }

  async findPublic(q: QueryListingsDto) {
    const where: Prisma.ListingWhereInput = {
      status: ListingStatus.ACTIVE,
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
      items: items.map((l) => this.map(l)),
      total,
      page: q.page,
      limit: q.limit,
      pages: Math.ceil(total / q.limit),
    };
  }

  async findOnePublic(id: string) {
    const listing = await this.prisma.listing.findFirst({
      where: { id, status: { not: ListingStatus.DELETED } },
      select: LISTING_SELECT,
    });
    if (!listing) throw new NotFoundException('Listing not found');
    return this.map(listing);
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

    return {
      items: items.map((l) => this.map(l)),
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

    // Auto-buy: a standing wish may claim this listing the instant it exists.
    // A matching failure must NEVER fail the seller's POST — worst case the
    // cron's safety sweep picks the pair up a minute later.
    try {
      const matched = await this.autoBuy.tryMatchListing(listing.id);
      if (matched) {
        const reserved = await this.prisma.listing.findUnique({
          where: { id: listing.id },
          select: LISTING_SELECT,
        });
        if (reserved) return this.map(reserved);
      }
    } catch (e) {
      this.logger.error(
        `Auto-buy matching failed for new listing ${listing.id}: ${e?.message}`,
        e?.stack,
      );
    }

    return this.map(listing);
  }

  async update(id: string, sellerId: string, dto: UpdateListingDto) {
    const current = await this.assertOwner(id, sellerId);

    // While an auto-buy reservation holds the listing, its status belongs to the
    // reservation lifecycle (paid → SOLD, lapsed → ACTIVE), not to the seller.
    if (current.status === ListingStatus.RESERVED && dto.status !== undefined) {
      throw new BadRequestException(
        'This listing is reserved by an auto-buy order awaiting payment — its status cannot be changed until the reservation resolves.',
      );
    }

    // Restocking revives a sold-out listing; shrinking below what is already sold
    // is not a thing that can happen, so it is a 400 rather than a silent clamp.
    if (dto.quantity !== undefined && dto.quantity < current.soldCount) {
      throw new BadRequestException(
        `You have already sold ${current.soldCount} of these — the quantity cannot go below that`,
      );
    }

    const quantity = dto.quantity ?? current.quantity;
    const soldOut = current.soldCount >= quantity;

    // Stock has the last word: a seller cannot re-activate a listing with nothing
    // left to sell, and restocking a sold-out one puts it back on the marketplace.
    // Anything else (PAUSED in particular) is left exactly as asked for.
    const requested = dto.status ?? current.status;
    const status =
      soldOut && requested === ListingStatus.ACTIVE
        ? ListingStatus.SOLD_OUT
        : !soldOut && requested === ListingStatus.SOLD_OUT
          ? ListingStatus.ACTIVE
          : requested;

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
    return this.map(listing);
  }

  async remove(id: string, sellerId: string) {
    const current = await this.assertOwner(id, sellerId);
    if (current.status === ListingStatus.RESERVED) {
      throw new BadRequestException(
        'This listing is reserved by an auto-buy order awaiting payment — wait for the reservation to resolve before deleting it.',
      );
    }
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
