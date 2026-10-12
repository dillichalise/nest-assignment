import {
  RiskAssessment,
  RiskAssessmentInput,
  RiskProviderClient,
  RiskProviderError,
} from '../../src/risk-review/risk-provider';

export const okAssessment = (score = 42): RiskAssessment => ({
  score,
  level: score < 34 ? 'LOW' : score < 67 ? 'MEDIUM' : 'HIGH',
  flags: [],
  provider: 'fake-provider',
  reference: `FAKE-${score}`,
});

export const transientFailure = () =>
  new RiskProviderError('provider unavailable', 'PROVIDER_UNAVAILABLE', true);

export const permanentFailure = () =>
  new RiskProviderError('input rejected', 'INPUT_REJECTED', false);

/** A promise that can be settled from the outside, to hold a job mid-flight. */
export const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/** Test double for the risk provider: records calls, behavior set per test. */
export class ScriptedRiskProvider extends RiskProviderClient {
  calls: RiskAssessmentInput[] = [];
  handler: (
    input: RiskAssessmentInput,
    callNumber: number,
  ) => Promise<RiskAssessment> = () => Promise.resolve(okAssessment());

  assess(input: RiskAssessmentInput): Promise<RiskAssessment> {
    this.calls.push(input);
    return this.handler(input, this.calls.length);
  }

  reset() {
    this.calls = [];
    this.handler = () => Promise.resolve(okAssessment());
  }

  callsFor(applicationId: string) {
    return this.calls.filter((c) => c.applicationId === applicationId);
  }
}
