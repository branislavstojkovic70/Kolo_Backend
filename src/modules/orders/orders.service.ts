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
import {
  ListingInventoryService,
  NoUnitsAvailable,
} from '../inventory/listing-inventory.service';
import { OxapayService } from '../payments/oxapay.service';
import { OrderRole, QueryOrdersDto } from './dto/query-orders.dto';

/** deliveryInfo is deliberately absent — it is fetched separately, only when allowed. */
const ORDER_SELECT = {
  id: true,
  listingId: true,
  buyerId: true,
  sellerId: true,
  titleSnapshot: true,
  productId: true,
  retailPriceUsdSnapshot: true,
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

/** Everything the shared order-creation path needs to know about the listing. */
export interface ListingForOrder {
  id: string;
  sellerId: string;
  title: string;
  priceUsd: Prisma.Decimal;
  productId: string;
  product: { retailPriceUsd: Prisma.Decimal };
}

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
    private readonly inventory: ListingInventoryService,
  ) {}

  private map(o: SelectedOrder) {
    return {
      ...o,
      amountUsd: toFixed2(o.amountUsd),
      feeUsd: toFixed2(o.feeUsd),
      sellerAmountUsd: toFixed2(o.sellerAmountUsd),
      retailPriceUsdSnapshot: toFixed2(o.retailPriceUsdSnapshot),
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
        productId: true,
        product: { select: { retailPriceUsd: true } },
      },
    });

    if (!listing) {
      throw new NotFoundException('Listing not found or not available');
    }
    if (listing.status !== ListingStatus.ACTIVE) {
      throw new NotFoundException('Listing not found or not available');
    }
    if (listing.sellerId === buyerId) {
      throw new BadRequestException('You cannot buy your own listing');
    }

    // Claim one unit and create the order + its reservation atomically. Other
    // units of the same listing stay on sale — only this unit is held, and it is
    // held whether the order came from here or from the auto-buy matcher.
    let order: SelectedOrder;
    try {
      order = await this.prisma.$transaction(async (tx) => {
        await this.inventory.lockAndAssertUnitAvailable(tx, listing.id);
        // Created inside the claim so a failing OxaPay call still leaves an
        // auditable row, and so the reservation always has an order to point at.
        const created = await this.createPendingOrderRow(buyerId, listing, tx);
        await this.inventory.reserveUnit(tx, {
          listingId: listing.id,
          buyerId,
          orderId: created.id,
          expiresAt: this.inventory.reservationDeadline(),
        });
        return created;
      });
    } catch (e) {
      if (e instanceof NoUnitsAvailable) {
        throw new BadRequestException(
          'This listing is sold out or fully reserved right now. If a reservation expires it comes back on the marketplace.',
        );
      }
      throw e;
    }

    let updated: SelectedOrder;
    try {
      updated = await this.attachInvoice(order);
    } catch (e) {
      // Leave the row PENDING_PAYMENT with a null trackId — never delete it.
      // The unit goes back on the shelf though: without an invoice this order can
      // never be paid, and an OxaPay outage must not hold a unit hostage.
      this.logger.error(
        `Invoice creation failed for order ${order.id}: ${e?.message}`,
      );
      await this.inventory.releaseUnit(order.id);
      throw new BadGatewayException(
        'Could not create the payment invoice. The order was saved — please retry payment.',
      );
    }

    return { order: this.map(updated), paymentUrl: updated.paymentUrl };
  }

  /**
   * The one place a PENDING_PAYMENT order row is built — fee split, snapshots,
   * beneficiary. Shared by the manual buy flow and AutoBuyService so the two can
   * never drift apart. Pass `tx` to create the row inside a caller's transaction.
   */
  async createPendingOrderRow(
    buyerId: string,
    listing: ListingForOrder,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<SelectedOrder> {
    const feePercent = this.config.get<number>('platformFeePercent') ?? 5;
    const { amountUsd, feeUsd, sellerAmountUsd } = calcFee(
      listing.priceUsd,
      feePercent,
    );

    return tx.order.create({
      data: {
        listingId: listing.id,
        buyerId,
        sellerId: listing.sellerId,
        titleSnapshot: listing.title,
        // retail price frozen NOW — savings are never recomputed from the live catalog
        productId: listing.productId,
        retailPriceUsdSnapshot: listing.product.retailPriceUsd,
        amountUsd,
        feeUsd,
        sellerAmountUsd,
        status: OrderStatus.PENDING_PAYMENT,
        beneficiaryId: listing.sellerId,
      },
      select: ORDER_SELECT,
    });
  }

  /**
   * Shared invoice step: asks OxaPay (mock-aware) and stores trackId + paymentUrl.
   * Throws on OxaPay failure — the caller decides how to compensate.
   */
  async attachInvoice(order: SelectedOrder): Promise<SelectedOrder> {
    const invoice = await this.oxapay.createInvoice({
      orderId: order.id,
      amountUsd: toFixed2(order.amountUsd),
      description: order.titleSnapshot,
    });

    return this.prisma.order.update({
      where: { id: order.id },
      data: {
        oxapayTrackId: invoice.track_id,
        paymentUrl: invoice.payment_url,
      },
      select: ORDER_SELECT,
    });
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
