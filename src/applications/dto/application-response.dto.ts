import { ApiProperty } from '@nestjs/swagger';
import { maskEmail, maskPhone, maskTaxId } from '../../common/security/mask';
import { ApplicationStatus } from '../enums/application-status.enum';
import { RiskStatus } from '../enums/risk-status.enum';
import { MerchantApplication } from '../merchant-application.entity';

export class ApplicationResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() businessName!: string;
  @ApiProperty() legalBusinessName!: string;
  @ApiProperty() businessType!: string;
  @ApiProperty() ownerName!: string;
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
  @ApiProperty({ enum: ApplicationStatus }) status!: ApplicationStatus;
  @ApiProperty({ enum: RiskStatus }) riskStatus!: RiskStatus;
  @ApiProperty({ type: Number, nullable: true }) riskScore!: number | null;
  @ApiProperty({ format: 'uuid' }) createdById!: string;
  @ApiProperty({ format: 'uuid', nullable: true }) assignedReviewerId!:
    string | null;
  @ApiProperty({ type: String, nullable: true }) decisionReason!: string | null;
  @ApiProperty({ type: Date, nullable: true }) decidedAt!: Date | null;
  @ApiProperty({ type: Date, nullable: true }) submittedAt!: Date | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;

  /**
   * The single place entities become API output. Explicit field list (not a
   * spread) so new columns are never exposed by accident.
   *
   * Owner email, phone and tax id are MASKED unless `revealSensitive` is true.
   * Callers pass it only for ADMIN on the single-application detail endpoint
   * (PolicyService.canViewSensitiveOwnerData); lists and every write response
   * stay masked. riskResult is left out until Pack 07 decides who may see
   * provider details.
   */
  static from(
    a: MerchantApplication,
    revealSensitive = false,
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
