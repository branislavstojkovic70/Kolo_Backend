import { ApiProperty } from '@nestjs/swagger';

/**
 * The ONE error shape. Every non-2xx response from this API — validation failures,
 * 401s, business rules, unhandled crashes — comes back exactly like this.
 * See AllExceptionsFilter.
 */
export class ErrorResponseDto {
  @ApiProperty({ example: 400, description: 'Same as the HTTP status code' })
  statusCode: number;

  @ApiProperty({
    example: 'You have no funds available to withdraw',
    description:
      'Always a single human-readable string, safe to display to the user directly. ' +
      'Multiple validation messages are joined with "; ".',
  })
  message: string;

  @ApiProperty({
    example: 'Bad Request',
    description: 'Canonical HTTP reason phrase',
  })
  error: string;
}
