import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { User } from '@prisma/client';
import { ApiAuth } from '../../common/decorators/api-auth.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ErrorResponseDto } from '../../common/dto/error-response.dto';
import { AdminGuard } from '../../common/guards/admin.guard';
import * as EX from '../../common/swagger/examples';
import { DisputesService } from '../disputes/disputes.service';
import { AdminService } from './admin.service';
import {
  QueryAdminDisputesDto,
  QueryAdminOrdersDto,
  QueryAdminWithdrawalsDto,
} from './dto/query-admin.dto';
import { ResolveDisputeDto } from './dto/resolve-dispute.dto';

@ApiTags('admin')
@ApiAuth()
@ApiForbiddenResponse({
  description: 'Caller is not an ADMIN',
  type: ErrorResponseDto,
})
@UseGuards(AdminGuard)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly disputes: DisputesService,
  ) {}

  @Get('disputes')
  @ApiOperation({
    summary: 'All disputes',
    description:
      "Newest first, paginated, with the full order and both parties' e-mails in one query. " +
      'Filter the queue with `?status=OPEN`.',
  })
  @ApiOkResponse({
    description: 'Paginated disputes',
    schema: { example: EX.ADMIN_DISPUTE_PAGE },
  })
  listDisputes(@Query() q: QueryAdminDisputesDto) {
    return this.admin.listDisputes(q);
  }

  @Post('disputes/:id/resolve')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Decide a dispute',
    description: [
      '**SELLER wins** → dispute `RESOLVED_SELLER`, order back to `PAID`. The beneficiary and',
      '`vestedAt` are left untouched: if vesting has not passed yet, the seller waits it out.',
      '',
      '**BUYER wins** → dispute `RESOLVED_BUYER`, order `REFUNDED`, `beneficiaryId` becomes the',
      'buyer and `vestedAt` is set to now, so the buyer can withdraw immediately. There is no',
      'OxaPay refund call — the buyer withdraws from our balance exactly like a seller does.',
      '',
      'No money moves here. The next `/wallet/balance` call picks the order up by beneficiary.',
      'Resolving an already-resolved dispute returns `409`.',
    ].join('\n'),
  })
  @ApiParam({ name: 'id', example: 'dsp_open_1' })
  @ApiOkResponse({
    description: 'The resolved dispute and the updated order',
    schema: { example: EX.DISPUTE_RESOLVED },
  })
  @ApiConflictResponse({
    description: 'Already resolved',
    type: ErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'No such dispute',
    type: ErrorResponseDto,
  })
  resolve(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: ResolveDisputeDto,
  ) {
    return this.admin.resolveDispute(id, user.id, dto);
  }

  @Post('disputes/:id/telegram-retry')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Re-run Telegram group creation',
    description:
      'For a dispute whose Telegram fields are null because the group creation failed (or ' +
      'because Telegram was not configured at the time). Returns `400` if a group already exists.',
  })
  @ApiParam({ name: 'id', example: 'dsp_open_1' })
  @ApiOkResponse({
    description: 'Group created',
    schema: { example: EX.DISPUTE },
  })
  @ApiBadRequestResponse({
    description: 'Already has a group',
    type: ErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'No such dispute',
    type: ErrorResponseDto,
  })
  telegramRetry(@Param('id') id: string) {
    return this.disputes.retryTelegram(id);
  }

  @Get('orders')
  @ApiOperation({
    summary: 'All orders',
    description: 'Newest first, paginated. Filter with `?status=PAID`.',
  })
  @ApiOkResponse({
    description: 'Paginated orders',
    schema: { example: EX.ADMIN_ORDER_PAGE },
  })
  listOrders(@Query() q: QueryAdminOrdersDto) {
    return this.admin.listOrders(q);
  }

  @Get('withdrawals')
  @ApiOperation({
    summary: 'All withdrawals',
    description:
      'Newest first, paginated. Filter with `?status=FAILED` to find stuck payouts.',
  })
  @ApiOkResponse({
    description: 'Paginated withdrawals',
    schema: { example: EX.ADMIN_WITHDRAWAL_PAGE },
  })
  listWithdrawals(@Query() q: QueryAdminWithdrawalsDto) {
    return this.admin.listWithdrawals(q);
  }

  @Get('stats')
  @ApiOperation({
    summary: 'Platform totals for the dashboard',
    description:
      'Counts plus money: `grossVolumeUsd` is everything buyers actually paid, ' +
      '`platformFeesUsd` our cut of it, `inEscrowUsd` seller-side money still sitting on our ' +
      'OxaPay account, `paidOutUsd` the sum of completed payouts. Every enum key is present ' +
      'even at zero, so the FE table never has holes.',
  })
  @ApiOkResponse({
    description: 'Platform stats',
    schema: { example: EX.ADMIN_STATS },
  })
  stats() {
    return this.admin.getStats();
  }
}
