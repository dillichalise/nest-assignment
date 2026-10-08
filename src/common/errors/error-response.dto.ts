import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ErrorResponseDto {
  @ApiProperty({ example: 400 })
  statusCode!: number;

  @ApiProperty({ example: 'Bad Request' })
  error!: string;

  @ApiProperty({ example: 'Validation failed' })
  message!: string;

  @ApiPropertyOptional({
    description: 'Extra context, e.g. per-field validation errors',
    example: [{ field: 'email', errors: ['email must be an email'] }],
  })
  details?: unknown;

  @ApiProperty({ example: '3f1c0e7e-6d0b-4a53-9a4b-2f2a9d8c1b11' })
  requestId!: string;

  @ApiProperty({ example: '2026-01-01T00:00:00.000Z' })
  timestamp!: string;

  @ApiProperty({ example: '/applications' })
  path!: string;
}
