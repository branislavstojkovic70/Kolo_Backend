import { forwardRef, Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

// forwardRef: Payments → BuyRequests → Orders → Payments is a cycle.
@Module({
  imports: [forwardRef(() => PaymentsModule)],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
