import { ApplicationStatus } from '../enums/application-status.enum';
import { RiskStatus } from '../enums/risk-status.enum';
import { MerchantApplication } from '../merchant-application.entity';
import { ApplicationResponseDto } from './application-response.dto';

const entity = {
  id: 'app1',
  businessName: 'Blue Door Cafe',
  legalBusinessName: 'Blue Door Ltd',
  businessType: 'cafe',
  ownerName: 'Cafe Owner',
  ownerEmail: 'cafe_owner@example.com',
  ownerPhone: '+977 9876543210',
  ownerTaxId: '123-456-789',
  monthlyVolume: '25000.00',
  averageTicketSize: '42.50',
  currency: 'USD',
  status: ApplicationStatus.DRAFT,
  riskStatus: RiskStatus.NOT_STARTED,
  riskScore: null,
  riskResult: { provider: 'internal-detail' },
  createdById: 'u1',
  assignedReviewerId: null,
  decisionReason: null,
  decidedAt: null,
  submittedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as MerchantApplication;

describe('ApplicationResponseDto.from', () => {
  it('masks owner email, phone and tax id by default', () => {
    const dto = ApplicationResponseDto.from(entity);
    expect(dto.ownerEmail).toBe('c*********@example.com');
    expect(dto.ownerPhone).toBe('+*** ******3210');
    expect(dto.ownerTaxId).toBe('*******-789');
  });

  it('reveals the full values only when asked to', () => {
    const dto = ApplicationResponseDto.from(entity, true);
    expect(dto.ownerEmail).toBe('cafe_owner@example.com');
    expect(dto.ownerPhone).toBe('+977 9876543210');
    expect(dto.ownerTaxId).toBe('123-456-789');
  });

  it('does not mask non-sensitive fields', () => {
    const dto = ApplicationResponseDto.from(entity);
    expect(dto.ownerName).toBe('Cafe Owner');
    expect(dto.businessName).toBe('Blue Door Cafe');
  });

  it('never serializes the raw sensitive values when masked', () => {
    const json = JSON.stringify(ApplicationResponseDto.from(entity));
    expect(json).not.toContain('cafe_owner@example.com');
    expect(json).not.toContain('9876543210');
    expect(json).not.toContain('123-456-789');
  });

  it('does not expose riskResult or any field outside the explicit list', () => {
    const dto = ApplicationResponseDto.from(entity) as unknown as Record<
      string,
      unknown
    >;
    expect(dto).not.toHaveProperty('riskResult');
  });
});
