import './helpers/enable-risk-worker';
import { randomUUID } from 'crypto';
import { ApplicationStatus } from '../src/applications/enums/application-status.enum';
import { RiskStatus } from '../src/applications/enums/risk-status.enum';
import { RiskReviewService } from '../src/risk-review/risk-review.service';
import { riskReviewJobId } from '../src/risk-review/risk-review.types';
import {
  createHarness,
  Harness,
  validApplicationPayload,
  waitFor,
} from './helpers/e2e-harness';
import {
  deferred,
  okAssessment,
  permanentFailure,
  ScriptedRiskProvider,
  transientFailure,
} from './helpers/fake-risk-provider';
import { RiskAssessment } from '../src/risk-review/risk-provider';

/**
 * Real BullMQ worker + Redis + Postgres. Only the third-party provider is
 * replaced (ScriptedRiskProvider) so tests can force failures and hold jobs
 * mid-flight. Queue backoff is 50ms (see setup-env.ts), attempts = 3.
 */
describe('Async risk review (e2e)', () => {
  const provider = new ScriptedRiskProvider();
  let h: Harness;
  const held: Array<() => void> = [];

  beforeAll(async () => {
    h = await createHarness({ riskProvider: provider });
  });
  afterAll(() => h.close());

  beforeEach(() => provider.reset());
  afterEach(async () => {
    // Never leave a job blocked: app.close() waits for active jobs.
    held.splice(0).forEach((release) => release());
    // Background work must not leak into the next test: a late provider call or
    // audit write from this test's application would pollute its assertions.
    await waitFor(
      async () => {
        const c = await h.queue.getJobCounts('active', 'waiting', 'delayed');
        return c.active + c.waiting + c.delayed === 0;
      },
      { what: 'the risk-review queue to go idle' },
    );
    jest.restoreAllMocks();
  });

  const row = (id: string) => h.apps().findOneByOrFail({ id });
  const waitForRisk = (id: string, status: RiskStatus) =>
    waitFor(
      async () => {
        const r = await row(id);
        return r.riskStatus === status ? r : false;
      },
      { what: `risk status ${status} for ${id}` },
    );
  const submit = (id: string, who: 'salesA' | 'admin' = 'salesA') =>
    h.as(who).post(`/applications/${id}/submit`);
  const submitted = async () => {
    const { id } = await h.createApplication('salesA');
    await submit(id).expect(200);
    return id;
  };
  /** Blocks every provider call until released; returns the release function. */
  const holdProvider = (score = 42) => {
    const gate = deferred<RiskAssessment>();
    provider.handler = () => gate.promise;
    const release = () => gate.resolve(okAssessment(score));
    held.push(release);
    return release;
  };
  /** An application in a state where a risk review can run, set up directly. */
  const seedPending = async (run = 1) => {
    const { id } = await h.createApplication('salesA');
    await h.apps().update(
      { id },
      {
        status: ApplicationStatus.SUBMITTED,
        riskStatus: RiskStatus.PENDING,
        riskReviewRun: run,
      },
    );
    return id;
  };
  const seedFailed = async () => {
    const id = await seedPending();
    await h.apps().update(
      { id },
      {
        riskStatus: RiskStatus.FAILED,
        riskResult: { failure: { code: 'PROVIDER_UNAVAILABLE', attempts: 3 } },
      },
    );
    return id;
  };

  describe('submit starts a background review', () => {
    it('returns immediately with PENDING while the provider is still working, then completes', async () => {
      const release = holdProvider(37);
      const { id } = await h.createApplication('salesA');

      const res = await submit(id).expect(200);
      expect(res.body).toMatchObject({
        status: 'SUBMITTED',
        riskStatus: 'PENDING',
      });

      // the provider has been called but not answered: the request did not wait for it
      await waitFor(async () => provider.callsFor(id).length === 1, {
        what: 'provider to be called',
      });
      expect((await row(id)).riskStatus).toBe(RiskStatus.PENDING);

      release();
      const done = await waitForRisk(id, RiskStatus.COMPLETED);
      expect(done.riskScore).toBe(37);
      expect(done.riskResult).toEqual(okAssessment(37));
      expect(done.riskReviewRun).toBe(1);
      expect(done.status).toBe(ApplicationStatus.SUBMITTED);
    });

    it('calls the provider once, with business facts only (no owner PII or tax id)', async () => {
      const id = await submitted();
      await waitForRisk(id, RiskStatus.COMPLETED);

      expect(provider.callsFor(id)).toHaveLength(1);
      const sent = provider.callsFor(id)[0];
      expect(sent).toEqual({
        applicationId: id,
        idempotencyKey: riskReviewJobId(id, 1),
        businessType: validApplicationPayload.businessType,
        monthlyVolume: '25000.00',
        averageTicketSize: '42.50',
        currency: 'USD',
      });
      const json = JSON.stringify(sent);
      for (const pii of [
        validApplicationPayload.ownerEmail,
        validApplicationPayload.ownerName,
        validApplicationPayload.ownerTaxId,
        '9876543210',
      ]) {
        expect(json).not.toContain(pii);
      }
    });

    it('puts only ids in the job payload', async () => {
      holdProvider();
      const id = await submitted();
      const job = await waitFor(() => h.queue.getJob(riskReviewJobId(id, 1)), {
        what: 'job to exist',
      });

      expect(Object.keys(job.data).sort()).toEqual(['applicationId', 'run']);
      expect(job.data).toEqual({ applicationId: id, run: 1 });
      const json = JSON.stringify(job.data);
      expect(json).not.toContain(validApplicationPayload.ownerEmail);
      expect(json).not.toContain(validApplicationPayload.businessName);
    });

    it('works for an admin submitting on behalf of the owner', async () => {
      const { id } = await h.createApplication('salesA');
      await submit(id, 'admin').expect(200);
      await waitForRisk(id, RiskStatus.COMPLETED);
    });
  });

  describe('who sees the risk details', () => {
    it('shows riskResult to ADMIN and the assigned REVIEWER on the detail view, never to the sales user, never in lists', async () => {
      const id = await submitted();
      await waitForRisk(id, RiskStatus.COMPLETED);
      await h
        .as('admin')
        .post(`/applications/${id}/assign`)
        .send({ reviewerId: h.users.rev1.id })
        .expect(200);

      const asAdmin = await h
        .as('admin')
        .get(`/applications/${id}`)
        .expect(200);
      const asReviewer = await h
        .as('rev1')
        .get(`/applications/${id}`)
        .expect(200);
      const asSales = await h
        .as('salesA')
        .get(`/applications/${id}`)
        .expect(200);

      expect(asAdmin.body.riskResult).toEqual(okAssessment());
      expect(asReviewer.body.riskResult).toEqual(okAssessment());
      expect(asSales.body.riskScore).toBe(42); // the score is visible to the applicant...
      expect(asSales.body).not.toHaveProperty('riskResult'); // ...the internals are not

      const list = await h
        .as('salesA')
        .get('/applications?limit=100')
        .expect(200);
      for (const item of list.body.items) {
        expect(item).not.toHaveProperty('riskResult');
      }
    });
  });

  describe('retries with backoff', () => {
    it('retries a transient failure and completes when the provider recovers', async () => {
      provider.handler = async (_input, n) => {
        if (n <= 2) throw transientFailure();
        return okAssessment(55);
      };
      const id = await submitted();

      const done = await waitForRisk(id, RiskStatus.COMPLETED);

      expect(provider.callsFor(id)).toHaveLength(3);
      expect(done.riskScore).toBe(55);
    });

    it('stays PENDING while retries remain and only becomes FAILED after the final attempt', async () => {
      const seenDuringAttempts: RiskStatus[] = [];
      provider.handler = async (input) => {
        seenDuringAttempts.push((await row(input.applicationId)).riskStatus);
        throw transientFailure();
      };
      const id = await submitted();

      const failed = await waitForRisk(id, RiskStatus.FAILED);

      expect(provider.callsFor(id)).toHaveLength(3); // attempts = 3, no more
      expect(seenDuringAttempts).toEqual([
        RiskStatus.PENDING,
        RiskStatus.PENDING,
        RiskStatus.PENDING,
      ]);
      expect(failed.riskScore).toBeNull();
      expect(failed.riskResult).toEqual({
        failure: { code: 'PROVIDER_UNAVAILABLE', attempts: 3 },
      });
    });

    it('keeps the exhausted job in Redis for inspection', async () => {
      provider.handler = () => Promise.reject(transientFailure());
      const id = await submitted();
      await waitForRisk(id, RiskStatus.FAILED);

      const job = await waitFor(
        async () => {
          const failedJobs = await h.queue.getFailed();
          return failedJobs.find((j) => j.id === riskReviewJobId(id, 1));
        },
        { what: 'failed job to be retained' },
      );
      expect(job.failedReason).toContain('provider unavailable');
      expect(job.attemptsMade).toBe(3);
    });

    it('does not retry a permanent failure', async () => {
      provider.handler = () => Promise.reject(permanentFailure());
      const id = await submitted();

      const failed = await waitForRisk(id, RiskStatus.FAILED);

      expect(provider.callsFor(id)).toHaveLength(1);
      expect(failed.riskResult).toEqual({
        failure: { code: 'INPUT_REJECTED', attempts: 1 },
      });
    });

    it('stores no raw error text from the provider', async () => {
      provider.handler = () =>
        Promise.reject(
          Object.assign(transientFailure(), {
            message: 'SECRET detail: key=abc123',
          }),
        );
      const id = await submitted();
      const failed = await waitForRisk(id, RiskStatus.FAILED);
      expect(JSON.stringify(failed.riskResult)).not.toContain('abc123');
    });
  });

  describe('idempotency', () => {
    it('ignores a duplicate enqueue for the same run: one job, one provider call', async () => {
      const release = holdProvider();
      const id = await seedPending(1);
      const reviews = h.app.get(RiskReviewService);

      await reviews.enqueue(id, 1);
      await reviews.enqueue(id, 1);
      await reviews.enqueue(id, 1);

      const jobs = await h.queue.getJobs(['waiting', 'active', 'delayed']);
      expect(jobs.filter((j) => j.id === riskReviewJobId(id, 1))).toHaveLength(
        1,
      );

      release();
      await waitForRisk(id, RiskStatus.COMPLETED);
      expect(provider.callsFor(id)).toHaveLength(1);
    });

    it('re-running a job that already completed does nothing', async () => {
      const id = await submitted();
      const done = await waitForRisk(id, RiskStatus.COMPLETED);
      expect(provider.callsFor(id)).toHaveLength(1);

      // a duplicate delivery of the same work, under a different job id
      // removeOnComplete: false so the test can read the job's result.
      const dup = await h.queue.add(
        'assess',
        { applicationId: id, run: 1 },
        { jobId: `dup-${id}`, removeOnComplete: false },
      );
      await waitFor(
        async () => (await dup.isCompleted()) || (await dup.isFailed()),
        {
          what: 'duplicate job to finish',
        },
      );

      expect(await dup.isCompleted()).toBe(true);
      // re-read: the local `dup` object is not refreshed after processing
      const finished = await h.queue.getJob(dup.id as string);
      expect(finished?.returnvalue).toEqual({ skipped: 'not-pending' });
      expect(provider.callsFor(id)).toHaveLength(1);
      const after = await row(id);
      expect(after.riskScore).toBe(done.riskScore);
      expect(after.riskResult).toEqual(done.riskResult);
      expect(after.updatedAt).toEqual(done.updatedAt);
    });

    it('a job whose application no longer exists finishes quietly', async () => {
      const orphanId = randomUUID();
      const job = await h.queue.add(
        'assess',
        { applicationId: orphanId, run: 1 },
        { removeOnComplete: false },
      );
      await waitFor(async () => job.isCompleted(), {
        what: 'orphan job to finish',
      });

      const finished = await h.queue.getJob(job.id as string);
      expect(finished?.returnvalue).toEqual({ skipped: 'application-missing' });
      expect(provider.callsFor(orphanId)).toHaveLength(0);
    });

    it('a stale job can never overwrite the result of a newer submission', async () => {
      // Run 1 is in flight and slow...
      const gate1 = deferred<RiskAssessment>();
      held.push(() => gate1.resolve(okAssessment(11)));
      provider.handler = (_input, n) =>
        n === 1 ? gate1.promise : Promise.resolve(okAssessment(22));

      const id = await seedPending(1);
      await h.app.get(RiskReviewService).enqueue(id, 1);
      await waitFor(async () => provider.callsFor(id).length === 1, {
        what: 'run 1 to reach the provider',
      });

      // ...meanwhile the application is sent back and resubmitted: run 2.
      await h
        .apps()
        .update({ id }, { status: ApplicationStatus.INFO_REQUESTED });
      await submit(id).expect(200);
      const second = await waitForRisk(id, RiskStatus.COMPLETED);
      expect(second.riskReviewRun).toBe(2);
      expect(second.riskScore).toBe(22);

      // Now the slow, stale run 1 finally answers.
      gate1.resolve(okAssessment(11));
      await waitFor(
        async () => {
          const counts = await h.queue.getJobCounts(
            'active',
            'waiting',
            'delayed',
          );
          return counts.active + counts.waiting + counts.delayed === 0;
        },
        { what: 'queue to drain' },
      );

      const final = await row(id);
      expect(final.riskScore).toBe(22);
      expect(final.riskResult).toEqual(okAssessment(22));
      expect(final.riskReviewRun).toBe(2);
    });
  });

  describe('POST /applications/:id/risk-review/retry', () => {
    it('lets an ADMIN restart a failed review, which then completes', async () => {
      const id = await seedFailed();
      provider.handler = () => Promise.resolve(okAssessment(64));

      const res = await h
        .as('admin')
        .post(`/applications/${id}/risk-review/retry`)
        .expect(202);
      expect(res.body.riskStatus).toBe('PENDING');
      expect(res.body.riskScore).toBeNull();

      const done = await waitForRisk(id, RiskStatus.COMPLETED);
      expect(done.riskReviewRun).toBe(2);
      expect(done.riskScore).toBe(64);
      expect(provider.callsFor(id)).toHaveLength(1);
    });

    it('works while the application is IN_REVIEW', async () => {
      const id = await seedFailed();
      await h.apps().update(
        { id },
        {
          status: ApplicationStatus.IN_REVIEW,
          assignedReviewerId: h.users.rev1.id,
        },
      );
      await h
        .as('admin')
        .post(`/applications/${id}/risk-review/retry`)
        .expect(202);
      await waitForRisk(id, RiskStatus.COMPLETED);
    });

    it('is ADMIN-only and needs a token', async () => {
      const id = await seedFailed();
      await h
        .as('salesA')
        .post(`/applications/${id}/risk-review/retry`)
        .expect(403);
      await h
        .as('rev1')
        .post(`/applications/${id}/risk-review/retry`)
        .expect(403);
      await h.http().post(`/applications/${id}/risk-review/retry`).expect(401);
      expect((await row(id)).riskStatus).toBe(RiskStatus.FAILED);
      expect(provider.callsFor(id)).toHaveLength(0);
    });

    it.each([RiskStatus.NOT_STARTED, RiskStatus.PENDING, RiskStatus.COMPLETED])(
      'returns 409 when the review is %s, not FAILED',
      async (riskStatus) => {
        const id = await seedPending();
        await h.apps().update({ id }, { riskStatus });
        const res = await h
          .as('admin')
          .post(`/applications/${id}/risk-review/retry`)
          .expect(409);
        expect(res.body.details).toMatchObject({ riskStatus });
        expect(provider.callsFor(id)).toHaveLength(0);
      },
    );

    it('returns 409 for a failed review on an application that is no longer submitted', async () => {
      const id = await seedFailed();
      await h.apps().update({ id }, { status: ApplicationStatus.REJECTED });
      await h
        .as('admin')
        .post(`/applications/${id}/risk-review/retry`)
        .expect(409);
    });

    it('returns 404 for an unknown id and 400 for a malformed one', async () => {
      await h
        .as('admin')
        .post(`/applications/${randomUUID()}/risk-review/retry`)
        .expect(404);
      await h
        .as('admin')
        .post('/applications/nope/risk-review/retry')
        .expect(400);
    });

    it('lets exactly one of several simultaneous retries through', async () => {
      const id = await seedFailed();
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          h.as('admin').post(`/applications/${id}/risk-review/retry`),
        ),
      );
      const codes = results.map((r) => r.status);
      expect(codes.filter((c) => c === 202)).toHaveLength(1);
      expect(codes.filter((c) => c === 409)).toHaveLength(4);

      const done = await waitForRisk(id, RiskStatus.COMPLETED);
      expect(done.riskReviewRun).toBe(2);
      expect(provider.callsFor(id)).toHaveLength(1);
    });
  });

  describe('when the queue itself is unavailable', () => {
    it('submit still succeeds, the review is marked FAILED, and an admin can retry it', async () => {
      jest
        .spyOn(h.queue, 'add')
        .mockRejectedValueOnce(new Error('redis is down'));
      const { id } = await h.createApplication('salesA');

      const res = await submit(id).expect(200);
      expect(res.body).toMatchObject({
        status: 'SUBMITTED',
        riskStatus: 'FAILED',
      });
      const failed = await row(id);
      expect(failed.riskResult).toEqual({
        failure: { code: 'ENQUEUE_FAILED', attempts: 0 },
      });
      expect(provider.callsFor(id)).toHaveLength(0);

      // the queue is back
      await h
        .as('admin')
        .post(`/applications/${id}/risk-review/retry`)
        .expect(202);
      const done = await waitForRisk(id, RiskStatus.COMPLETED);
      expect(done.riskReviewRun).toBe(2);
    });

    it('a retry that cannot be queued answers 503 and leaves the review FAILED (still retryable)', async () => {
      const id = await seedFailed();
      jest
        .spyOn(h.queue, 'add')
        .mockRejectedValueOnce(new Error('redis is down'));

      const res = await h
        .as('admin')
        .post(`/applications/${id}/risk-review/retry`)
        .expect(503);
      expect(res.body.message).toMatch(/could not be queued/);
      expect((await row(id)).riskStatus).toBe(RiskStatus.FAILED);

      await h
        .as('admin')
        .post(`/applications/${id}/risk-review/retry`)
        .expect(202);
      await waitForRisk(id, RiskStatus.COMPLETED);
    });
  });

  describe('worker concurrency', () => {
    it('processes several reviews at the same time (RISK_REVIEW_CONCURRENCY=5)', async () => {
      const release = holdProvider();
      const ids: string[] = [];
      for (let i = 0; i < 5; i++)
        ids.push((await h.createApplication('salesA')).id);
      await Promise.all(ids.map((id) => submit(id).expect(200)));

      // all five are inside the provider at once, none has been answered
      await waitFor(async () => provider.calls.length === 5, {
        what: 'five concurrent provider calls',
      });
      for (const id of ids) {
        expect((await row(id)).riskStatus).toBe(RiskStatus.PENDING);
      }

      release();
      for (const id of ids) await waitForRisk(id, RiskStatus.COMPLETED);
    });
  });

  describe('the whole lifecycle with the real worker (no manual database edits)', () => {
    it('a decision is blocked until the risk review completes, then goes through', async () => {
      const release = holdProvider(20);
      const id = await submitted();
      await h
        .as('admin')
        .post(`/applications/${id}/assign`)
        .send({ reviewerId: h.users.rev1.id })
        .expect(200);

      // review still running: the reviewer cannot decide
      const blocked = await h
        .as('rev1')
        .post(`/applications/${id}/decision`)
        .send({ decision: 'APPROVED' })
        .expect(409);
      expect(blocked.body.details).toEqual({ riskStatus: 'PENDING' });

      release();
      await waitForRisk(id, RiskStatus.COMPLETED);

      // the review completed while the application was IN_REVIEW
      const decided = await h
        .as('rev1')
        .post(`/applications/${id}/decision`)
        .send({ decision: 'APPROVED' })
        .expect(200);
      expect(decided.body).toMatchObject({
        status: 'APPROVED',
        riskStatus: 'COMPLETED',
        riskScore: 20,
      });
    });

    it('a failed review blocks the decision until an admin retries it successfully', async () => {
      provider.handler = () => Promise.reject(permanentFailure());
      const id = await submitted();
      await waitForRisk(id, RiskStatus.FAILED);
      await h
        .as('admin')
        .post(`/applications/${id}/assign`)
        .send({ reviewerId: h.users.rev1.id })
        .expect(200);

      const blocked = await h
        .as('rev1')
        .post(`/applications/${id}/decision`)
        .send({ decision: 'APPROVED' })
        .expect(409);
      expect(blocked.body.details).toEqual({ riskStatus: 'FAILED' });

      provider.handler = () => Promise.resolve(okAssessment(10));
      await h
        .as('admin')
        .post(`/applications/${id}/risk-review/retry`)
        .expect(202);
      await waitForRisk(id, RiskStatus.COMPLETED);

      await h
        .as('rev1')
        .post(`/applications/${id}/decision`)
        .send({ decision: 'APPROVED' })
        .expect(200);
    });

    it('an information request restarts the whole cycle on resubmission', async () => {
      const id = await submitted();
      await waitForRisk(id, RiskStatus.COMPLETED);
      await h
        .as('admin')
        .post(`/applications/${id}/assign`)
        .send({ reviewerId: h.users.rev1.id })
        .expect(200);
      await h
        .as('rev1')
        .post(`/applications/${id}/decision`)
        .send({ decision: 'INFO_REQUESTED', reason: 'Need a licence number' })
        .expect(200);

      provider.handler = () => Promise.resolve(okAssessment(77));
      await submit(id).expect(200);
      const second = await waitForRisk(id, RiskStatus.COMPLETED);

      expect(second.riskReviewRun).toBe(2);
      expect(second.riskScore).toBe(77); // the new answer, not the old 42
      expect(provider.callsFor(id)).toHaveLength(2);
    });
  });
});
