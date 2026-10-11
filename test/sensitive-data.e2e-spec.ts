import { maskEmail, maskPhone, maskTaxId } from '../src/common/security/mask';
import { ApplicationStatus } from '../src/applications/enums/application-status.enum';
import {
  createHarness,
  Harness,
  validApplicationPayload,
} from './helpers/e2e-harness';

const TAX_ID = validApplicationPayload.ownerTaxId; // 123-456-789
const EMAIL = validApplicationPayload.ownerEmail;
const PHONE = validApplicationPayload.ownerPhone;
const DIGITS = '9876543210';

describe('Sensitive data: masking & encryption at rest (e2e)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  const rawTaxId = async (id: string): Promise<string> => {
    const rows = await h.ds.query(
      'SELECT "ownerTaxId" FROM merchant_applications WHERE id = $1',
      [id],
    );
    return rows[0].ownerTaxId;
  };

  const expectMasked = (body: Record<string, unknown>) => {
    // Expected values come from the shared helpers; the literals pin the format.
    expect(body.ownerEmail).toBe(maskEmail(EMAIL));
    expect(body.ownerEmail).toBe('c*********@example.com');
    expect(body.ownerPhone).toBe(maskPhone(PHONE));
    expect(body.ownerPhone).toBe('+*** ******3210');
    expect(body.ownerTaxId).toBe(maskTaxId(TAX_ID));
    expect(body.ownerTaxId).toBe('*******-789');
    const json = JSON.stringify(body);
    for (const secret of [EMAIL, EMAIL.split('@')[0], DIGITS, TAX_ID]) {
      expect(json).not.toContain(secret);
    }
  };

  describe('encryption at rest', () => {
    it('stores ownerTaxId as ciphertext, never as plaintext', async () => {
      const { id } = await h.createApplication('salesA');
      const stored = await rawTaxId(id);
      expect(stored).toMatch(/^v1:[^:]+:[^:]+:[^:]+$/);
      expect(stored).not.toContain(TAX_ID);
      expect(stored).not.toContain('789');
    });

    it('stores the same tax id differently every time (random IV)', async () => {
      const a = await h.createApplication('salesA');
      const b = await h.createApplication('salesA');
      expect(await rawTaxId(a.id)).not.toBe(await rawTaxId(b.id));
    });

    it('round-trips: ADMIN reads the original value back from the encrypted column', async () => {
      const { id } = await h.createApplication('salesA');
      const res = await h.as('admin').get(`/applications/${id}`).expect(200);
      expect(res.body.ownerTaxId).toBe(TAX_ID);
    });

    it('encrypts values written through PATCH too', async () => {
      const { id } = await h.createApplication('salesA');
      await h
        .as('salesA')
        .patch(`/applications/${id}`)
        .send({ ownerTaxId: '999-888-777' })
        .expect(200);

      const stored = await rawTaxId(id);
      expect(stored).toMatch(/^v1:/);
      expect(stored).not.toContain('999-888-777');
      const res = await h.as('admin').get(`/applications/${id}`).expect(200);
      expect(res.body.ownerTaxId).toBe('999-888-777');
    });

    it('does not decrypt data that has been tampered with, and leaks nothing', async () => {
      // A corrupted row must not outlive this test: ADMIN's list is unscoped,
      // so it would make every parallel suite's admin list return 500.
      const { id } = await h.createApplication('salesA');
      try {
        const stored = await rawTaxId(id);
        const tampered =
          stored.slice(0, -4) + (stored.endsWith('AAAA') ? 'BBBB' : 'AAAA');
        await h.ds.query(
          'UPDATE merchant_applications SET "ownerTaxId" = $1 WHERE id = $2',
          [tampered, id],
        );

        const res = await h.as('admin').get(`/applications/${id}`).expect(500);
        expect(res.body.message).toBe('Internal server error');
        const json = JSON.stringify(res.body);
        expect(json).not.toContain(TAX_ID);
        expect(json).not.toMatch(/decrypt|cipher|v1:/i);
      } finally {
        await h.apps().delete({ id });
      }
    });

    it('refuses to serve a plaintext value found in the encrypted column', async () => {
      // A corrupted row must not outlive this test: ADMIN's list is unscoped,
      // so it would make every parallel suite's admin list return 500.
      const { id } = await h.createApplication('salesA');
      try {
        await h.ds.query(
          'UPDATE merchant_applications SET "ownerTaxId" = $1 WHERE id = $2',
          ['PLAINTEXT-LEFTOVER', id],
        );
        const res = await h.as('admin').get(`/applications/${id}`).expect(500);
        expect(JSON.stringify(res.body)).not.toContain('PLAINTEXT-LEFTOVER');
      } finally {
        await h.apps().delete({ id });
      }
    });
  });

  describe('masking in API responses', () => {
    let id: string;

    beforeAll(async () => {
      id = (await h.createApplication('salesA')).id;
      await h.apps().update(
        { id },
        {
          assignedReviewerId: h.users.rev1.id,
          status: ApplicationStatus.IN_REVIEW,
        },
      );
    });

    it('masks everything in the create response', async () => {
      const res = await h
        .as('salesA')
        .post('/applications')
        .send(validApplicationPayload)
        .expect(201);
      expectMasked(res.body);
    });

    it('masks the detail view for the owning SALES user', async () => {
      expectMasked(
        (await h.as('salesA').get(`/applications/${id}`).expect(200)).body,
      );
    });

    it('masks the detail view for the assigned REVIEWER', async () => {
      expectMasked(
        (await h.as('rev1').get(`/applications/${id}`).expect(200)).body,
      );
    });

    it('reveals full owner data to ADMIN on the detail view, and only there', async () => {
      const res = await h.as('admin').get(`/applications/${id}`).expect(200);
      expect(res.body).toMatchObject({
        ownerEmail: EMAIL,
        ownerPhone: PHONE,
        ownerTaxId: TAX_ID,
      });
    });

    it('keeps the list masked, even for ADMIN', async () => {
      // ADMIN's list is unscoped and other suites create applications in
      // parallel, so page until ours turns up instead of assuming page 1.
      let item: Record<string, unknown> | undefined;
      for (let page = 1; page <= 50 && !item; page++) {
        const res = await h
          .as('admin')
          .get(`/applications?limit=100&page=${page}`)
          .expect(200);
        item = res.body.items.find((i: { id: string }) => i.id === id);
        if (res.body.items.length === 0) break;
      }
      expect(item).toBeDefined();
      expectMasked(item as Record<string, unknown>);
    });

    it('keeps write responses masked, even for ADMIN', async () => {
      const patched = await h
        .as('admin')
        .patch(`/applications/${(await h.createApplication('salesA')).id}`)
        .send({ businessName: 'Renamed by admin' })
        .expect(200);
      expectMasked(patched.body);

      const created = await h
        .as('admin')
        .post('/applications')
        .send(validApplicationPayload)
        .expect(201);
      expectMasked(created.body);
    });

    it('keeps workflow responses masked (submit)', async () => {
      const draft = await h.createApplication('salesA');
      const res = await h
        .as('admin')
        .post(`/applications/${draft.id}/submit`)
        .expect(200);
      expectMasked(res.body);
    });
  });

  describe('no secrets in auth responses', () => {
    it('never echoes the password or a hash on login failure or /auth/me', async () => {
      const bad = await h
        .http()
        .post('/auth/login')
        .send({ email: h.users.salesA.email, password: 'Wrong-Pass-123' });
      expect(JSON.stringify(bad.body)).not.toContain('Wrong-Pass-123');

      const me = await h.as('salesA').get('/auth/me').expect(200);
      expect(JSON.stringify(me.body)).not.toMatch(/password|hash|\$2[aby]\$/i);
    });
  });
});
