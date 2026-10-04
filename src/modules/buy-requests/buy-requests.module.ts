import { forwardRef, Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { AutoBuyService } from './auto-buy.service';
import { BuyRequestsController } from './buy-requests.controller';
import { BuyRequestsService } from './buy-requests.service';

// forwardRef: Payments → BuyRequests (webhook hook) → Orders → Payments is a cycle.
@Module({
  imports: [forwardRef(() => OrdersModule)],
  controllers: [BuyRequestsController],
  providers: [AutoBuyService, BuyRequestsService],
  exports: [AutoBuyService, BuyRequestsService],
})
export class BuyRequestsModule {}
