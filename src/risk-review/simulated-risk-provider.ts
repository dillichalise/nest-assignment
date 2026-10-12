import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import {
  RiskAssessment,
  RiskAssessmentInput,
  RiskLevel,
  RiskProviderClient,
  RiskProviderError,
} from './risk-provider';

const HIGH_VOLUME = 100_000;
const HIGH_TICKET = 5_000;
const FLAG_PENALTY = 10;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Stand-in for a third-party risk/KYB provider.
 *
 * The RESULT is deterministic for a given input, so re-running a job gives the
 * same score and the same persisted state. Only the demo knobs are not:
 *   RISK_SIM_LATENCY_MS    artificial delay per call (default 300)
 *   RISK_SIM_FAILURE_RATE  0..1 chance of a transient failure (default 0)
 */
@Injectable()
export class SimulatedRiskProvider extends RiskProviderClient {
  private readonly latencyMs: number;
  private readonly failureRate: number;

  constructor(config: ConfigService) {
    super();
    const latency = Number(config.get('RISK_SIM_LATENCY_MS', 300));
    const rate = Number(config.get('RISK_SIM_FAILURE_RATE', 0));
    this.latencyMs = Number.isFinite(latency) && latency > 0 ? latency : 0;
    this.failureRate = Number.isFinite(rate)
      ? Math.min(Math.max(rate, 0), 1)
      : 0;
  }

  async assess(input: RiskAssessmentInput): Promise<RiskAssessment> {
    if (this.latencyMs > 0) {
      await sleep(this.latencyMs);
    }
    if (this.failureRate > 0 && Math.random() < this.failureRate) {
      throw new RiskProviderError(
        'Simulated provider outage',
        'PROVIDER_UNAVAILABLE',
        true,
      );
    }

    const digest = createHash('sha256')
      .update(
        [
          input.applicationId,
          input.businessType,
          input.monthlyVolume,
          input.averageTicketSize,
          input.currency,
        ].join('|'),
      )
      .digest();

    const flags: string[] = [];
    if (Number(input.monthlyVolume) >= HIGH_VOLUME) flags.push('HIGH_VOLUME');
    if (Number(input.averageTicketSize) >= HIGH_TICKET)
      flags.push('HIGH_TICKET');

    const score = Math.min(
      (digest.readUInt32BE(0) % 100) + flags.length * FLAG_PENALTY,
      99,
    );
    const level: RiskLevel =
      score < 34 ? 'LOW' : score < 67 ? 'MEDIUM' : 'HIGH';

    return {
      score,
      level,
      flags,
      provider: 'simulated-kyb',
      reference: `SIM-${digest.toString('hex').slice(0, 12)}`,
    };
  }
}
