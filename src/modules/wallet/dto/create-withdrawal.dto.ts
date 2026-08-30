import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateWithdrawalDto {
  @ApiProperty({
    example: 'TXYZabc123...',
    description: 'Destination crypto wallet address',
  })
  @IsString()
  @MinLength(10)
  @MaxLength(200)
  address: string;

  @ApiProperty({ example: 'TRC20' })
  @IsString()
  @MinLength(2)
  @MaxLength(20)
  network: string;

  @ApiPropertyOptional({ default: 'USDT' })
  @IsOptional()
  @IsString()
  @IsIn(['USDT', 'USDC', 'TRX', 'TON', 'BTC', 'ETH'])
  currency?: string;
}
