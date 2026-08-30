import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export type DisputeWinner = 'BUYER' | 'SELLER';

export class ResolveDisputeDto {
  @ApiProperty({ enum: ['BUYER', 'SELLER'] })
  @IsIn(['BUYER', 'SELLER'])
  winner: DisputeWinner;

  @ApiPropertyOptional({
    description: 'Shown to both parties and posted to the Telegram group',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
