import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class UpdateMeDto {
  @ApiPropertyOptional({ example: 'alice' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(40)
  username?: string;

  @ApiPropertyOptional({
    example: 'alice_sells',
    description: 'without the leading @',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  @Matches(/^@?[A-Za-z0-9_]{4,}$/, {
    message: 'telegramUsername must be a valid Telegram handle',
  })
  telegramUsername?: string;
}
