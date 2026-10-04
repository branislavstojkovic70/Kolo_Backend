import { Module } from '@nestjs/common';
import { BuyRequestsModule } from '../buy-requests/buy-requests.module';
import { DisputesModule } from '../disputes/disputes.module';
import { TelegramModule } from '../telegram/telegram.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [DisputesModule, TelegramModule, BuyRequestsModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
