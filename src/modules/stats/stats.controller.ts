import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { User } from '@prisma/client';
import { ApiAuth } from '../../common/decorators/api-auth.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import * as EX from '../../common/swagger/examples';
import { StatsService } from './stats.service';

@ApiTags('stats')
@Controller('stats')
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  @Get('savings')
  @ApiAuth()
  @ApiOperation({
    summary: 'My savings vs. retail',
    description:
      'What the caller saved buying here instead of paying retail, summed over their ' +
      '`PAID` and `DISPUTED` purchases. `REFUNDED` orders are excluded (the money came ' +
      'back), as are unpaid and expired invoices. Each order compares `amountUsd` with ' +
      '`retailPriceUsdSnapshot` — the catalog price frozen at purchase time, so later ' +
      'catalog changes never rewrite history.',
  })
  @ApiOkResponse({
    description: 'Savings summary + per-order breakdown',
    schema: { example: EX.SAVINGS },
  })
  savings(@CurrentUser() user: User) {
    return this.stats.savings(user.id);
  }
}
