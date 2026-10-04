import { forwardRef, Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { OrdersModule } from '../orders/orders.module';
import { AutoBuyService } from './auto-buy.service';
import { BuyRequestsController } from './buy-requests.controller';
import { BuyRequestsService } from './buy-requests.service';

// forwardRef: Payments → BuyRequests (webhook hook) → Orders → Payments is a cycle.
@Module({
  imports: [forwardRef(() => OrdersModule), InventoryModule],
  controllers: [BuyRequestsController],
  providers: [AutoBuyService, BuyRequestsService],
  exports: [AutoBuyService, BuyRequestsService],
})
export class BuyRequestsModule {}
