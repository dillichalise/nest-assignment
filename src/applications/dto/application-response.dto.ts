import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { maskEmail, maskPhone, maskTaxId } from '../../common/security/mask';
import { ApplicationStatus } from '../enums/application-status.enum';
import { RiskStatus } from '../enums/risk-status.enum';
import { MerchantApplication } from '../merchant-application.entity';

export interface ResponseOptions {
  /** Unmasked owner email, phone and tax id (ADMIN, detail view only). */
  revealSensitive?: boolean;
  /** `riskResult` (ADMIN and REVIEWER, detail view only). */
  includeRiskDetails?: boolean;
}

export class ApplicationResponseDto {
  @ApiProperty({
    format: 'uuid',
    example: '3b1f6c0e-8a2d-4f6e-9a47-2d3c5e7f9a10',
  })
  id!: string;
  @ApiProperty({ example: 'Blue Door Cafe' }) businessName!: string;
  @ApiProperty({ example: 'Blue Door Hospitality' })
  legalBusinessName!: string;
  @ApiProperty({ example: 'restaurant' }) businessType!: string;
  @ApiProperty({ example: 'Pat Owner' }) ownerName!: string;
  @ApiProperty({
    example: 'p**@example.com',
    description:
      'Masked, unless the caller is an ADMIN reading a single application.',
  })
  ownerEmail!: string;
  @ApiProperty({
    example: '+*** ******3210',
    description:
      'Masked, unless the caller is an ADMIN reading a single application.',
  })
  ownerPhone!: string;
  @ApiProperty({
    example: '*******-789',
    description:
      'Masked (last 4 characters), unless the caller is an ADMIN reading a single application. Encrypted at rest.',
  })
  ownerTaxId!: string;
  @ApiProperty({ type: String, example: '25000.00' }) monthlyVolume!: string;
  @ApiProperty({ type: String, example: '42.50' }) averageTicketSize!: string;
  @ApiProperty({ example: 'USD' }) currency!: string;
  @ApiProperty({
    enum: ApplicationStatus,
    example: ApplicationStatus.SUBMITTED,
  })
  status!: ApplicationStatus;
  @ApiProperty({ enum: RiskStatus, example: RiskStatus.COMPLETED })
  riskStatus!: RiskStatus;
  @ApiProperty({
    type: Number,
    nullable: true,
    minimum: 0,
    maximum: 99,
    example: 42,
    description: '0 (safest) to 99; null until the risk review completes.',
  })
  riskScore!: number | null;
  @ApiPropertyOptional({
    type: Object,
    nullable: true,
    description:
      'Provider detail (level, flags, reference) or the failure code. Only returned to ADMIN and REVIEWER, on the single-application detail view.',
  })
  riskResult?: Record<string, unknown> | null;
  @ApiProperty({
    format: 'uuid',
    description: 'The user who created the application.',
  })
  createdById!: string;
  @ApiProperty({ format: 'uuid', nullable: true }) assignedReviewerId!:
    string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Business could not be verified.',
  })
  decisionReason!: string | null;
  @ApiProperty({
    type: Date,
    nullable: true,
    example: '2026-01-02T10:15:00.000Z',
  })
  decidedAt!: Date | null;
  @ApiProperty({
    type: Date,
    nullable: true,
    example: '2026-01-02T09:00:00.000Z',
  })
  submittedAt!: Date | null;
  @ApiProperty({ example: '2026-01-02T08:30:00.000Z' }) createdAt!: Date;
  @ApiProperty({ example: '2026-01-02T09:00:00.000Z' }) updatedAt!: Date;

  /**
   * The single place entities become API output. Explicit field list (not a
   * spread) so new columns are never exposed by accident.
   *
   * Owner email, phone and tax id are MASKED unless `revealSensitive` is true.
   * Callers pass it only for ADMIN on the single-application detail endpoint
   * (PolicyService.canViewSensitiveOwnerData); lists and every write response
   * stay masked.
   *
   * `riskResult` (provider detail) is included only when `includeRiskDetails`
   * is true: ADMIN and REVIEWER, detail view only
   * (PolicyService.canViewRiskDetails). The sales user sees the score and
   * status, not the internals.
   */
  static from(
    a: MerchantApplication,
    {
      revealSensitive = false,
      includeRiskDetails = false,
    }: ResponseOptions = {},
  ): ApplicationResponseDto {
    const dto = new ApplicationResponseDto();
    dto.id = a.id;
    dto.businessName = a.businessName;
    dto.legalBusinessName = a.legalBusinessName;
    dto.businessType = a.businessType;
    dto.ownerName = a.ownerName;
    dto.ownerEmail = revealSensitive ? a.ownerEmail : maskEmail(a.ownerEmail);
    dto.ownerPhone = revealSensitive ? a.ownerPhone : maskPhone(a.ownerPhone);
    dto.ownerTaxId = revealSensitive ? a.ownerTaxId : maskTaxId(a.ownerTaxId);
    dto.monthlyVolume = a.monthlyVolume;
    dto.averageTicketSize = a.averageTicketSize;
    dto.currency = a.currency;
    dto.status = a.status;
    dto.riskStatus = a.riskStatus;
    dto.riskScore = a.riskScore;
    if (includeRiskDetails) {
      dto.riskResult = a.riskResult;
    }
    dto.createdById = a.createdById;
    dto.assignedReviewerId = a.assignedReviewerId;
    dto.decisionReason = a.decisionReason;
    dto.decidedAt = a.decidedAt;
    dto.submittedAt = a.submittedAt;
    dto.createdAt = a.createdAt;
    dto.updatedAt = a.updatedAt;
    return dto;
  }
}

export class PaginatedApplicationsDto {
  @ApiProperty({ type: [ApplicationResponseDto] })
  items!: ApplicationResponseDto[];

  @ApiProperty({
    example: 42,
    description: 'Total matching applications across all pages',
  })
  total!: number;

  @ApiProperty({ example: 1 }) page!: number;
  @ApiProperty({ example: 20 }) limit!: number;
}
