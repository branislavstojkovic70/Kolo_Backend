import { forwardRef, Module } from '@nestjs/common';
import { BuyRequestsModule } from '../buy-requests/buy-requests.module';
import { OxapayService } from './oxapay.service';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

// forwardRef: Payments → BuyRequests (webhook hook) → Orders → Payments is a cycle.
@Module({
  imports: [forwardRef(() => BuyRequestsModule)],
  controllers: [WebhooksController],
  providers: [OxapayService, WebhooksService],
  exports: [OxapayService, WebhooksService],
})
export class PaymentsModule {}
