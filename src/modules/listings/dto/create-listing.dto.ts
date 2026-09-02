import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateListingDto {
  @ApiProperty({ example: 'YouTube Premium — 12 months' })
  @IsString()
  @MinLength(3)
  @MaxLength(140)
  title: string;

  @ApiProperty({ example: 'Invite-based upgrade of your own Google account.' })
  @IsString()
  @MinLength(10)
  @MaxLength(4000)
  description: string;

  @ApiPropertyOptional({ example: 'Streaming' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  category?: string;

  @ApiPropertyOptional({
    example: 'https://images.example.com/youtube-premium.jpg',
    description:
      'Cover image URL shown on the marketplace card and the detail page. ' +
      'We only store the link — nothing is uploaded or hosted here.',
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
    description:
      'Credentials/instructions. Shown only to the buyer after payment.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  deliveryInfo?: string;
}
