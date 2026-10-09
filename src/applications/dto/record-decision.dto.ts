import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsNotEmpty,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { Trim } from '../../common/decorators/trim.decorator';

/** The outcomes a reviewer may choose; a subset of ApplicationStatus. */
export enum ReviewDecision {
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  INFO_REQUESTED = 'INFO_REQUESTED',
}

export class RecordDecisionDto {
  @ApiProperty({ enum: ReviewDecision })
  @IsEnum(ReviewDecision)
  decision!: ReviewDecision;

  @ApiPropertyOptional({
    maxLength: 2000,
    description:
      'Required for REJECTED and INFO_REQUESTED; optional for APPROVED.',
  })
  @Trim()
  // Skipped only for an APPROVED decision that carries no reason.
  @ValidateIf(
    (o: RecordDecisionDto) =>
      o.decision !== ReviewDecision.APPROVED || o.reason !== undefined,
  )
  @IsString()
  @IsNotEmpty({ message: 'reason is required for REJECTED and INFO_REQUESTED' })
  @MaxLength(2000)
  reason?: string;
}
