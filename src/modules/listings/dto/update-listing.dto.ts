import { OmitType, PartialType } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { ListingStatus } from '@prisma/client';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { CreateListingDto } from './create-listing.dto';

// productId is immutable — a listing can never switch catalog product.
export class UpdateListingDto extends PartialType(
  OmitType(CreateListingDto, ['productId'] as const),
) {
  @ApiPropertyOptional({ enum: [ListingStatus.ACTIVE, ListingStatus.PAUSED] })
  @IsOptional()
  @IsEnum(ListingStatus)
  status?: ListingStatus;
}
