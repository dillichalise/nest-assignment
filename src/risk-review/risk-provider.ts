export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

/**
 * What the provider is told about an application. Data minimization: only
 * business facts needed for a risk call, never owner contact details or the
 * tax id.
 */
export interface RiskAssessmentInput {
  applicationId: string;
  /** Stable per risk-review request. A real provider would dedupe on it, so a repeated call is safe. */
  idempotencyKey: string;
  businessType: string;
  monthlyVolume: string;
  averageTicketSize: string;
  currency: string;
}

export interface RiskAssessment {
  /** 0 (safest) to 99. */
  score: number;
  level: RiskLevel;
  flags: string[];
  provider: string;
  reference: string;
}

/** `retryable: false` means retrying cannot help (e.g. the provider rejected the input). */
export class RiskProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable = true,
  ) {
    super(message);
    this.name = 'RiskProviderError';
  }
}

/** The seam to the third-party risk/KYB service. */
export abstract class RiskProviderClient {
  abstract assess(input: RiskAssessmentInput): Promise<RiskAssessment>;
}
