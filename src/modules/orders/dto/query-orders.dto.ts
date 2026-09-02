import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { OrderStatus } from '@prisma/client';
import { PaginationDto } from '../../../common/dto/pagination.dto';

export enum OrderRole {
  ALL = 'all',
  BUYING = 'buying',
  SELLING = 'selling',
}

export class QueryOrdersDto extends PaginationDto {
  @ApiPropertyOptional({
    enum: OrderRole,
    default: OrderRole.ALL,
    description:
      'Which side of the trade to list. Only meaningful on `GET /orders`; the ' +
      '`/purchases` and `/sales` routes pin it themselves.',
  })
  @IsOptional()
  @IsEnum(OrderRole)
  role: OrderRole = OrderRole.ALL;

  @ApiPropertyOptional({
    description: 'Case-insensitive match on the snapshotted listing title',
    example: 'youtube',
  })
  @IsOptional()
  @IsString()
  @MaxLength(140)
  search?: string;

  @ApiPropertyOptional({ enum: OrderStatus })
  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;
}
