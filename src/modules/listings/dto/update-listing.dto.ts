import { PartialType } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { ListingStatus } from '@prisma/client';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { CreateListingDto } from './create-listing.dto';

export class UpdateListingDto extends PartialType(CreateListingDto) {
  @ApiPropertyOptional({ enum: [ListingStatus.ACTIVE, ListingStatus.PAUSED] })
  @IsOptional()
  @IsEnum(ListingStatus)
  status?: ListingStatus;
}
