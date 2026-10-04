import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { BuyRequestStatus, Prisma, Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { toFixed2 } from '../../common/money';
import { mapProduct, PRODUCT_SELECT } from '../products/products.service';
import { AutoBuyService } from './auto-buy.service';
import { CreateBuyRequestDto } from './dto/create-buy-request.dto';
import { QueryBuyRequestsDto } from './dto/query-buy-requests.dto';

/**
 * matchedOrder gives the FE everything for the "your wish matched — pay now"
 * card: order id, amount and the live payment link.
 */
const BUY_REQUEST_SELECT = {
  id: true,
  buyerId: true,
  productId: true,
  maxPriceUsd: true,
  status: true,
  expiresAt: true,
  matchedListingId: true,
  matchedOrderId: true,
  matchedAt: true,
  createdAt: true,
  updatedAt: true,
  product: { select: PRODUCT_SELECT },
  matchedOrder: {
    select: { id: true, amountUsd: true, paymentUrl: true, status: true },
  },
} satisfies Prisma.BuyRequestSelect;

type SelectedBuyRequest = Prisma.BuyRequestGetPayload<{
  select: typeof BUY_REQUEST_SELECT;
}>;

/** Admin list adds who the buyer is. */
const ADMIN_BUY_REQUEST_SELECT = {
  ...BUY_REQUEST_SELECT,
  buyer: { select: { id: true, username: true, email: true, imageUrl: true } },
} satisfies Prisma.BuyRequestSelect;

type SelectedAdminBuyRequest = Prisma.BuyRequestGetPayload<{
  select: typeof ADMIN_BUY_REQUEST_SELECT;
}>;

@Injectable()
export class BuyRequestsService {
  private readonly logger = new Logger(BuyRequestsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly autoBuy: AutoBuyService,
  ) {}

  private map(r: SelectedBuyRequest | SelectedAdminBuyRequest) {
    return {
      ...r,
      maxPriceUsd: toFixed2(r.maxPriceUsd),
      product: mapProduct(r.product),
      matchedOrder: r.matchedOrder
        ? { ...r.matchedOrder, amountUsd: toFixed2(r.matchedOrder.amountUsd) }
        : null,
    };
  }

  async create(buyerId: string, dto: CreateBuyRequestDto) {
    const product = await this.prisma.product.findUnique({
      where: { id: dto.productId },
      select: { id: true, active: true },
    });
    if (!product || !product.active) {
      throw new BadRequestException(
        'Unknown product — pick one from GET /api/products',
      );
    }
    if (dto.expiresAt && dto.expiresAt <= new Date()) {
      throw new BadRequestException('expiresAt must be in the future');
    }

    const existing = await this.prisma.buyRequest.findFirst({
      where: {
        buyerId,
        productId: dto.productId,
        status: BuyRequestStatus.ACTIVE,
      },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(
        'You already have an active buy request for this product — cancel it first to change the price.',
      );
    }

    const request = await this.prisma.buyRequest.create({
      data: {
        buyerId,
        productId: dto.productId,
        maxPriceUsd: new Prisma.Decimal(dto.maxPriceUsd).toFixed(2),
        expiresAt: dto.expiresAt ?? null,
      },
    });

    // A wish created after a cheap listing already exists must fire right away —
    // but a matching hiccup must never fail the POST itself.
    try {
      await this.autoBuy.tryMatchRequest(request.id);
    } catch (e) {
      this.logger.error(
        `tryMatchRequest failed for new buy request ${request.id}: ${e?.message}`,
        e?.stack,
      );
    }

    return this.findOneRaw(request.id);
  }

  async findMine(buyerId: string, q: QueryBuyRequestsDto) {
    const where: Prisma.BuyRequestWhereInput = {
      buyerId,
      ...(q.status ? { status: q.status } : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.buyRequest.findMany({
        where,
        select: BUY_REQUEST_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
      this.prisma.buyRequest.count({ where }),
    ]);

    return {
      items: items.map((r) => this.map(r)),
      total,
      page: q.page,
      limit: q.limit,
      pages: Math.ceil(total / q.limit),
    };
  }

  async findOne(id: string, user: { id: string; role: Role }) {
    const request = await this.prisma.buyRequest.findUnique({
      where: { id },
      select: BUY_REQUEST_SELECT,
    });
    if (!request) throw new NotFoundException('Buy request not found');
    if (request.buyerId !== user.id && user.role !== Role.ADMIN) {
      throw new ForbiddenException('This is not your buy request');
    }
    return this.map(request);
  }

  private async findOneRaw(id: string) {
    const request = await this.prisma.buyRequest.findUnique({
      where: { id },
      select: BUY_REQUEST_SELECT,
    });
    if (!request) throw new NotFoundException('Buy request not found');
    return this.map(request);
  }

  async cancel(id: string, buyerId: string) {
    const request = await this.prisma.buyRequest.findUnique({
      where: { id },
      select: { id: true, buyerId: true, status: true },
    });
    if (!request) throw new NotFoundException('Buy request not found');
    if (request.buyerId !== buyerId) {
      throw new ForbiddenException('This is not your buy request');
    }
    if (request.status === BuyRequestStatus.MATCHED) {
      throw new ConflictException(
        'This request already matched and an order is awaiting payment. Simply don’t pay — it cancels itself when the reservation expires.',
      );
    }
    if (request.status !== BuyRequestStatus.ACTIVE) {
      throw new ConflictException(
        `Only an ACTIVE request can be cancelled (this one is ${request.status})`,
      );
    }

    // Conditional update: if the matcher claims it in this very moment, 409.
    const cancelled = await this.prisma.buyRequest.updateMany({
      where: { id, status: BuyRequestStatus.ACTIVE },
      data: { status: BuyRequestStatus.CANCELLED },
    });
    if (cancelled.count === 0) {
      throw new ConflictException(
        'The request just matched a listing — it can no longer be cancelled.',
      );
    }
    return this.findOneRaw(id);
  }

  async adminList(q: QueryBuyRequestsDto) {
    const where: Prisma.BuyRequestWhereInput = q.status
      ? { status: q.status }
      : {};

    const [items, total] = await this.prisma.$transaction([
      this.prisma.buyRequest.findMany({
        where,
        select: ADMIN_BUY_REQUEST_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
      this.prisma.buyRequest.count({ where }),
    ]);

    return {
      items: items.map((r) => this.map(r)),
      total,
      page: q.page,
      limit: q.limit,
      pages: Math.ceil(total / q.limit),
    };
  }
}
