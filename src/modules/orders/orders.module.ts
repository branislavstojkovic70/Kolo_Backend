import { forwardRef, Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { PaymentsModule } from '../payments/payments.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

// forwardRef: Payments → BuyRequests → Orders → Payments is a cycle.
@Module({
  imports: [forwardRef(() => PaymentsModule), InventoryModule],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
