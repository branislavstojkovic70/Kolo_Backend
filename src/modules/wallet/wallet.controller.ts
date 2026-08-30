import { Body, Controller, Get, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { User } from '@prisma/client';
import { ApiAuth } from '../../common/decorators/api-auth.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ErrorResponseDto } from '../../common/dto/error-response.dto';
import * as EX from '../../common/swagger/examples';
import { CreateWithdrawalDto } from './dto/create-withdrawal.dto';
import { WalletService } from './wallet.service';

@ApiTags('wallet')
@ApiAuth()
@Controller('wallet')
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  @Get('balance')
  @ApiOperation({
    summary: 'Balance buckets',
    description: [
      'Every amount is a 2-decimal USD string. A user has no wallet row — the balance is',
      'always derived from their orders.',
      '',
      '- **available** — `PAID`/`REFUNDED`, I am the beneficiary, `vestedAt` has passed,',
      '  no `OPEN` dispute, not already linked to a withdrawal. This is the only bucket',
      '  `POST /wallet/withdraw` can pay out.',
      '- **vesting** — `PAID` and mine, but `vestedAt` is still in the future.',
      '- **disputed** — mine, with an `OPEN` dispute. Frozen even if vesting has passed.',
      '- **withdrawing** — linked to a `PENDING`/`PROCESSING` withdrawal.',
      '- **withdrawn** — linked to a `COMPLETED` withdrawal.',
      '',
      '`nextVestingAt` is the ISO-8601 date the next vesting order unlocks, or `null`.',
      'Vesting is per order and frozen at payment time: two orders of the same seller',
      'routinely unlock on different days.',
    ].join('\n'),
  })
  @ApiOkResponse({
    description: 'The five buckets',
    schema: { example: EX.BALANCE },
  })
  balance(@CurrentUser() user: User) {
    return this.wallet.getBalance(user.id);
  }

  @Get('orders')
  @ApiOperation({
    summary: 'Per-order breakdown for the wallet table',
    description:
      'One row per order I am the beneficiary of, with the bucket it falls into — the ' +
      'itemised version of `GET /wallet/balance`. Sorted by vesting date.',
  })
  @ApiOkResponse({
    description: 'Order rows',
    schema: { example: EX.WALLET_ORDERS },
  })
  orders(@CurrentUser() user: User) {
    return this.wallet.getOrdersBreakdown(user.id);
  }

  @Post('withdraw')
  @ApiOperation({
    summary: 'Withdraw the whole available bucket',
    description: [
      'There is **no `amount` parameter**: this pays out the entire `available` bucket and',
      'links exactly those orders to the new withdrawal. Orders still vesting, or under an',
      'open dispute, are simply not part of the query and stay untouched for their own',
      'later withdrawal.',
      '',
      'Rejected with `400` when the available bucket is empty or below `MIN_WITHDRAWAL_USD`.',
      'On success the withdrawal is `PROCESSING`; the OxaPay payout webhook flips it to',
      '`COMPLETED`. If the payout call fails, the orders are unlinked and become available',
      'again — the money is never lost.',
    ].join('\n'),
  })
  @ApiCreatedResponse({
    description: 'Payout accepted by OxaPay',
    schema: { example: EX.WITHDRAWAL_CREATED },
  })
  @ApiBadRequestResponse({
    description:
      'Nothing available, below the minimum, or the payout was refused',
    type: ErrorResponseDto,
  })
  withdraw(@CurrentUser() user: User, @Body() dto: CreateWithdrawalDto) {
    return this.wallet.createWithdrawal(user.id, dto);
  }

  @Get('withdrawals')
  @ApiOperation({
    summary: 'My withdrawals',
    description:
      'Newest first. `orderCount` is how many orders were bundled into each payout.',
  })
  @ApiOkResponse({
    description: 'My withdrawals',
    schema: { example: [EX.WITHDRAWAL] },
  })
  withdrawals(@CurrentUser() user: User) {
    return this.wallet.listWithdrawals(user.id);
  }
}
