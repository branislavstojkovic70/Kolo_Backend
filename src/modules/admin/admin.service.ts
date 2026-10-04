import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  DisputeStatus,
  OrderStatus,
  Prisma,
  WithdrawalStatus,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { sum, toFixed2 } from '../../common/money';
import { TelegramService } from '../telegram/telegram.service';
import {
  QueryAdminDisputesDto,
  QueryAdminOrdersDto,
  QueryAdminWithdrawalsDto,
} from './dto/query-admin.dto';
import { ResolveDisputeDto } from './dto/resolve-dispute.dto';

/** Everything the FE dashboard table needs, in one query — no N+1 follow-up calls. */
const ADMIN_DISPUTE_SELECT = {
  id: true,
  orderId: true,
  reason: true,
  status: true,
  telegramChatId: true,
  telegramInviteLink: true,
  resolvedById: true,
  resolutionNote: true,
  resolvedAt: true,
  createdAt: true,
  openedBy: { select: { id: true, email: true, username: true } },
  resolvedBy: { select: { id: true, email: true, username: true } },
  order: {
    select: {
      id: true,
      titleSnapshot: true,
      amountUsd: true,
      feeUsd: true,
      sellerAmountUsd: true,
      status: true,
      paidAt: true,
      vestedAt: true,
      withdrawalId: true,
      beneficiaryId: true,
      buyer: { select: { id: true, email: true, username: true } },
      seller: { select: { id: true, email: true, username: true } },
    },
  },
} satisfies Prisma.DisputeSelect;

type AdminDispute = Prisma.DisputeGetPayload<{
  select: typeof ADMIN_DISPUTE_SELECT;
}>;

const ADMIN_ORDER_SELECT = {
  id: true,
  titleSnapshot: true,
  amountUsd: true,
  feeUsd: true,
  sellerAmountUsd: true,
  status: true,
  beneficiaryId: true,
  oxapayTrackId: true,
  paidAt: true,
  vestedAt: true,
  withdrawalId: true,
  createdAt: true,
  buyer: { select: { id: true, email: true, username: true } },
  seller: { select: { id: true, email: true, username: true } },
  dispute: { select: { id: true, status: true } },
} satisfies Prisma.OrderSelect;

type AdminOrder = Prisma.OrderGetPayload<{ select: typeof ADMIN_ORDER_SELECT }>;

/** Orders that actually moved money — the base set for volume and fee stats. */
const SETTLED_STATUSES = [
  OrderStatus.PAID,
  OrderStatus.DISPUTED,
  OrderStatus.REFUNDED,
];

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramService,
  ) {}

  private mapDispute(d: AdminDispute) {
    return {
      ...d,
      order: {
        ...d.order,
        amountUsd: toFixed2(d.order.amountUsd),
        feeUsd: toFixed2(d.order.feeUsd),
        sellerAmountUsd: toFixed2(d.order.sellerAmountUsd),
      },
    };
  }

  private mapOrder(o: AdminOrder) {
    return {
      ...o,
      amountUsd: toFixed2(o.amountUsd),
      feeUsd: toFixed2(o.feeUsd),
      sellerAmountUsd: toFixed2(o.sellerAmountUsd),
    };
  }

  // ---------------------------------------------------------------- disputes

  async listDisputes(q: QueryAdminDisputesDto) {
    const where: Prisma.DisputeWhereInput = {
      // Search hits the disputed order's title, same as disputes/mine.
      ...(q.search
        ? {
            order: {
              is: {
                titleSnapshot: { contains: q.search, mode: 'insensitive' },
              },
            },
          }
        : {}),
      ...(q.status ? { status: q.status } : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.dispute.findMany({
        where,
        select: ADMIN_DISPUTE_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
      this.prisma.dispute.count({ where }),
    ]);

    return {
      items: items.map((d) => this.mapDispute(d)),
      total,
      page: q.page,
      limit: q.limit,
      pages: Math.ceil(total / q.limit),
    };
  }

  /**
   * CLAUDE.md section 3, verbatim:
   *   SELLER wins -> dispute RESOLVED_SELLER, order back to PAID, beneficiary and
   *                  vestedAt UNTOUCHED — if vesting has not passed he waits it out.
   *   BUYER wins  -> dispute RESOLVED_BUYER, order REFUNDED, beneficiary = buyer,
   *                  vestedAt = now so the buyer can withdraw immediately.
   * No money is moved here. WalletService.getWithdrawableOrders picks REFUNDED orders
   * up by beneficiaryId on the very next balance call — that is the whole mechanism.
   */
  async resolveDispute(id: string, adminId: string, dto: ResolveDisputeDto) {
    const existing = await this.prisma.dispute.findUnique({
      where: { id },
      select: { id: true, status: true, telegramChatId: true, orderId: true },
    });
    if (!existing) throw new NotFoundException('Dispute not found');
    if (existing.status !== DisputeStatus.OPEN) {
      throw new ConflictException(
        `This dispute is already resolved (${existing.status}) and cannot be resolved again`,
      );
    }

    const buyerWins = dto.winner === 'BUYER';
    const now = new Date();

    const { dispute, order } = await this.prisma.$transaction(async (tx) => {
      // updateMany + count is the double-resolve guard: if two admins click at the
      // same time the second one updates 0 rows and gets the 409.
      const claimed = await tx.dispute.updateMany({
        where: { id, status: DisputeStatus.OPEN },
        data: {
          status: buyerWins
            ? DisputeStatus.RESOLVED_BUYER
            : DisputeStatus.RESOLVED_SELLER,
          resolvedById: adminId,
          resolvedAt: now,
          resolutionNote: dto.note ?? null,
        },
      });
      if (claimed.count !== 1) {
        throw new ConflictException(
          'This dispute was just resolved by someone else',
        );
      }

      const current = await tx.order.findUniqueOrThrow({
        where: { id: existing.orderId },
        select: { buyerId: true },
      });

      const updatedOrder = await tx.order.update({
        where: { id: existing.orderId },
        data: buyerWins
          ? {
              status: OrderStatus.REFUNDED,
              beneficiaryId: current.buyerId,
              vestedAt: now,
            }
          : {
              // beneficiaryId and vestedAt are deliberately absent: the seller keeps
              // his original vesting clock and waits it out if it has not passed.
              status: OrderStatus.PAID,
            },
        select: ADMIN_ORDER_SELECT,
      });

      const updatedDispute = await tx.dispute.findUniqueOrThrow({
        where: { id },
        select: ADMIN_DISPUTE_SELECT,
      });

      return { dispute: updatedDispute, order: updatedOrder };
    });

    this.logger.log(
      `Dispute ${id} resolved for the ${dto.winner} by admin ${adminId} — order ${order.id} ` +
        `is now ${order.status}, beneficiary ${order.beneficiaryId}, ` +
        `vestedAt ${order.vestedAt?.toISOString() ?? 'null'}`,
    );

    // Telegram is best-effort and strictly after the transaction. postToDisputeGroup
    // caps itself with TELEGRAM_TIMEOUT_MS and swallows its own errors; this try/catch
    // is the belt to that pair of braces.
    if (existing.telegramChatId) {
      try {
        await this.telegram.postToDisputeGroup(
          existing.telegramChatId,
          this.resolutionMessage(dto, order),
        );
      } catch (e) {
        this.logger.error(
          `Could not post the resolution of dispute ${id} to Telegram chat ` +
            `${existing.telegramChatId}: ${e?.message} — the resolution stands`,
        );
      }
    } else {
      this.logger.warn(
        `Dispute ${id} has no telegramChatId — nothing to post. ` +
          `POST /api/admin/disputes/${id}/telegram-retry creates the group if it is missing.`,
      );
    }

    return { dispute: this.mapDispute(dispute), order: this.mapOrder(order) };
  }

  private resolutionMessage(dto: ResolveDisputeDto, order: AdminOrder): string {
    const buyerWins = dto.winner === 'BUYER';
    const winner = buyerWins ? order.buyer : order.seller;
    return [
      buyerWins
        ? '🔵 Dispute resolved — BUYER wins'
        : '🟢 Dispute resolved — SELLER wins',
      '',
      `Order: ${order.id}`,
      `Item: ${order.titleSnapshot}`,
      `Amount: $${toFixed2(order.sellerAmountUsd)}`,
      `Goes to: ${winner.email}`,
      '',
      dto.note ? `Admin note: ${dto.note}` : 'No admin note.',
      '',
      buyerWins
        ? 'The buyer can withdraw immediately.'
        : 'The seller keeps the funds; his original vesting date is unchanged.',
    ].join('\n');
  }

  // ------------------------------------------------------------------ orders

  async listOrders(q: QueryAdminOrdersDto) {
    const where: Prisma.OrderWhereInput = q.status ? { status: q.status } : {};

    const [items, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        select: ADMIN_ORDER_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
      this.prisma.order.count({ where }),
    ]);

    return {
      items: items.map((o) => this.mapOrder(o)),
      total,
      page: q.page,
      limit: q.limit,
      pages: Math.ceil(total / q.limit),
    };
  }

  // ------------------------------------------------------------- withdrawals

  async listWithdrawals(q: QueryAdminWithdrawalsDto) {
    const where: Prisma.WithdrawalWhereInput = q.status
      ? { status: q.status }
      : {};

    const [items, total] = await this.prisma.$transaction([
      this.prisma.withdrawal.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.limit,
        take: q.limit,
        select: {
          id: true,
          amountUsd: true,
          currency: true,
          network: true,
          address: true,
          status: true,
          oxapayTrackId: true,
          error: true,
          completedAt: true,
          createdAt: true,
          user: { select: { id: true, email: true, username: true } },
          _count: { select: { orders: true } },
        },
      }),
      this.prisma.withdrawal.count({ where }),
    ]);

    return {
      items: items.map(({ _count, ...w }) => ({
        ...w,
        amountUsd: toFixed2(w.amountUsd),
        orderCount: _count.orders,
      })),
      total,
      page: q.page,
      limit: q.limit,
      pages: Math.ceil(total / q.limit),
    };
  }

  // ------------------------------------------------------------------- stats

  async getStats() {
    const [
      users,
      listings,
      ordersByStatus,
      settled,
      escrow,
      paidOut,
      openDisputes,
      disputesByStatus,
      savings,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.listing.count(),
      this.prisma.order.groupBy({ by: ['status'], _count: { _all: true } }),
      // gross volume + platform fees: every order the buyer actually paid for
      this.prisma.order.aggregate({
        where: { status: { in: SETTLED_STATUSES } },
        _sum: { amountUsd: true, feeUsd: true },
      }),
      // escrow: seller-side money still sitting on our OxaPay account, unwithdrawn
      this.prisma.order.aggregate({
        where: {
          status: { in: [OrderStatus.PAID, OrderStatus.DISPUTED] },
          withdrawalId: null,
        },
        _sum: { sellerAmountUsd: true },
      }),
      this.prisma.withdrawal.aggregate({
        where: { status: WithdrawalStatus.COMPLETED },
        _sum: { amountUsd: true },
      }),
      this.prisma.dispute.count({ where: { status: DisputeStatus.OPEN } }),
      this.prisma.dispute.groupBy({ by: ['status'], _count: { _all: true } }),
      // buyer savings vs. the retail snapshot — same statuses as /api/stats/savings
      this.prisma.order.aggregate({
        where: { status: { in: [OrderStatus.PAID, OrderStatus.DISPUTED] } },
        _sum: { amountUsd: true, retailPriceUsdSnapshot: true },
      }),
    ]);

    const counts = (rows: { status: string; _count: { _all: number } }[]) =>
      Object.fromEntries(rows.map((r) => [r.status, r._count._all]));

    // Every enum key is present even at zero, so the FE table never has holes.
    const orders: Record<string, number> = {
      ...Object.fromEntries(Object.values(OrderStatus).map((s) => [s, 0])),
      ...counts(ordersByStatus),
    };
    const disputes: Record<string, number> = {
      ...Object.fromEntries(Object.values(DisputeStatus).map((s) => [s, 0])),
      ...counts(disputesByStatus),
    };

    return {
      users,
      listings,
      orders: {
        total: Object.values(orders).reduce((a, b) => a + b, 0),
        byStatus: orders,
      },
      disputes: {
        total: Object.values(disputes).reduce((a, b) => a + b, 0),
        open: openDisputes,
        byStatus: disputes,
      },
      money: {
        grossVolumeUsd: toFixed2(sum([settled._sum.amountUsd ?? 0])),
        platformFeesUsd: toFixed2(sum([settled._sum.feeUsd ?? 0])),
        inEscrowUsd: toFixed2(sum([escrow._sum.sellerAmountUsd ?? 0])),
        paidOutUsd: toFixed2(sum([paidOut._sum.amountUsd ?? 0])),
        // what buyers saved vs. retail across all PAID/DISPUTED orders
        buyerRetailUsd: toFixed2(
          sum([savings._sum.retailPriceUsdSnapshot ?? 0]),
        ),
        buyerSavedUsd: toFixed2(
          sum([savings._sum.retailPriceUsdSnapshot ?? 0]).minus(
            sum([savings._sum.amountUsd ?? 0]),
          ),
        ),
      },
    };
  }
}
