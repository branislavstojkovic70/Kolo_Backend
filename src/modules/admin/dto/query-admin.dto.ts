import { ApiPropertyOptional } from '@nestjs/swagger';
import { DisputeStatus, OrderStatus, WithdrawalStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto';

export class QueryAdminDisputesDto extends PaginationDto {
  @ApiPropertyOptional({
    description: "Case-insensitive match on the disputed order's title",
    example: 'adobe',
  })
  @IsOptional()
  @IsString()
  @MaxLength(140)
  search?: string;

  @ApiPropertyOptional({ enum: DisputeStatus })
  @IsOptional()
  @IsEnum(DisputeStatus)
  status?: DisputeStatus;
}

export class QueryAdminOrdersDto extends PaginationDto {
  @ApiPropertyOptional({ enum: OrderStatus })
  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;
}

export class QueryAdminWithdrawalsDto extends PaginationDto {
  @ApiPropertyOptional({ enum: WithdrawalStatus })
  @IsOptional()
  @IsEnum(WithdrawalStatus)
  status?: WithdrawalStatus;
}
