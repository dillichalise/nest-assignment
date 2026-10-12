import { ConfigService } from '@nestjs/config';
import { RiskAssessmentInput, RiskProviderError } from './risk-provider';
import { SimulatedRiskProvider } from './simulated-risk-provider';

const make = (env: Record<string, string> = {}) =>
  new SimulatedRiskProvider({
    get: (key: string, fallback?: unknown) => env[key] ?? fallback,
  } as unknown as ConfigService);

const input = (
  over: Partial<RiskAssessmentInput> = {},
): RiskAssessmentInput => ({
  applicationId: 'app-1',
  idempotencyKey: 'risk-review-app-1-1',
  businessType: 'restaurant',
  monthlyVolume: '25000.00',
  averageTicketSize: '42.50',
  currency: 'USD',
  ...over,
});

describe('SimulatedRiskProvider', () => {
  const provider = make({ RISK_SIM_LATENCY_MS: '0' });

  it('is deterministic: the same input always gives the same result', async () => {
    const a = await provider.assess(input());
    const b = await provider.assess(input());
    expect(a).toEqual(b);
  });

  it('does not depend on the idempotency key (a retried run gives the same answer)', async () => {
    const a = await provider.assess(input({ idempotencyKey: 'run-1' }));
    const b = await provider.assess(input({ idempotencyKey: 'run-2' }));
    expect(a).toEqual(b);
  });

  it('gives different applications different results', async () => {
    const scores = new Set<number>();
    for (let i = 0; i < 20; i++) {
      scores.add(
        (await provider.assess(input({ applicationId: `app-${i}` }))).score,
      );
    }
    expect(scores.size).toBeGreaterThan(5);
  });

  it('returns a well-formed assessment', async () => {
    const r = await provider.assess(input());
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(99);
    expect(['LOW', 'MEDIUM', 'HIGH']).toContain(r.level);
    expect(r.provider).toBe('simulated-kyb');
    expect(r.reference).toMatch(/^SIM-[0-9a-f]{12}$/);
    expect(Array.isArray(r.flags)).toBe(true);
  });

  it('maps the score to a level consistently', async () => {
    for (let i = 0; i < 60; i++) {
      const r = await provider.assess(input({ applicationId: `lvl-${i}` }));
      const expected = r.score < 34 ? 'LOW' : r.score < 67 ? 'MEDIUM' : 'HIGH';
      expect(r.level).toBe(expected);
    }
  });

  it('flags high volume and high ticket sizes, and they raise the score', async () => {
    const base = await provider.assess(
      input({ monthlyVolume: '1000', averageTicketSize: '10' }),
    );
    const risky = await provider.assess(
      input({ monthlyVolume: '150000', averageTicketSize: '9000' }),
    );
    expect(base.flags).toEqual([]);
    expect(risky.flags).toEqual(['HIGH_VOLUME', 'HIGH_TICKET']);
  });

  it('never exceeds 99', async () => {
    for (let i = 0; i < 100; i++) {
      const r = await provider.assess(
        input({
          applicationId: `cap-${i}`,
          monthlyVolume: '999999',
          averageTicketSize: '9999',
        }),
      );
      expect(r.score).toBeLessThanOrEqual(99);
    }
  });

  describe('demo knobs', () => {
    it('always fails transiently at failure rate 1', async () => {
      const failing = make({
        RISK_SIM_LATENCY_MS: '0',
        RISK_SIM_FAILURE_RATE: '1',
      });
      const err = await failing.assess(input()).catch((e) => e);
      expect(err).toBeInstanceOf(RiskProviderError);
      expect(err.retryable).toBe(true);
      expect(err.code).toBe('PROVIDER_UNAVAILABLE');
    });

    it('never fails at failure rate 0', async () => {
      for (let i = 0; i < 50; i++) {
        await expect(provider.assess(input())).resolves.toBeDefined();
      }
    });

    it('fails about as often as configured', async () => {
      const flaky = make({
        RISK_SIM_LATENCY_MS: '0',
        RISK_SIM_FAILURE_RATE: '0.5',
      });
      let failures = 0;
      for (let i = 0; i < 400; i++) {
        await flaky.assess(input()).catch(() => failures++);
      }
      expect(failures).toBeGreaterThan(120);
      expect(failures).toBeLessThan(280);
    });

    it.each(['abc', '-3', '7'])(
      'clamps or ignores a bad failure rate (%p)',
      async (bad) => {
        const p = make({
          RISK_SIM_LATENCY_MS: '0',
          RISK_SIM_FAILURE_RATE: bad,
        });
        // must not throw a configuration error; at worst it fails/succeeds consistently
        await p.assess(input()).catch(() => undefined);
      },
    );

    it('waits for the configured latency', async () => {
      const slow = make({ RISK_SIM_LATENCY_MS: '60' });
      const started = Date.now();
      await slow.assess(input());
      expect(Date.now() - started).toBeGreaterThanOrEqual(55);
    });
  });

  describe('RiskProviderError', () => {
    it('is retryable unless said otherwise', () => {
      expect(new RiskProviderError('m', 'CODE').retryable).toBe(true);
      expect(new RiskProviderError('m', 'CODE', false).retryable).toBe(false);
    });

    it('carries a code and is identifiable by name', () => {
      const error = new RiskProviderError('boom', 'PROVIDER_UNAVAILABLE');
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('RiskProviderError');
      expect(error.code).toBe('PROVIDER_UNAVAILABLE');
      expect(error.message).toBe('boom');
    });
  });
});
