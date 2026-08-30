import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto';

export class QueryListingsDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Case-insensitive match on title' })
  @IsOptional()
  @IsString()
  @MaxLength(140)
  search?: string;

  @ApiPropertyOptional({ example: 'Streaming' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  category?: string;
}
