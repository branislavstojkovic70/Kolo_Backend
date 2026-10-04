import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateListingDto {
  @ApiProperty({
    example: 'cmf3prod0001q1x8youtube12',
    description:
      'Id of a catalog product (GET /api/products). The listing title and ' +
      'category are copied from it — they are not free text anymore.',
  })
  @IsString()
  @MinLength(1)
  productId: string;

  @ApiProperty({ example: 'Invite-based upgrade of your own Google account.' })
  @IsString()
  @MinLength(10)
  @MaxLength(4000)
  description: string;

  @ApiPropertyOptional({
    example: 'https://images.example.com/youtube-premium.jpg',
    description:
      'Cover image URL shown on the marketplace card and the detail page. ' +
      'Defaults to the product image. We only store the link — nothing is ' +
      'uploaded or hosted here.',
  })
  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(2048)
  imageUrl?: string;

  @ApiProperty({ example: 24.99, description: 'USD, 2 decimals' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(1000000)
  priceUsd: number;

  @ApiPropertyOptional({
    example: 1,
    default: 1,
    description:
      'How many times this listing can be sold. Each unpaid order holds one unit ' +
      'until it is paid or its reservation lapses; the listing leaves the ' +
      'marketplace as SOLD once every unit has been paid for.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(999)
  quantity?: number;

  @ApiPropertyOptional({
    description:
      'Credentials/instructions. Shown only to the buyer after payment.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  deliveryInfo?: string;
}
