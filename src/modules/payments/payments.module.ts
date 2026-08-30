import { Module } from '@nestjs/common';
import { OxapayService } from './oxapay.service';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

@Module({
  controllers: [WebhooksController],
  providers: [OxapayService, WebhooksService],
  exports: [OxapayService, WebhooksService],
})
export class PaymentsModule {}
