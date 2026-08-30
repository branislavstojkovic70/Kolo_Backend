import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DisputeStatus,
  OrderStatus,
  Prisma,
  WithdrawalStatus,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { sum, toFixed2 } from '../../common/money';
import { OxapayService } from '../payments/oxapay.service';
import { CreateWithdrawalDto } from './dto/create-withdrawal.dto';

const WITHDRAWABLE_SELECT = {
  id: true,
  titleSnapshot: true,
  sellerAmountUsd: true,
  status: true,
  vestedAt: true,
  paidAt: true,
  withdrawalId: true,
} satisfies Prisma.OrderSelect;

type WithdrawableOrder = Prisma.OrderGetPayload<{
  select: typeof WITHDRAWABLE_SELECT;
}>;

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly oxapay: OxapayService,
  ) {}

  /**
   * THE single source of truth for withdrawable funds (CLAUDE.md section 3).
   * An order's sellerAmountUsd is withdrawable by `userId` iff:
   *   1. status IN (PAID, REFUNDED)
   *   2. beneficiaryId === userId
   *   3. vestedAt <= now()
   *   4. no dispute with status OPEN
   *   5. withdrawalId IS NULL
   * Do not re-implement this anywhere. getBalance() and createWithdrawal() both call it.
   */
  async getWithdrawableOrders(userId: string): Promise<WithdrawableOrder[]> {
    return this.prisma.order.findMany({
      where: {
        status: { in: [OrderStatus.PAID, OrderStatus.REFUNDED] }, // 1
        beneficiaryId: userId, // 2
        vestedAt: { lte: new Date() }, // 3
        NOT: { dispute: { is: { status: DisputeStatus.OPEN } } }, // 4
        withdrawalId: null, // 5
      },
      select: WITHDRAWABLE_SELECT,
      orderBy: { vestedAt: 'asc' },
    });
  }

  async getBalance(userId: string) {
    const now = new Date();

    const available = await this.getWithdrawableOrders(userId);

    const [vesting, disputed, withdrawing, withdrawn] = await Promise.all([
      this.prisma.order.findMany({
        where: {
          status: OrderStatus.PAID,
          beneficiaryId: userId,
          vestedAt: { gt: now },
          NOT: { dispute: { is: { status: DisputeStatus.OPEN } } },
        },
        select: WITHDRAWABLE_SELECT,
        orderBy: { vestedAt: 'asc' },
      }),
      this.prisma.order.findMany({
        where: {
          beneficiaryId: userId,
          dispute: { is: { status: DisputeStatus.OPEN } },
        },
        select: WITHDRAWABLE_SELECT,
      }),
      this.prisma.order.findMany({
        where: {
          beneficiaryId: userId,
          withdrawal: {
            is: {
              status: {
                in: [WithdrawalStatus.PENDING, WithdrawalStatus.PROCESSING],
              },
            },
          },
        },
        select: WITHDRAWABLE_SELECT,
      }),
      this.prisma.order.findMany({
        where: {
          beneficiaryId: userId,
          withdrawal: { is: { status: WithdrawalStatus.COMPLETED } },
        },
        select: WITHDRAWABLE_SELECT,
      }),
    ]);

    const total = (orders: WithdrawableOrder[]) =>
      toFixed2(sum(orders.map((o) => o.sellerAmountUsd)));

    return {
      available: total(available),
      vesting: total(vesting),
      disputed: total(disputed),
      withdrawing: total(withdrawing),
      withdrawn: total(withdrawn),
      nextVestingAt: vesting[0]?.vestedAt ?? null,
    };
  }

  /**
   * Per-order breakdown for the FE table. The `available` set comes straight from
   * getWithdrawableOrders — only the labelling of the rest happens here.
   */
  async getOrdersBreakdown(userId: string) {
    const now = new Date();
    const availableIds = new Set(
      (await this.getWithdrawableOrders(userId)).map((o) => o.id),
    );

    const orders = await this.prisma.order.findMany({
      where: {
        beneficiaryId: userId,
        status: {
          in: [OrderStatus.PAID, OrderStatus.REFUNDED, OrderStatus.DISPUTED],
        },
      },
      select: {
        ...WITHDRAWABLE_SELECT,
        dispute: { select: { status: true } },
        withdrawal: { select: { id: true, status: true } },
      },
      orderBy: { vestedAt: 'asc' },
    });

    return orders.map((o) => {
      let bucket: string;
      if (availableIds.has(o.id)) bucket = 'available';
      else if (o.dispute?.status === DisputeStatus.OPEN) bucket = 'disputed';
      else if (o.withdrawal?.status === WithdrawalStatus.COMPLETED)
        bucket = 'withdrawn';
      else if (
        o.withdrawal?.status === WithdrawalStatus.PENDING ||
        o.withdrawal?.status === WithdrawalStatus.PROCESSING
      ) {
        bucket = 'withdrawing';
      } else if (o.vestedAt && o.vestedAt > now) bucket = 'vesting';
      else bucket = 'unavailable';

      return {
        orderId: o.id,
        title: o.titleSnapshot,
        amount: toFixed2(o.sellerAmountUsd),
        status: o.status,
        vestedAt: o.vestedAt,
        bucket,
        disputeStatus: o.dispute?.status ?? null,
        withdrawalId: o.withdrawal?.id ?? null,
      };
    });
  }

  async listWithdrawals(userId: string) {
    const withdrawals = await this.prisma.withdrawal.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
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
        _count: { select: { orders: true } },
      },
    });

    return withdrawals.map(({ _count, ...w }) => ({
      ...w,
      amountUsd: toFixed2(w.amountUsd),
      orderCount: _count.orders,
    }));
  }

  async createWithdrawal(userId: string, dto: CreateWithdrawalDto) {
    const currency = dto.currency ?? 'USDT';

    // 1. Load withdrawable orders — same single source of truth as getBalance().
    const orders = await this.getWithdrawableOrders(userId);
    if (orders.length === 0) {
      throw new BadRequestException('You have no funds available to withdraw');
    }

    const totalDecimal = sum(orders.map((o) => o.sellerAmountUsd));
    const minimum = this.config.get<number>('minWithdrawalUsd') ?? 1;
    if (totalDecimal.lessThan(minimum)) {
      throw new BadRequestException(
        `Minimum withdrawal is $${minimum.toFixed(2)} — you have $${totalDecimal.toFixed(2)} available`,
      );
    }

    const ids = orders.map((o) => o.id);

    // 2 + 3. Create the withdrawal and reserve the orders atomically.
    const withdrawal = await this.prisma.$transaction(async (tx) => {
      const w = await tx.withdrawal.create({
        data: {
          userId,
          amountUsd: totalDecimal,
          currency,
          network: dto.network,
          address: dto.address,
          status: WithdrawalStatus.PENDING,
        },
      });

      // withdrawalId: null in the where clause is the double-spend guard — a racing
      // request reserves nothing and the count check rolls this transaction back.
      const reserved = await tx.order.updateMany({
        where: { id: { in: ids }, beneficiaryId: userId, withdrawalId: null },
        data: { withdrawalId: w.id },
      });

      if (reserved.count !== ids.length) {
        throw new BadRequestException(
          'Those funds were just reserved by another withdrawal. Please refresh and try again.',
        );
      }

      return w;
    });

    // 4. Call OxaPay only after the reservation is committed.
    try {
      const payout = await this.oxapay.createPayout({
        withdrawalId: withdrawal.id,
        address: dto.address,
        amountUsd: totalDecimal.toFixed(2),
        currency,
        network: dto.network,
      });

      // 5a. Success → PROCESSING.
      const updated = await this.prisma.withdrawal.update({
        where: { id: withdrawal.id },
        data: {
          status: WithdrawalStatus.PROCESSING,
          oxapayTrackId: payout.track_id,
        },
      });

      this.logger.log(
        `Withdrawal ${withdrawal.id} PROCESSING — $${totalDecimal.toFixed(2)} to ${dto.address} (${ids.length} orders)`,
      );

      return {
        ...updated,
        amountUsd: toFixed2(updated.amountUsd),
        orderCount: ids.length,
        orderIds: ids,
      };
    } catch (e) {
      // 5b. Failure → FAILED and unlink, so the funds return to available.
      this.logger.error(
        `Payout failed for withdrawal ${withdrawal.id}: ${e?.message}`,
      );

      await this.prisma.$transaction([
        this.prisma.order.updateMany({
          where: { withdrawalId: withdrawal.id },
          data: { withdrawalId: null },
        }),
        this.prisma.withdrawal.update({
          where: { id: withdrawal.id },
          data: {
            status: WithdrawalStatus.FAILED,
            error: String(e?.message ?? e).slice(0, 500),
          },
        }),
      ]);

      throw new BadRequestException(
        'The payout could not be sent. Your funds are still available — please try again.',
      );
    }
  }
}
