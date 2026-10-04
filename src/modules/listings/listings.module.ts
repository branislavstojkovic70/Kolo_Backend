import { Module } from '@nestjs/common';
import { BuyRequestsModule } from '../buy-requests/buy-requests.module';
import { ListingsController } from './listings.controller';
import { ListingsService } from './listings.service';

@Module({
  imports: [BuyRequestsModule],
  controllers: [ListingsController],
  providers: [ListingsService],
})
export class ListingsModule {}
