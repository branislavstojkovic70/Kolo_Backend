import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class CreateDisputeDto {
  @ApiProperty({ example: 'The account stopped working after three days.' })
  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  reason: string;
}
