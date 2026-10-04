import { ApiPropertyOptional } from '@nestjs/swagger';
import { BuyRequestStatus } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto';

export class QueryBuyRequestsDto extends PaginationDto {
  @ApiPropertyOptional({ enum: BuyRequestStatus })
  @IsOptional()
  @IsEnum(BuyRequestStatus)
  status?: BuyRequestStatus;
}
