import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { DisputeStatus } from '@prisma/client';
import { PaginationDto } from '../../../common/dto/pagination.dto';

export class QueryDisputesDto extends PaginationDto {
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
