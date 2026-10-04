import { Module } from '@nestjs/common';
import { ListingInventoryService } from './listing-inventory.service';

// Depends on nothing but the global PrismaModule + config, so listings, orders,
// buy-requests and payments can all import it without any circular references.
@Module({
  providers: [ListingInventoryService],
  exports: [ListingInventoryService],
})
export class InventoryModule {}
