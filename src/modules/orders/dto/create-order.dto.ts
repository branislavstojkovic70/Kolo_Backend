import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class CreateOrderDto {
  @ApiProperty({ example: 'seed_listing_youtube' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  listingId: string;
}
