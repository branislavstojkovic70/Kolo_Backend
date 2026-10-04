import { OmitType, PartialType } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { ListingStatus } from '@prisma/client';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { CreateListingDto } from './create-listing.dto';

// productId is immutable — a listing can never switch catalog product.
export class UpdateListingDto extends PartialType(
  OmitType(CreateListingDto, ['productId'] as const),
) {
  // SOLD / SOLD_OUT / DELETED are lifecycle states the system owns — a seller
  // can only ever ask for ACTIVE or PAUSED here.
  @ApiPropertyOptional({ enum: [ListingStatus.ACTIVE, ListingStatus.PAUSED] })
  @IsOptional()
  @IsIn([ListingStatus.ACTIVE, ListingStatus.PAUSED])
  status?: ListingStatus;
}
