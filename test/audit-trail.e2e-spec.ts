import './helpers/enable-risk-worker';
import { randomUUID } from 'crypto';
import { ApplicationStatus } from '../src/applications/enums/application-status.enum';
import { RiskStatus } from '../src/applications/enums/risk-status.enum';
import { AuditAction } from '../src/audit/audit-action.enum';
import { AuditLog } from '../src/audit/audit-log.entity';
import { AuditService } from '../src/audit/audit.service';
import { User } from '../src/users/user.entity';
import {
  createHarness,
  E2E_PASSWORD,
  Harness,
  validApplicationPayload,
  waitFor,
} from './helpers/e2e-harness';
import {
  okAssessment,
  permanentFailure,
  ScriptedRiskProvider,
} from './helpers/fake-risk-provider';

/**
 * Pack 08 acceptance: every action leaves exactly one audit row, written in the
 * same transaction as the change; no secret ever reaches the trail; the table
 * is append-only. Real worker + Redis + Postgres; only the risk provider is
 * scripted.
 */
describe('Audit trail (e2e)', () => {
  const provider = new ScriptedRiskProvider();
  let h: Harness;
  let auditService: AuditService;

  beforeAll(async () => {
    h = await createHarness({ riskProvider: provider });
    auditService = h.app.get(AuditService);
  });
  afterAll(() => h.close());
  beforeEach(() => provider.reset());
  afterEach(async () => {
    // A test can end while its application's background review is still
    // running. That worker also writes audit rows, so it must finish BEFORE the
    // next test arms a one-shot failure on AuditService.record: otherwise the
    // worker, not the request under test, would consume it.
    await waitFor(
      async () => {
        const c = await h.queue.getJobCounts('active', 'waiting', 'delayed');
        return c.active + c.waiting + c.delayed === 0;
      },
      { what: 'the risk-review queue to go idle' },
    );
    jest.restoreAllMocks();
  });

  const logs = () => h.ds.getRepository(AuditLog);
  const rowsOf = (entityId: string) =>
    logs().find({
      where: { entityId },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
  const actionsOf = async (entityId: string) =>
    (await rowsOf(entityId)).map((r) => r.action);
  const countOf = async (entityId: string, action: AuditAction) =>
    logs().count({ where: { entityId, action } });
  const app = (id: string) => h.apps().findOneByOrFail({ id });
  const submit = (id: string, who: 'salesA' | 'admin' = 'salesA') =>
    h.as(who).post(`/applications/${id}/submit`);
  const waitForRisk = (id: string, status: RiskStatus) =>
    waitFor(
      async () => ((await app(id)).riskStatus === status ? true : false),
      {
        what: `risk status ${status}`,
      },
    );
  const waitForAction = (id: string, action: AuditAction, n = 1) =>
    waitFor(async () => (await countOf(id, action)) >= n, {
      what: `${n} x ${action} for ${id}`,
    });

  describe('every action leaves exactly one audit row', () => {
    it('create: APPLICATION_CREATED, with the actor and the request id', async () => {
      const res = await h
        .as('salesA')
        .post('/applications')
        .set('x-request-id', 'e2e-trace-create-1')
        .send(validApplicationPayload)
        .expect(201);

      const rows = await rowsOf(res.body.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: AuditAction.APPLICATION_CREATED,
        actorId: h.users.salesA.id,
        actorRole: 'SALES',
        entityType: 'MerchantApplication',
        entityId: res.body.id,
        metadata: { initialStatus: 'DRAFT' },
        correlationId: 'e2e-trace-create-1',
      });
      expect(rows[0].createdAt).toBeInstanceOf(Date);
    });

    it('correlation id defaults to the generated x-request-id response header', async () => {
      const res = await h
        .as('salesA')
        .post('/applications')
        .send(validApplicationPayload)
        .expect(201);
      const [row] = await rowsOf(res.body.id);
      expect(row.correlationId).toBe(res.headers['x-request-id']);
      expect(row.correlationId).toBeTruthy();
    });

    it('update: APPLICATION_UPDATED lists the changed field NAMES, never the values', async () => {
      const { id } = await h.createApplication('salesA');
      await h
        .as('salesA')
        .patch(`/applications/${id}`)
        .send({
          ownerTaxId: '999-888-777',
          businessName: 'Renamed Cafe',
          ownerEmail: 'new@example.com',
        })
        .expect(200);

      expect(await countOf(id, AuditAction.APPLICATION_UPDATED)).toBe(1);
      const [, updated] = await rowsOf(id);
      expect(updated.metadata).toEqual({
        changedFields: ['businessName', 'ownerEmail', 'ownerTaxId'],
      });
      const json = JSON.stringify(updated);
      for (const value of ['999-888-777', 'Renamed Cafe', 'new@example.com']) {
        expect(json).not.toContain(value);
      }
    });

    it('submit + background review: SUBMITTED, then STARTED and COMPLETED written by the worker', async () => {
      const { id } = await h.createApplication('salesA');
      await submit(id).expect(200);
      await waitForRisk(id, RiskStatus.COMPLETED);
      await waitForAction(id, AuditAction.RISK_REVIEW_COMPLETED);

      expect(await actionsOf(id)).toEqual([
        AuditAction.APPLICATION_CREATED,
        AuditAction.APPLICATION_SUBMITTED,
        AuditAction.RISK_REVIEW_STARTED,
        AuditAction.RISK_REVIEW_COMPLETED,
      ]);

      const rows = await rowsOf(id);
      expect(rows[1]).toMatchObject({
        actorId: h.users.salesA.id,
        metadata: { from: 'DRAFT', to: 'SUBMITTED', riskReviewRun: 1 },
      });
      // worker events: no actor, correlated to the BullMQ job
      for (const worker of [rows[2], rows[3]]) {
        expect(worker.actorId).toBeNull();
        expect(worker.actorRole).toBeNull();
        expect(worker.correlationId).toBe(`risk-review-${id}-1`);
      }
      expect(rows[3].metadata).toEqual({ run: 1, score: 42, level: 'MEDIUM' });
    });

    it('assign: one row per assignment, with the previous reviewer on re-assignment, none for a no-op', async () => {
      const { id } = await h.createApplication('salesA');
      await submit(id).expect(200);
      await waitForRisk(id, RiskStatus.COMPLETED);

      await h
        .as('admin')
        .post(`/applications/${id}/assign`)
        .send({ reviewerId: h.users.rev1.id })
        .expect(200);
      expect(await countOf(id, AuditAction.REVIEWER_ASSIGNED)).toBe(1);

      // same reviewer again: nothing changed, nothing recorded
      await h
        .as('admin')
        .post(`/applications/${id}/assign`)
        .send({ reviewerId: h.users.rev1.id })
        .expect(200);
      expect(await countOf(id, AuditAction.REVIEWER_ASSIGNED)).toBe(1);

      await h
        .as('admin')
        .post(`/applications/${id}/assign`)
        .send({ reviewerId: h.users.rev2.id })
        .expect(200);
      const assigned = (await rowsOf(id)).filter(
        (r) => r.action === AuditAction.REVIEWER_ASSIGNED,
      );
      expect(assigned).toHaveLength(2);
      expect(assigned[0]).toMatchObject({
        actorId: h.users.admin.id,
        actorRole: 'ADMIN',
        metadata: {
          reviewerId: h.users.rev1.id,
          previousReviewerId: null,
          reassigned: false,
        },
      });
      expect(assigned[1].metadata).toEqual({
        reviewerId: h.users.rev2.id,
        previousReviewerId: h.users.rev1.id,
        reassigned: true,
      });
    });

    it('decision: DECISION_RECORDED, with personal data in the free-text reason masked', async () => {
      const { id } = await h.createApplication('salesA');
      await submit(id).expect(200);
      await waitForRisk(id, RiskStatus.COMPLETED);
      await h
        .as('admin')
        .post(`/applications/${id}/assign`)
        .send({ reviewerId: h.users.rev1.id })
        .expect(200);

      await h
        .as('rev1')
        .post(`/applications/${id}/decision`)
        .send({
          decision: 'REJECTED',
          reason: 'Please verify with pat@example.com or call +977 9876543210',
        })
        .expect(200);

      expect(await countOf(id, AuditAction.DECISION_RECORDED)).toBe(1);
      const row = (await rowsOf(id)).find(
        (r) => r.action === AuditAction.DECISION_RECORDED,
      )!;
      expect(row).toMatchObject({
        actorId: h.users.rev1.id,
        actorRole: 'REVIEWER',
      });
      expect(row.metadata.decision).toBe('REJECTED');
      const reason = row.metadata.reason as string;
      expect(reason).toContain('Please verify with');
      expect(reason).not.toContain('pat@example.com');
      expect(reason).not.toContain('9876543210');
      expect(reason).toContain('p**@example.com');
    });

    it('failed review + admin retry: one FAILED per run, then RETRY_REQUESTED, a new STARTED and COMPLETED', async () => {
      provider.handler = () => Promise.reject(permanentFailure());
      const { id } = await h.createApplication('salesA');
      await submit(id).expect(200);
      await waitForRisk(id, RiskStatus.FAILED);
      await waitForAction(id, AuditAction.RISK_REVIEW_FAILED);

      provider.handler = () => Promise.resolve(okAssessment(10));
      await h
        .as('admin')
        .post(`/applications/${id}/risk-review/retry`)
        .expect(202);
      await waitForRisk(id, RiskStatus.COMPLETED);
      await waitForAction(id, AuditAction.RISK_REVIEW_COMPLETED);

      expect(await actionsOf(id)).toEqual([
        AuditAction.APPLICATION_CREATED,
        AuditAction.APPLICATION_SUBMITTED,
        AuditAction.RISK_REVIEW_STARTED,
        AuditAction.RISK_REVIEW_FAILED,
        AuditAction.RISK_REVIEW_RETRY_REQUESTED,
        AuditAction.RISK_REVIEW_STARTED,
        AuditAction.RISK_REVIEW_COMPLETED,
      ]);
      const rows = await rowsOf(id);
      // the failure holds a code and an attempt count, not the provider's text
      expect(rows[3].metadata).toEqual({
        run: 1,
        code: 'INPUT_REJECTED',
        attempts: 1,
      });
      expect(rows[4]).toMatchObject({
        actorId: h.users.admin.id,
        metadata: { run: 2 },
      });
      expect(rows[5].correlationId).toBe(`risk-review-${id}-2`);
    });

    it('a review that cannot even be queued is recorded as FAILED (ENQUEUE_FAILED) with the request id', async () => {
      jest
        .spyOn(h.queue, 'add')
        .mockRejectedValueOnce(new Error('redis is down'));
      const { id } = await h.createApplication('salesA');
      const res = await submit(id).expect(200);

      expect(await actionsOf(id)).toEqual([
        AuditAction.APPLICATION_CREATED,
        AuditAction.APPLICATION_SUBMITTED,
        AuditAction.RISK_REVIEW_FAILED,
      ]);
      const failed = (await rowsOf(id))[2];
      expect(failed.metadata).toEqual({
        run: 1,
        code: 'ENQUEUE_FAILED',
        attempts: 0,
      });
      expect(failed.actorId).toBeNull();
      expect(failed.correlationId).toBe(res.headers['x-request-id']);
    });
  });

  describe('failed or rejected requests write nothing', () => {
    it.each([
      [
        'a validation error (400)',
        (id: string) =>
          h
            .as('salesA')
            .patch(`/applications/${id}`)
            .send({ ownerEmail: 'nope' }),
        400,
      ],
      [
        'a foreign application (404)',
        (id: string) =>
          h
            .as('salesB')
            .patch(`/applications/${id}`)
            .send({ businessName: 'x' }),
        404,
      ],
      [
        'a forbidden role (403)',
        (id: string) =>
          h.as('rev1').patch(`/applications/${id}`).send({ businessName: 'x' }),
        403,
      ],
      [
        'an invalid transition (409)',
        (id: string) =>
          h
            .as('salesA')
            .post(`/applications/${id}/assign`)
            .send({ reviewerId: h.users.rev1.id }),
        403,
      ],
    ])('%s', async (_name, request, expectedStatus) => {
      const { id } = await h.createApplication('salesA');
      const before = await actionsOf(id);

      await request(id).expect(expectedStatus);

      expect(await actionsOf(id)).toEqual(before);
    });

    it('a double submit leaves exactly one APPLICATION_SUBMITTED', async () => {
      const { id } = await h.createApplication('salesA');
      await submit(id).expect(200);
      await submit(id).expect(409);
      await waitForRisk(id, RiskStatus.COMPLETED);
      expect(await countOf(id, AuditAction.APPLICATION_SUBMITTED)).toBe(1);
    });

    it('five simultaneous submits leave exactly one row: the losers roll back with nothing orphaned', async () => {
      const { id } = await h.createApplication('salesA');
      const results = await Promise.all(
        Array.from({ length: 5 }, () => submit(id)),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);

      await waitForRisk(id, RiskStatus.COMPLETED);
      expect(await countOf(id, AuditAction.APPLICATION_SUBMITTED)).toBe(1);
      expect(await countOf(id, AuditAction.RISK_REVIEW_STARTED)).toBe(1);
    });

    it('an update that raced a submit and lost writes no audit row', async () => {
      const { id } = await h.createApplication('salesA');
      await submit(id).expect(200);
      await h
        .as('salesA')
        .patch(`/applications/${id}`)
        .send({ businessName: 'late' })
        .expect(409);
      expect(await countOf(id, AuditAction.APPLICATION_UPDATED)).toBe(0);
    });
  });

  describe('same transaction: the change and its audit row stand or fall together', () => {
    it('if writing the audit row fails, the change is rolled back (create)', async () => {
      const name = `Rollback Cafe ${randomUUID()}`;
      jest
        .spyOn(auditService, 'record')
        .mockRejectedValueOnce(new Error('audit table unavailable'));

      const res = await h
        .as('salesA')
        .post('/applications')
        .send({ ...validApplicationPayload, businessName: name })
        .expect(500);

      expect(res.body.message).toBe('Internal server error'); // no leak of the cause
      expect(JSON.stringify(res.body)).not.toContain('audit table unavailable');
      expect(await h.apps().countBy({ businessName: name })).toBe(0);
    });

    it('if writing the audit row fails, the change is rolled back and no job is queued (submit)', async () => {
      const { id } = await h.createApplication('salesA');
      jest
        .spyOn(auditService, 'record')
        .mockRejectedValueOnce(new Error('audit table unavailable'));

      await submit(id).expect(500);

      const after = await app(id);
      expect(after.status).toBe(ApplicationStatus.DRAFT);
      expect(after.riskStatus).toBe(RiskStatus.NOT_STARTED);
      expect(after.riskReviewRun).toBe(0);
      expect(after.submittedAt).toBeNull();
      expect(await countOf(id, AuditAction.APPLICATION_SUBMITTED)).toBe(0);
      expect(await h.queue.getJob(`risk-review-${id}-1`)).toBeUndefined();
      expect(provider.callsFor(id)).toHaveLength(0);

      // nothing is stuck: the same request works afterwards
      await submit(id).expect(200);
    });

    it('if something fails AFTER the audit row was written, that row is rolled back too (no orphan)', async () => {
      const { id } = await h.createApplication('salesA');
      const real = auditService.record.bind(auditService);
      jest
        .spyOn(auditService, 'record')
        .mockImplementationOnce(async (event, manager) => {
          await real(event, manager); // the audit row IS inserted...
          throw new Error('failure after the audit insert'); // ...then the transaction fails
        });

      await submit(id).expect(500);

      expect(await countOf(id, AuditAction.APPLICATION_SUBMITTED)).toBe(0); // no orphan row
      expect((await app(id)).status).toBe(ApplicationStatus.DRAFT); // and no change
    });

    it('the same holds for assign and decision', async () => {
      const { id } = await h.createApplication('salesA');
      await submit(id).expect(200);
      await waitForRisk(id, RiskStatus.COMPLETED);

      const real = auditService.record.bind(auditService);
      const failAfterInsert = () =>
        jest
          .spyOn(auditService, 'record')
          .mockImplementationOnce(async (event, manager) => {
            await real(event, manager);
            throw new Error('boom');
          });

      failAfterInsert();
      await h
        .as('admin')
        .post(`/applications/${id}/assign`)
        .send({ reviewerId: h.users.rev1.id })
        .expect(500);
      expect((await app(id)).status).toBe(ApplicationStatus.SUBMITTED);
      expect(await countOf(id, AuditAction.REVIEWER_ASSIGNED)).toBe(0);

      await h
        .as('admin')
        .post(`/applications/${id}/assign`)
        .send({ reviewerId: h.users.rev1.id })
        .expect(200);

      failAfterInsert();
      await h
        .as('rev1')
        .post(`/applications/${id}/decision`)
        .send({ decision: 'APPROVED' })
        .expect(500);
      expect((await app(id)).status).toBe(ApplicationStatus.IN_REVIEW);
      expect(await countOf(id, AuditAction.DECISION_RECORDED)).toBe(0);
    });
  });

  describe('login events', () => {
    const attempt = (email: string, password: string) =>
      h.http().post('/auth/login').send({ email, password });
    const lastLoginRow = async (action: AuditAction, actorId: string | null) =>
      (
        await logs().find({
          where: actorId ? { action, actorId } : { action },
          order: { createdAt: 'DESC' },
          take: 1,
        })
      )[0];

    it('LOGIN_SUCCEEDED for the user, correlated to the request, with no token or password', async () => {
      const res = await attempt(h.users.salesB.email, E2E_PASSWORD).expect(200);

      const row = await lastLoginRow(
        AuditAction.LOGIN_SUCCEEDED,
        h.users.salesB.id,
      );
      expect(row).toMatchObject({
        actorId: h.users.salesB.id,
        actorRole: 'SALES',
        entityType: 'User',
        entityId: h.users.salesB.id,
        correlationId: res.headers['x-request-id'],
      });
      const json = JSON.stringify(row);
      expect(json).not.toContain(E2E_PASSWORD);
      expect(json).not.toContain(res.body.accessToken);
    });

    it('LOGIN_FAILED (BAD_PASSWORD) against the targeted account; the password is not recorded', async () => {
      const res = await attempt(h.users.salesB.email, 'Wrong-Guess-123').expect(
        401,
      );

      const row = await lastLoginRow(
        AuditAction.LOGIN_FAILED,
        h.users.salesB.id,
      );
      expect(row.metadata.reason).toBe('BAD_PASSWORD');
      expect(row.correlationId).toBe(res.headers['x-request-id']);
      expect(JSON.stringify(row)).not.toContain('Wrong-Guess-123');
      // the email is masked even in the failure record
      expect(JSON.stringify(row.metadata)).not.toContain(h.users.salesB.email);
    });

    it('LOGIN_FAILED (UNKNOWN_EMAIL) has no actor and no entity, and the client cannot tell it apart', async () => {
      const known = await attempt(
        h.users.salesB.email,
        'Wrong-Guess-123',
      ).expect(401);
      const unknown = await attempt(
        'nobody-at-all@example.com',
        'Wrong-Guess-123',
      ).expect(401);

      // same client-visible answer for both
      for (const key of ['statusCode', 'error', 'message']) {
        expect(unknown.body[key]).toEqual(known.body[key]);
      }

      const row = (
        await logs().find({ where: { correlationId: unknown.body.requestId } })
      )[0];
      expect(row).toMatchObject({
        action: AuditAction.LOGIN_FAILED,
        actorId: null,
        actorRole: null,
        entityType: 'User',
        entityId: null,
      });
      expect(row.metadata.reason).toBe('UNKNOWN_EMAIL');
      expect(JSON.stringify(row.metadata)).not.toContain(
        'nobody-at-all@example.com',
      );
    });

    it('LOGIN_FAILED (INACTIVE_USER) even with the correct password', async () => {
      await h.ds
        .getRepository(User)
        .update({ id: h.users.rev2.id }, { isActive: false });
      try {
        await attempt(h.users.rev2.email, E2E_PASSWORD).expect(401);
        const row = await lastLoginRow(
          AuditAction.LOGIN_FAILED,
          h.users.rev2.id,
        );
        expect(row.metadata.reason).toBe('INACTIVE_USER');
      } finally {
        await h.ds
          .getRepository(User)
          .update({ id: h.users.rev2.id }, { isActive: true });
      }
    });

    it('one attempt writes exactly one row', async () => {
      const before = await logs().count({
        where: { actorId: h.users.salesB.id },
      });
      await attempt(h.users.salesB.email, E2E_PASSWORD).expect(200);
      await attempt(h.users.salesB.email, 'nope-nope-nope').expect(401);
      expect(
        await logs().count({ where: { actorId: h.users.salesB.id } }),
      ).toBe(before + 2);
    });

    it('the /auth/me lookup is not audited', async () => {
      const before = await logs().count({
        where: { actorId: h.users.salesA.id },
      });
      await h.as('salesA').get('/auth/me').expect(200);
      expect(
        await logs().count({ where: { actorId: h.users.salesA.id } }),
      ).toBe(before);
    });
  });

  describe('append-only at the database', () => {
    let row: AuditLog;

    beforeAll(async () => {
      const { id } = await h.createApplication('salesA');
      row = (await rowsOf(id))[0];
    });

    it('rejects UPDATE, and the row is unchanged', async () => {
      await expect(
        h.ds.query(`UPDATE audit_logs SET action = 'TAMPERED' WHERE id = $1`, [
          row.id,
        ]),
      ).rejects.toThrow(/append-only/);
      expect((await logs().findOneByOrFail({ id: row.id })).action).toBe(
        row.action,
      );
    });

    it('rejects rewriting the metadata or the actor', async () => {
      await expect(
        h.ds.query(
          `UPDATE audit_logs SET metadata = '{}'::jsonb, "actorId" = NULL WHERE id = $1`,
          [row.id],
        ),
      ).rejects.toThrow(/append-only/);
    });

    it('rejects DELETE, and the row survives', async () => {
      await expect(
        h.ds.query(`DELETE FROM audit_logs WHERE id = $1`, [row.id]),
      ).rejects.toThrow(/append-only/);
      expect(await logs().countBy({ id: row.id })).toBe(1);
    });

    it('also rejects a bulk UPDATE or DELETE touching many rows', async () => {
      await expect(
        h.ds.query(`UPDATE audit_logs SET "correlationId" = 'x'`),
      ).rejects.toThrow(/append-only/);
      await expect(h.ds.query(`DELETE FROM audit_logs`)).rejects.toThrow(
        /append-only/,
      );
    });

    it('is not circumvented through the ORM either', async () => {
      await expect(
        logs().update({ id: row.id }, { action: 'TAMPERED' }),
      ).rejects.toThrow(/append-only/);
      await expect(logs().delete({ id: row.id })).rejects.toThrow(
        /append-only/,
      );
    });

    it('allows inserts, and the maintenance flag only inside a transaction that sets it', async () => {
      await auditService.record({
        action: AuditAction.APPLICATION_UPDATED,
        actor: null,
        entityType: 'Probe',
        entityId: null,
        metadata: { probe: true },
        correlationId: 'e2e-maintenance-probe',
      });

      // without the flag: blocked. SET LOCAL ends with the transaction, so the flag cannot leak.
      await h.ds.transaction(async (m) => {
        await m.query(`SET LOCAL app.audit_maintenance = 'on'`);
        await m.query(
          `DELETE FROM audit_logs WHERE "correlationId" = 'e2e-maintenance-probe'`,
        );
      });
      expect(
        await logs().countBy({ correlationId: 'e2e-maintenance-probe' }),
      ).toBe(0);
      await expect(
        h.ds.query(`DELETE FROM audit_logs WHERE id = $1`, [row.id]),
      ).rejects.toThrow(/append-only/);
    });
  });

  describe('GET /applications/:id/audit', () => {
    let id: string;

    beforeAll(async () => {
      id = (await h.createApplication('salesA')).id;
      await h
        .as('salesA')
        .patch(`/applications/${id}`)
        .send({ businessName: 'Trail Cafe' })
        .expect(200);
      await submit(id).expect(200);
      await waitForRisk(id, RiskStatus.COMPLETED);
      await waitForAction(id, AuditAction.RISK_REVIEW_COMPLETED);
      await h
        .as('admin')
        .post(`/applications/${id}/assign`)
        .send({ reviewerId: h.users.rev1.id })
        .expect(200);
      await h
        .as('rev1')
        .post(`/applications/${id}/decision`)
        .send({ decision: 'APPROVED' })
        .expect(200);
    });

    it('returns the whole history, oldest first', async () => {
      const res = await h
        .as('admin')
        .get(`/applications/${id}/audit`)
        .expect(200);
      expect(res.body).toMatchObject({ total: 7, page: 1, limit: 20 });
      expect(res.body.items.map((i: { action: string }) => i.action)).toEqual([
        'APPLICATION_CREATED',
        'APPLICATION_UPDATED',
        'APPLICATION_SUBMITTED',
        'RISK_REVIEW_STARTED',
        'RISK_REVIEW_COMPLETED',
        'REVIEWER_ASSIGNED',
        'DECISION_RECORDED',
      ]);
      const times = res.body.items.map(
        (i: { createdAt: string }) => +new Date(i.createdAt),
      );
      expect(times).toEqual([...times].sort((a, b) => a - b));
    });

    it('exposes exactly the documented fields', async () => {
      const res = await h
        .as('admin')
        .get(`/applications/${id}/audit`)
        .expect(200);
      for (const item of res.body.items) {
        expect(Object.keys(item).sort()).toEqual(
          [
            'action',
            'actorId',
            'actorRole',
            'correlationId',
            'createdAt',
            'entityId',
            'entityType',
            'id',
            'metadata',
          ].sort(),
        );
        expect(item.entityId).toBe(id);
      }
    });

    it('only contains rows of this application', async () => {
      const other = (await h.createApplication('salesA')).id;
      const res = await h
        .as('admin')
        .get(`/applications/${other}/audit`)
        .expect(200);
      expect(res.body.total).toBe(1);
      expect(
        res.body.items.every((i: { entityId: string }) => i.entityId === other),
      ).toBe(true);
    });

    it('paginates with a stable order and total', async () => {
      const p1 = await h
        .as('admin')
        .get(`/applications/${id}/audit?page=1&limit=3`)
        .expect(200);
      const p2 = await h
        .as('admin')
        .get(`/applications/${id}/audit?page=2&limit=3`)
        .expect(200);
      const p3 = await h
        .as('admin')
        .get(`/applications/${id}/audit?page=3&limit=3`)
        .expect(200);
      const p4 = await h
        .as('admin')
        .get(`/applications/${id}/audit?page=4&limit=3`)
        .expect(200);

      expect([p1, p2, p3].map((p) => p.body.items.length)).toEqual([3, 3, 1]);
      expect(p1.body).toMatchObject({ total: 7, page: 1, limit: 3 });
      expect(p4.body.items).toEqual([]); // past the end: empty, not an error
      const ids = [p1, p2, p3].flatMap((p) =>
        p.body.items.map((i: { id: string }) => i.id),
      );
      expect(new Set(ids).size).toBe(7);
    });

    it('is ADMIN-only: not the owner, not even the assigned reviewer, not anonymous', async () => {
      await h.as('salesA').get(`/applications/${id}/audit`).expect(403);
      await h.as('salesB').get(`/applications/${id}/audit`).expect(403);
      await h.as('rev1').get(`/applications/${id}/audit`).expect(403);
      await h.as('rev2').get(`/applications/${id}/audit`).expect(403);
      await h.http().get(`/applications/${id}/audit`).expect(401);
    });

    it('returns 404 for an unknown application and 400 for a malformed id or query', async () => {
      await h
        .as('admin')
        .get(`/applications/${randomUUID()}/audit`)
        .expect(404);
      await h.as('admin').get('/applications/not-a-uuid/audit').expect(400);
      await h
        .as('admin')
        .get(`/applications/${id}/audit?limit=101`)
        .expect(400);
      await h.as('admin').get(`/applications/${id}/audit?page=0`).expect(400);
    });
  });

  describe('no secret ever reaches the trail', () => {
    it('after a full lifecycle full of secrets, no audit row contains any of them', async () => {
      // Self-contained: this test does not depend on what other tests ran
      // before it (Jest may reorder them); it creates its own varied activity.
      const secretEmail = 'sweep-owner@example.com';
      const secretTaxId = '777-666-555';
      const secretPhoneDigits = '9812345678';
      const wrongGuess = 'Sweep-Wrong-Guess-1';

      provider.handler = () => Promise.resolve(okAssessment(30));
      const { id } = await h.createApplication('salesA', {
        ownerEmail: secretEmail,
        ownerTaxId: secretTaxId,
        ownerPhone: `+977 ${secretPhoneDigits}`,
      });
      await h
        .as('salesA')
        .patch(`/applications/${id}`)
        .send({
          ownerTaxId: '555-444-333',
          ownerEmail: 'sweep-new@example.com',
        })
        .expect(200);
      await submit(id).expect(200);
      await waitForRisk(id, RiskStatus.COMPLETED);
      await h
        .as('admin')
        .post(`/applications/${id}/assign`)
        .send({ reviewerId: h.users.rev1.id })
        .expect(200);
      await h
        .as('rev1')
        .post(`/applications/${id}/decision`)
        .send({
          decision: 'REJECTED',
          reason: `Call ${secretEmail} or +977 ${secretPhoneDigits}`,
        })
        .expect(200);
      await h
        .http()
        .post('/auth/login')
        .send({ email: h.users.salesA.email, password: wrongGuess })
        .expect(401);
      await h
        .http()
        .post('/auth/login')
        .send({ email: 'sweep-ghost@example.com', password: wrongGuess })
        .expect(401);

      // The database belongs to this test file alone, so sweep every row in it.
      const rows = await h.ds.query('SELECT * FROM audit_logs');
      expect(rows.length).toBeGreaterThan(10); // this test alone writes more than that

      const hashes: { passwordHash: string }[] = await h.ds.query(
        'SELECT "passwordHash" FROM users',
      );
      const secrets = [
        E2E_PASSWORD,
        wrongGuess,
        ...Object.values(h.tokens),
        ...hashes.map((x) => x.passwordHash),
        validApplicationPayload.ownerTaxId,
        secretTaxId,
        '555-444-333',
        secretEmail,
        'sweep-new@example.com',
        'sweep-ghost@example.com',
        secretPhoneDigits,
        'pat@example.com',
        '9876543210',
        '999-888-777',
        'new@example.com',
        'audit table unavailable',
      ];
      const dump = JSON.stringify(rows);
      for (const secret of secrets) {
        expect(dump).not.toContain(secret);
      }
    });
  });
});
