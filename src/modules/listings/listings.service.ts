import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ListingStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { toFixed2 } from '../../common/money';
import { CreateListingDto } from './dto/create-listing.dto';
import { UpdateListingDto } from './dto/update-listing.dto';
import { QueryListingsDto } from './dto/query-listings.dto';

/**
 * Explicit select — deliveryInfo is simply not fetched, so no listing endpoint can
 * leak it even by accident. Only the orders module may read it, for the paid buyer.
 */
const LISTING_SELECT = {
  id: true,
  sellerId: true,
  title: true,
  description: true,
  category: true,
  priceUsd: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  seller: { select: { id: true, username: true, imageUrl: true } },
} satisfies Prisma.ListingSelect;

type SelectedListing = Prisma.ListingGetPayload<{
  select: typeof LISTING_SELECT;
}>;

@Injectable()
export class ListingsService {
  constructor(private readonly prisma: PrismaService) {}

  private map(l: SelectedListing) {
    return { ...l, priceUsd: toFixed2(l.priceUsd) };
  }

  async findPublic(q: QueryListingsDto) {
    const where: Prisma.ListingWhereInput = {
      status: ListingStatus.ACTIVE,
      ...(q.search
        ? { title: { contains: q.search, mode: 'insensitive' } }
        : {}),
      ...(q.category
        ? { category: { equals: q.category, mode: 'insensitive' } }
        : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.listing.findMany({
        where,
        select: LISTING_SELECT,
        orderBy: { createdAt: 'desc' },
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

  async findMine(sellerId: string) {
    const items = await this.prisma.listing.findMany({
      where: { sellerId, status: { not: ListingStatus.DELETED } },
      select: LISTING_SELECT,
      orderBy: { createdAt: 'desc' },
    });
    return items.map((l) => this.map(l));
  }

  async create(sellerId: string, dto: CreateListingDto) {
    const listing = await this.prisma.listing.create({
      data: {
        sellerId,
        title: dto.title,
        description: dto.description,
        category: dto.category,
        priceUsd: new Prisma.Decimal(dto.priceUsd).toFixed(2),
        deliveryInfo: dto.deliveryInfo,
      },
      select: LISTING_SELECT,
    });
    return this.map(listing);
  }

  async update(id: string, sellerId: string, dto: UpdateListingDto) {
    await this.assertOwner(id, sellerId);

    const listing = await this.prisma.listing.update({
      where: { id },
      data: {
        title: dto.title,
        description: dto.description,
        category: dto.category,
        deliveryInfo: dto.deliveryInfo,
        status: dto.status,
        ...(dto.priceUsd !== undefined
          ? { priceUsd: new Prisma.Decimal(dto.priceUsd).toFixed(2) }
          : {}),
      },
      select: LISTING_SELECT,
    });
    return this.map(listing);
  }

  async remove(id: string, sellerId: string) {
    await this.assertOwner(id, sellerId);
    await this.prisma.listing.update({
      where: { id },
      data: { status: ListingStatus.DELETED },
    });
    return { id, status: ListingStatus.DELETED };
  }

  private async assertOwner(id: string, sellerId: string) {
    const listing = await this.prisma.listing.findUnique({
      where: { id },
      select: { sellerId: true, status: true },
    });
    if (!listing || listing.status === ListingStatus.DELETED) {
      throw new NotFoundException('Listing not found');
    }
    if (listing.sellerId !== sellerId) {
      throw new ForbiddenException('You do not own this listing');
    }
  }
}
