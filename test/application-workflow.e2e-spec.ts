import { randomUUID } from 'crypto';
import { ApplicationStatus } from '../src/applications/enums/application-status.enum';
import { RiskStatus } from '../src/applications/enums/risk-status.enum';
import { createHarness, Harness } from './helpers/e2e-harness';

describe('Application workflow: submit, assign, decide (e2e)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  /** Creates an application and pushes it into the given state directly in the DB. */
  const seed = async (
    status: ApplicationStatus,
    over: Partial<{
      assignedReviewerId: string | null;
      riskStatus: RiskStatus;
    }> = {},
    owner: 'salesA' | 'salesB' = 'salesA',
  ) => {
    const { id } = await h.createApplication(owner);
    await h.apps().update({ id }, { status, ...over });
    return id;
  };

  const inReview = (
    reviewer: 'rev1' | 'rev2' = 'rev1',
    risk = RiskStatus.COMPLETED,
  ) =>
    seed(ApplicationStatus.IN_REVIEW, {
      assignedReviewerId: h.users[reviewer].id,
      riskStatus: risk,
    });

  describe('happy path: create -> submit -> assign -> decide', () => {
    it('walks the whole lifecycle and locks the application afterwards', async () => {
      const { id } = await h.createApplication('salesA');

      const submitted = await h
        .as('salesA')
        .post(`/applications/${id}/submit`)
        .expect(200);
      expect(submitted.body.status).toBe('SUBMITTED');
      expect(submitted.body.submittedAt).toEqual(expect.any(String));
      expect(submitted.body.riskStatus).toBe('PENDING');

      const assigned = await h
        .as('admin')
        .post(`/applications/${id}/assign`)
        .send({ reviewerId: h.users.rev1.id })
        .expect(200);
      expect(assigned.body).toMatchObject({
        status: 'IN_REVIEW',
        assignedReviewerId: h.users.rev1.id,
      });

      // Pack 07 will complete the risk review asynchronously; simulate it here.
      await h.apps().update({ id }, { riskStatus: RiskStatus.COMPLETED });

      const decided = await h
        .as('rev1')
        .post(`/applications/${id}/decision`)
        .send({ decision: 'APPROVED' })
        .expect(200);
      expect(decided.body.status).toBe('APPROVED');
      expect(decided.body.decidedAt).toEqual(expect.any(String));

      // terminal: no edits, no second decision, no re-submit
      await h
        .as('salesA')
        .patch(`/applications/${id}`)
        .send({ businessName: 'x' })
        .expect(409);
      await h
        .as('rev1')
        .post(`/applications/${id}/decision`)
        .send({ decision: 'REJECTED', reason: 'changed my mind' })
        .expect(409);
      await h.as('salesA').post(`/applications/${id}/submit`).expect(409);
    });
  });

  describe('POST /applications/:id/submit', () => {
    it('requires authentication', async () => {
      const { id } = await h.createApplication('salesA');
      await h.http().post(`/applications/${id}/submit`).expect(401);
    });

    it('hides another SALES user’s application (404) and leaves it a DRAFT', async () => {
      const { id } = await h.createApplication('salesA');
      await h.as('salesB').post(`/applications/${id}/submit`).expect(404);
      const res = await h.as('salesA').get(`/applications/${id}`).expect(200);
      expect(res.body.status).toBe('DRAFT');
    });

    it('is forbidden for REVIEWER (403)', async () => {
      const { id } = await h.createApplication('salesA');
      await h.as('rev1').post(`/applications/${id}/submit`).expect(403);
    });

    it('lets ADMIN submit any application', async () => {
      const { id } = await h.createApplication('salesA');
      await h.as('admin').post(`/applications/${id}/submit`).expect(200);
    });

    it('rejects a double submit with 409', async () => {
      const { id } = await h.createApplication('salesA');
      await h.as('salesA').post(`/applications/${id}/submit`).expect(200);
      const second = await h
        .as('salesA')
        .post(`/applications/${id}/submit`)
        .expect(409);
      expect(second.body.message).toMatch(/SUBMITTED to SUBMITTED/);
    });

    it('lets exactly one of several simultaneous submits through', async () => {
      const { id } = await h.createApplication('salesA');
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          h.as('salesA').post(`/applications/${id}/submit`),
        ),
      );
      const codes = results.map((r) => r.status).sort();
      expect(codes.filter((c) => c === 200)).toHaveLength(1);
      expect(codes.filter((c) => c === 409)).toHaveLength(4);
    });

    it('returns 422 listing the fields when the application is incomplete', async () => {
      const { id } = await h.createApplication('salesA');
      await h.apps().update({ id }, { businessName: '' });
      const res = await h
        .as('salesA')
        .post(`/applications/${id}/submit`)
        .expect(422);
      expect(res.body.details).toEqual({ missingFields: ['businessName'] });
    });

    it('returns 404 for an unknown id and 400 for a malformed one', async () => {
      await h
        .as('salesA')
        .post(`/applications/${randomUUID()}/submit`)
        .expect(404);
      await h.as('salesA').post('/applications/not-a-uuid/submit').expect(400);
    });

    it('starts a fresh review (clearing the old result) when an INFO_REQUESTED application is resubmitted', async () => {
      const id = await seed(ApplicationStatus.INFO_REQUESTED, {
        riskStatus: RiskStatus.COMPLETED,
      });
      await h
        .apps()
        .update({ id }, { riskScore: 42, riskResult: { provider: 'sim' } });

      const res = await h
        .as('salesA')
        .post(`/applications/${id}/submit`)
        .expect(200);
      expect(res.body).toMatchObject({
        status: 'SUBMITTED',
        riskStatus: 'PENDING',
        riskScore: null,
      });
      const row = await h.apps().findOneByOrFail({ id });
      expect(row.riskResult).toBeNull();
    });
  });

  describe('POST /applications/:id/assign', () => {
    it('is ADMIN-only: SALES and REVIEWER get 403', async () => {
      const id = await seed(ApplicationStatus.SUBMITTED);
      const body = { reviewerId: h.users.rev1.id };
      await h
        .as('salesA')
        .post(`/applications/${id}/assign`)
        .send(body)
        .expect(403);
      await h
        .as('rev1')
        .post(`/applications/${id}/assign`)
        .send(body)
        .expect(403);
      await h.http().post(`/applications/${id}/assign`).send(body).expect(401);
    });

    it.each([
      ['a SALES user', 'salesB'],
      ['an ADMIN', 'admin'],
    ] as const)('rejects %s as the reviewer with 422', async (_n, target) => {
      const id = await seed(ApplicationStatus.SUBMITTED);
      await h
        .as('admin')
        .post(`/applications/${id}/assign`)
        .send({ reviewerId: h.users[target].id })
        .expect(422);
    });

    it('rejects an unknown or inactive reviewer with 422, and a bad uuid with 400', async () => {
      const id = await seed(ApplicationStatus.SUBMITTED);
      await h
        .as('admin')
        .post(`/applications/${id}/assign`)
        .send({ reviewerId: randomUUID() })
        .expect(422);

      await h.ds
        .getRepository('User')
        .update({ id: h.users.rev2.id }, { isActive: false });
      await h
        .as('admin')
        .post(`/applications/${id}/assign`)
        .send({ reviewerId: h.users.rev2.id })
        .expect(422);
      await h.ds
        .getRepository('User')
        .update({ id: h.users.rev2.id }, { isActive: true });

      await h
        .as('admin')
        .post(`/applications/${id}/assign`)
        .send({ reviewerId: 'abc' })
        .expect(400);
      await h
        .as('admin')
        .post(`/applications/${id}/assign`)
        .send({})
        .expect(400);
    });

    it.each([
      ApplicationStatus.DRAFT,
      ApplicationStatus.INFO_REQUESTED,
      ApplicationStatus.APPROVED,
      ApplicationStatus.REJECTED,
    ])('returns 409 when the application is %s', async (status) => {
      const id = await seed(status);
      await h
        .as('admin')
        .post(`/applications/${id}/assign`)
        .send({ reviewerId: h.users.rev1.id })
        .expect(409);
    });

    it('allows re-assignment while IN_REVIEW: the old reviewer loses access, the new one gains it', async () => {
      const id = await inReview('rev1');
      await h.as('rev1').get(`/applications/${id}`).expect(200);
      await h.as('rev2').get(`/applications/${id}`).expect(404);

      const res = await h
        .as('admin')
        .post(`/applications/${id}/assign`)
        .send({ reviewerId: h.users.rev2.id })
        .expect(200);
      expect(res.body).toMatchObject({
        status: 'IN_REVIEW',
        assignedReviewerId: h.users.rev2.id,
      });

      await h.as('rev1').get(`/applications/${id}`).expect(404);
      await h
        .as('rev1')
        .post(`/applications/${id}/decision`)
        .send({ decision: 'APPROVED' })
        .expect(404);
      await h
        .as('rev2')
        .post(`/applications/${id}/decision`)
        .send({ decision: 'APPROVED' })
        .expect(200);
    });

    it('is idempotent when the same reviewer is assigned again', async () => {
      const id = await inReview('rev1');
      await h
        .as('admin')
        .post(`/applications/${id}/assign`)
        .send({ reviewerId: h.users.rev1.id })
        .expect(200);
    });

    it('returns 404 for an unknown application', async () => {
      await h
        .as('admin')
        .post(`/applications/${randomUUID()}/assign`)
        .send({ reviewerId: h.users.rev1.id })
        .expect(404);
    });
  });

  describe('POST /applications/:id/decision', () => {
    it('lets only the ASSIGNED reviewer decide; another reviewer gets 404 and nothing changes', async () => {
      const id = await inReview('rev1');
      await h
        .as('rev2')
        .post(`/applications/${id}/decision`)
        .send({ decision: 'APPROVED' })
        .expect(404);
      expect((await h.apps().findOneByOrFail({ id })).status).toBe('IN_REVIEW');

      await h
        .as('rev1')
        .post(`/applications/${id}/decision`)
        .send({ decision: 'APPROVED' })
        .expect(200);
    });

    it('gives ADMIN, SALES and the unauthenticated no way to decide', async () => {
      const id = await inReview('rev1');
      const body = { decision: 'APPROVED' };
      await h
        .as('admin')
        .post(`/applications/${id}/decision`)
        .send(body)
        .expect(403);
      await h
        .as('salesA')
        .post(`/applications/${id}/decision`)
        .send(body)
        .expect(403);
      await h
        .as('salesB')
        .post(`/applications/${id}/decision`)
        .send(body)
        .expect(403);
      await h
        .http()
        .post(`/applications/${id}/decision`)
        .send(body)
        .expect(401);
      expect((await h.apps().findOneByOrFail({ id })).status).toBe('IN_REVIEW');
    });

    it('records REJECTED with its reason and decidedAt', async () => {
      const id = await inReview('rev1');
      const res = await h
        .as('rev1')
        .post(`/applications/${id}/decision`)
        .send({ decision: 'REJECTED', reason: '  Failed KYB check ' })
        .expect(200);
      expect(res.body).toMatchObject({
        status: 'REJECTED',
        decisionReason: 'Failed KYB check',
      });
      expect(res.body.decidedAt).toEqual(expect.any(String));
    });

    it.each(['REJECTED', 'INFO_REQUESTED'])(
      'requires a reason for %s (400)',
      async (decision) => {
        const id = await inReview('rev1');
        const res = await h
          .as('rev1')
          .post(`/applications/${id}/decision`)
          .send({ decision })
          .expect(400);
        expect(res.body.details[0].field).toBe('reason');
        await h
          .as('rev1')
          .post(`/applications/${id}/decision`)
          .send({ decision, reason: '   ' })
          .expect(400);
      },
    );

    it.each(['SUBMITTED', 'DRAFT', 'IN_REVIEW', 'nonsense'])(
      'rejects the decision value %s (400)',
      async (decision) => {
        const id = await inReview('rev1');
        await h
          .as('rev1')
          .post(`/applications/${id}/decision`)
          .send({ decision, reason: 'x' })
          .expect(400);
      },
    );

    it.each([RiskStatus.NOT_STARTED, RiskStatus.PENDING, RiskStatus.FAILED])(
      'is blocked with 409 while the risk review is %s',
      async (risk) => {
        const id = await inReview('rev1', risk);
        const res = await h
          .as('rev1')
          .post(`/applications/${id}/decision`)
          .send({ decision: 'APPROVED' })
          .expect(409);
        expect(res.body.details).toEqual({ riskStatus: risk });
        expect((await h.apps().findOneByOrFail({ id })).status).toBe(
          'IN_REVIEW',
        );
      },
    );

    it.each([
      ApplicationStatus.DRAFT,
      ApplicationStatus.SUBMITTED,
      ApplicationStatus.APPROVED,
      ApplicationStatus.INFO_REQUESTED,
      ApplicationStatus.REJECTED,
    ])(
      'returns 409 when the application is %s (only IN_REVIEW can be decided)',
      async (status) => {
        const id = await seed(status, {
          assignedReviewerId: h.users.rev1.id,
          riskStatus: RiskStatus.COMPLETED,
        });
        await h
          .as('rev1')
          .post(`/applications/${id}/decision`)
          .send({ decision: 'APPROVED' })
          .expect(409);
      },
    );

    it('lets exactly one of several simultaneous decisions win', async () => {
      const id = await inReview('rev1');
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          h
            .as('rev1')
            .post(`/applications/${id}/decision`)
            .send({ decision: 'APPROVED' }),
        ),
      );
      const codes = results.map((r) => r.status);
      expect(codes.filter((c) => c === 200)).toHaveLength(1);
      expect(codes.filter((c) => c === 409)).toHaveLength(4);
    });
  });

  describe('request for information loop', () => {
    it('INFO_REQUESTED -> edit -> resubmit -> assign -> decide', async () => {
      const id = await inReview('rev1');

      const info = await h
        .as('rev1')
        .post(`/applications/${id}/decision`)
        .send({
          decision: 'INFO_REQUESTED',
          reason: 'Please add the trade licence number',
        })
        .expect(200);
      expect(info.body).toMatchObject({
        status: 'INFO_REQUESTED',
        decisionReason: 'Please add the trade licence number',
      });

      // the sales user can see why and fix it
      await h
        .as('salesA')
        .patch(`/applications/${id}`)
        .send({ businessType: 'restaurant' })
        .expect(200);
      const resubmitted = await h
        .as('salesA')
        .post(`/applications/${id}/submit`)
        .expect(200);
      expect(resubmitted.body).toMatchObject({
        status: 'SUBMITTED',
        riskStatus: 'PENDING',
      });

      // the reviewer cannot decide until an admin puts it back in review
      await h
        .as('rev1')
        .post(`/applications/${id}/decision`)
        .send({ decision: 'APPROVED' })
        .expect(409);

      await h
        .as('admin')
        .post(`/applications/${id}/assign`)
        .send({ reviewerId: h.users.rev1.id })
        .expect(200);
      await h.apps().update({ id }, { riskStatus: RiskStatus.COMPLETED });
      const final = await h
        .as('rev1')
        .post(`/applications/${id}/decision`)
        .send({ decision: 'APPROVED' })
        .expect(200);
      expect(final.body.status).toBe('APPROVED');
    });
  });
});
