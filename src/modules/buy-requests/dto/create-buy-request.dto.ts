import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDate,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MinLength,
} from 'class-validator';

export class CreateBuyRequestDto {
  @ApiProperty({
    example: 'cmf3prod0001q1x8youtube12',
    description: 'Id of an active catalog product (GET /api/products)',
  })
  @IsString()
  @MinLength(1)
  productId: string;

  @ApiProperty({
    example: 20,
    description:
      'Buy automatically when a listing for this product appears at or below this USD price',
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(1000000)
  maxPriceUsd: number;

  @ApiPropertyOptional({
    example: '2026-11-01T00:00:00.000Z',
    description: 'Optional — the wish lapses on its own after this moment',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  expiresAt?: Date;
}
