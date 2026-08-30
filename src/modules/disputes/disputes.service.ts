import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DisputeStatus, OrderStatus, Prisma, Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { toFixed2 } from '../../common/money';
import { TelegramService } from '../telegram/telegram.service';
import { CreateDisputeDto } from './dto/create-dispute.dto';

const DISPUTE_SELECT = {
  id: true,
  orderId: true,
  openedById: true,
  reason: true,
  status: true,
  telegramChatId: true,
  telegramInviteLink: true,
  resolvedById: true,
  resolutionNote: true,
  resolvedAt: true,
  createdAt: true,
  updatedAt: true,
  order: {
    select: {
      id: true,
      titleSnapshot: true,
      amountUsd: true,
      sellerAmountUsd: true,
      status: true,
      buyerId: true,
      sellerId: true,
      paidAt: true,
      vestedAt: true,
    },
  },
} satisfies Prisma.DisputeSelect;

type SelectedDispute = Prisma.DisputeGetPayload<{
  select: typeof DISPUTE_SELECT;
}>;

@Injectable()
export class DisputesService {
  private readonly logger = new Logger(DisputesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly telegram: TelegramService,
  ) {}

  private map(d: SelectedDispute) {
    return {
      ...d,
      order: {
        ...d.order,
        amountUsd: toFixed2(d.order.amountUsd),
        sellerAmountUsd: toFixed2(d.order.sellerAmountUsd),
      },
    };
  }

  async create(orderId: string, userId: string, dto: CreateDisputeDto) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        dispute: { select: { id: true } },
        buyer: { select: { email: true } },
        seller: { select: { email: true } },
      },
    });

    if (!order) throw new NotFoundException('Order not found');

    // Only the buyer, checked before anything else.
    if (order.buyerId !== userId) {
      throw new ForbiddenException(
        'Only the buyer can open a dispute on this order',
      );
    }

    // Checked before the PAID check: opening a dispute flips the order to DISPUTED,
    // so a second attempt would otherwise report "not PAID" instead of the real reason.
    if (order.dispute) {
      throw new ConflictException('A dispute is already open for this order');
    }

    if (order.status !== OrderStatus.PAID) {
      throw new BadRequestException(
        `You can only dispute a paid order (this one is ${order.status})`,
      );
    }

    const windowDays = this.config.get<number>('disputeWindowDays') ?? 30;
    const paidAt = order.paidAt ?? order.createdAt;
    const deadline = new Date(
      paidAt.getTime() + windowDays * 24 * 60 * 60 * 1000,
    );
    if (new Date() > deadline) {
      throw new BadRequestException(
        `The ${windowDays}-day dispute window for this order closed on ${deadline.toISOString().slice(0, 10)}`,
      );
    }

    // One transaction: dispute row + order status.
    const dispute = await this.prisma.$transaction(async (tx) => {
      const d = await tx.dispute.create({
        data: {
          orderId: order.id,
          openedById: userId,
          reason: dto.reason,
          status: DisputeStatus.OPEN,
        },
      });

      await tx.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.DISPUTED },
      });

      return d;
    });

    this.logger.log(
      `Dispute ${dispute.id} opened on order ${order.id} — withdrawal now blocked`,
    );

    // Telegram runs OUTSIDE the transaction and can never fail the dispute.
    let telegramInviteLink: string | null = null;
    try {
      const group = await this.telegram.createDisputeGroup({
        disputeId: dispute.id,
        orderId: order.id,
        listingTitle: order.titleSnapshot,
        amountUsd: toFixed2(order.amountUsd),
        buyerEmail: order.buyer.email,
        sellerEmail: order.seller.email,
        reason: dto.reason,
      });

      await this.prisma.dispute.update({
        where: { id: dispute.id },
        data: {
          telegramChatId: group.chatId,
          telegramInviteLink: group.inviteLink,
        },
      });
      telegramInviteLink = group.inviteLink;
    } catch (e) {
      this.logger.error(
        `Telegram group creation failed for dispute ${dispute.id}: ${e?.message} — ` +
          `chat fields left null, use the admin telegram-retry endpoint`,
      );
    }

    const full = await this.prisma.dispute.findUniqueOrThrow({
      where: { id: dispute.id },
      select: DISPUTE_SELECT,
    });

    return { dispute: this.map(full), telegramInviteLink };
  }

  async findMine(userId: string) {
    const disputes = await this.prisma.dispute.findMany({
      where: {
        order: { is: { OR: [{ buyerId: userId }, { sellerId: userId }] } },
      },
      select: DISPUTE_SELECT,
      orderBy: { createdAt: 'desc' },
    });
    return disputes.map((d) => this.map(d));
  }

  /** Buyer, seller and admin all get the invite link so the FE can show "Join dispute chat". */
  async findOne(id: string, userId: string, role: Role) {
    const dispute = await this.prisma.dispute.findUnique({
      where: { id },
      select: DISPUTE_SELECT,
    });
    if (!dispute) throw new NotFoundException('Dispute not found');

    const isParty =
      dispute.order.buyerId === userId || dispute.order.sellerId === userId;
    if (!isParty && role !== Role.ADMIN) {
      throw new ForbiddenException('You do not have access to this dispute');
    }

    return this.map(dispute);
  }

  /** Admin-only re-run of group creation for a dispute whose Telegram fields are null. */
  async retryTelegram(id: string) {
    const dispute = await this.prisma.dispute.findUnique({
      where: { id },
      include: {
        order: {
          include: {
            buyer: { select: { email: true } },
            seller: { select: { email: true } },
          },
        },
      },
    });
    if (!dispute) throw new NotFoundException('Dispute not found');

    if (dispute.telegramInviteLink) {
      throw new BadRequestException(
        'This dispute already has a Telegram group',
      );
    }

    const group = await this.telegram.createDisputeGroup({
      disputeId: dispute.id,
      orderId: dispute.orderId,
      listingTitle: dispute.order.titleSnapshot,
      amountUsd: toFixed2(dispute.order.amountUsd),
      buyerEmail: dispute.order.buyer.email,
      sellerEmail: dispute.order.seller.email,
      reason: dispute.reason,
    });

    const updated = await this.prisma.dispute.update({
      where: { id: dispute.id },
      data: {
        telegramChatId: group.chatId,
        telegramInviteLink: group.inviteLink,
      },
      select: DISPUTE_SELECT,
    });

    this.logger.log(
      `Telegram group re-created for dispute ${id}: ${group.chatId}`,
    );
    return this.map(updated);
  }
}
