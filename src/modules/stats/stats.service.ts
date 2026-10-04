import { Injectable } from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { sum, toFixed2 } from '../../common/money';

/**
 * Orders the buyer actually got value from. REFUNDED is deliberately out — the
 * buyer got the money back, that is not a saving. Same for unpaid/expired invoices.
 */
const SAVINGS_STATUSES: OrderStatus[] = [
  OrderStatus.PAID,
  OrderStatus.DISPUTED,
];

@Injectable()
export class StatsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Savings are computed from retailPriceUsdSnapshot — the catalog price frozen at
   * purchase time — never from the live Product row, whose price may have changed.
   */
  async savings(buyerId: string) {
    const orders = await this.prisma.order.findMany({
      where: { buyerId, status: { in: SAVINGS_STATUSES } },
      select: {
        id: true,
        amountUsd: true,
        retailPriceUsdSnapshot: true,
        paidAt: true,
        product: { select: { name: true } },
      },
      orderBy: { paidAt: 'desc' },
    });

    const totalSpent = sum(orders.map((o) => o.amountUsd));
    const totalRetail = sum(orders.map((o) => o.retailPriceUsdSnapshot));
    const totalSaved = totalRetail.minus(totalSpent);

    const savedPercent = totalRetail.isZero()
      ? '0.00'
      : totalSaved.times(100).dividedBy(totalRetail).toFixed(2);

    return {
      totalSpentUsd: toFixed2(totalSpent),
      totalRetailUsd: toFixed2(totalRetail),
      totalSavedUsd: toFixed2(totalSaved),
      savedPercent,
      orderCount: orders.length,
      items: orders.map((o) => ({
        orderId: o.id,
        productName: o.product.name,
        paidUsd: toFixed2(o.amountUsd),
        retailUsd: toFixed2(o.retailPriceUsdSnapshot),
        savedUsd: toFixed2(
          new Prisma.Decimal(o.retailPriceUsdSnapshot).minus(o.amountUsd),
        ),
        purchasedAt: o.paidAt,
      })),
    };
  }
}
