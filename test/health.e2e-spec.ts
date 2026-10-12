import { createHarness, Harness } from './helpers/e2e-harness';

describe('Health (e2e)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it('GET /health returns ok without a token', async () => {
    const res = await h.http().get('/health').expect(200);
    expect(res.body.status).toBe('ok');
  });
});
