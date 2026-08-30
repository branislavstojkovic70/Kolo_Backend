import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';

@Module({
  imports: [PaymentsModule],
  controllers: [WalletController],
  providers: [WalletService],
})
export class WalletModule {}
