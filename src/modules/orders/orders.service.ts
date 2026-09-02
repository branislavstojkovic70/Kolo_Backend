import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ListingStatus, OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { calcFee, toFixed2 } from '../../common/money';
import { OxapayService } from '../payments/oxapay.service';
import { OrderRole, QueryOrdersDto } from './dto/query-orders.dto';

/** deliveryInfo is deliberately absent — it is fetched separately, only when allowed. */
const ORDER_SELECT = {
  id: true,
  listingId: true,
  buyerId: true,
  sellerId: true,
  titleSnapshot: true,
  amountUsd: true,
  feeUsd: true,
  sellerAmountUsd: true,
  status: true,
  beneficiaryId: true,
  oxapayTrackId: true,
  paymentUrl: true,
  paidAt: true,
  vestedAt: true,
  withdrawalId: true,
  createdAt: true,
  updatedAt: true,
  buyer: { select: { id: true, username: true, imageUrl: true } },
  seller: { select: { id: true, username: true, imageUrl: true } },
} satisfies Prisma.OrderSelect;

type SelectedOrder = Prisma.OrderGetPayload<{ select: typeof ORDER_SELECT }>;

/** Statuses where the buyer has actually paid and may see the delivery details. */
const DELIVERED_STATUSES: OrderStatus[] = [
  OrderStatus.PAID,
  OrderStatus.DISPUTED,
  OrderStatus.REFUNDED,
];

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly oxapay: OxapayService,
  ) {}

  private map(o: SelectedOrder) {
    return {
      ...o,
      amountUsd: toFixed2(o.amountUsd),
      feeUsd: toFixed2(o.feeUsd),
      sellerAmountUsd: toFixed2(o.sellerAmountUsd),
    };
  }

  async create(buyerId: string, listingId: string) {
    const listing = await this.prisma.listing.findUnique({
      where: { id: listingId },
      select: {
        id: true,
        sellerId: true,
        title: true,
        priceUsd: true,
        status: true,
      },
    });

    if (!listing || listing.status !== ListingStatus.ACTIVE) {
      throw new NotFoundException('Listing not found or not available');
    }
    if (listing.sellerId === buyerId) {
      throw new BadRequestException('You cannot buy your own listing');
    }

    const feePercent = this.config.get<number>('platformFeePercent') ?? 5;
    const { amountUsd, feeUsd, sellerAmountUsd } = calcFee(
      listing.priceUsd,
      feePercent,
    );

    // Created first so a failing OxaPay call still leaves an auditable row.
    const order = await this.prisma.order.create({
      data: {
        listingId: listing.id,
        buyerId,
        sellerId: listing.sellerId,
        titleSnapshot: listing.title,
        amountUsd,
        feeUsd,
        sellerAmountUsd,
        status: OrderStatus.PENDING_PAYMENT,
        beneficiaryId: listing.sellerId,
      },
      select: ORDER_SELECT,
    });

    let invoice: { track_id: string; payment_url: string };
    try {
      invoice = await this.oxapay.createInvoice({
        orderId: order.id,
        amountUsd: toFixed2(amountUsd),
        description: listing.title,
      });
    } catch (e) {
      // Leave the row PENDING_PAYMENT with a null trackId — never delete it.
      this.logger.error(
        `Invoice creation failed for order ${order.id}: ${e?.message}`,
      );
      throw new BadGatewayException(
        'Could not create the payment invoice. The order was saved — please retry payment.',
      );
    }

    const updated = await this.prisma.order.update({
      where: { id: order.id },
      data: {
        oxapayTrackId: invoice.track_id,
        paymentUrl: invoice.payment_url,
      },
      select: ORDER_SELECT,
    });

    return { order: this.map(updated), paymentUrl: invoice.payment_url };
  }

  /**
   * Both sides in one page. `/purchases` and `/sales` stay as they were, but a
   * combined "all my orders" list cannot be built by merging two paginated
   * responses — the page boundaries would not line up — so it needs its own query.
   */
  findAll(userId: string, q: QueryOrdersDto) {
    const side: Prisma.OrderWhereInput =
      q.role === OrderRole.BUYING
        ? { buyerId: userId }
        : q.role === OrderRole.SELLING
          ? { sellerId: userId }
          : { OR: [{ buyerId: userId }, { sellerId: userId }] };
    return this.findPage(side, q);
  }

  findPurchases(buyerId: string, q: QueryOrdersDto) {
    return this.findPage({ buyerId }, q);
  }

  findSales(sellerId: string, q: QueryOrdersDto) {
    return this.findPage({ sellerId }, q);
  }

  /** Shared list query for purchases and sales — same filters, different side. */
  private async findPage(side: Prisma.OrderWhereInput, q: QueryOrdersDto) {
    const where: Prisma.OrderWhereInput = {
      ...side,
      ...(q.search
        ? { titleSnapshot: { contains: q.search, mode: 'insensitive' } }
        : {}),
      ...(q.status ? { status: q.status } : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        select: ORDER_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
      this.prisma.order.count({ where }),
    ]);

    return {
      items: items.map((o) => this.map(o)),
      total,
      page: q.page,
      limit: q.limit,
      pages: Math.ceil(total / q.limit),
    };
  }

  async findOne(id: string, userId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      select: ORDER_SELECT,
    });
    if (!order) throw new NotFoundException('Order not found');

    if (order.buyerId !== userId && order.sellerId !== userId) {
      throw new ForbiddenException('You do not have access to this order');
    }

    const mapped = this.map(order);

    // Second query, run only when the caller has actually earned the right to see it.
    const canSeeDelivery =
      order.buyerId === userId && DELIVERED_STATUSES.includes(order.status);
    if (!canSeeDelivery) return mapped;

    const listing = await this.prisma.listing.findUnique({
      where: { id: order.listingId },
      select: { deliveryInfo: true },
    });

    return { ...mapped, deliveryInfo: listing?.deliveryInfo ?? null };
  }
}
