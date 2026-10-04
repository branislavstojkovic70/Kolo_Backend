import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import * as EX from '../../common/swagger/examples';

/**
 * The platform rules the frontend has to display: fee percentage, vesting
 * length, dispute window, minimum payout. They live in env vars, so the FE must
 * read them from here instead of hardcoding a copy that silently goes stale.
 */
@ApiTags('config')
@Controller('config')
export class ConfigController {
  constructor(private readonly config: ConfigService) {}

  @Public()
  @Get()
  @ApiOperation({
    summary: 'Platform rules the UI needs (public)',
    description:
      'Everything here is derived from the backend env. Fee and vesting are applied ' +
      'per order at purchase/payment time — these values describe what a **new** order ' +
      'would get, and never re-describe existing ones.',
  })
  @ApiOkResponse({
    description: 'Platform configuration',
    schema: { example: EX.PLATFORM_CONFIG },
  })
  platform() {
    return {
      feePercent: this.config.get<number>('platformFeePercent'),
      vestingDays: this.config.get<number>('vestingDays'),
      disputeWindowDays: this.config.get<number>('disputeWindowDays'),
      minWithdrawalUsd: Number(
        this.config.get<number>('minWithdrawalUsd'),
      ).toFixed(2),
      // how long an auto-buy match holds the listing while the buyer pays
      autoBuyReservationMinutes: this.config.get<number>(
        'autoBuy.reservationMinutes',
      ),
      payoutCurrencies: ['USDT', 'USDC', 'TRX', 'TON', 'BTC', 'ETH'],
      payoutNetworks: ['TRC20', 'BEP20', 'ERC20', 'TON', 'POLYGON'],
    };
  }
}
