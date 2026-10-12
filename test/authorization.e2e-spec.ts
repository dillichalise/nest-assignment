import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as jsonwebtoken from 'jsonwebtoken';
import { ConfigService } from '@nestjs/config';
import { ApplicationStatus } from '../src/applications/enums/application-status.enum';
import { RiskStatus } from '../src/applications/enums/risk-status.enum';
import { AuditLog } from '../src/audit/audit-log.entity';
import { Role } from '../src/common/enums/role.enum';
import {
  createHarness,
  Harness,
  validApplicationPayload,
} from './helpers/e2e-harness';

/**
 * AUTHORIZATION: what each kind of caller may do. This file is the place to
 * look to see that access control cannot be bypassed.
 *
 * Map from the requirements to the tests below:
 *   - SALES B cannot read / update / submit SALES A's application ..... the matrix rows for GET/PATCH/POST submit,
 *                                                                        and "B tries every verb on A's application"
 *   - SALES cannot list others' applications .......................... "lists never contain other people's applications"
 *   - SALES cannot assign or decide; REVIEWER cannot create ........... matrix rows: assign, decision, POST /applications
 *   - an unassigned REVIEWER cannot decide; the assigned one can ...... matrix row: decision; "an unassigned reviewer tries everything"
 *   - smuggled status / createdById / assignedReviewerId .............. "forbidden fields are ignored"
 *   - role and id come from the token only ............................ "identity comes from the token only"
 *   - no route can be added without an authorization decision ......... "every route has an authorization row"
 */

type Principal =
  'anonymous' | 'forged' | 'salesA' | 'salesB' | 'admin' | 'rev1' | 'rev2';
const PRINCIPALS: Principal[] = [
  'anonymous',
  'forged',
  'salesA',
  'salesB',
  'admin',
  'rev1',
  'rev2',
];

/**
 * The cast. salesA OWNS the application under test; rev1 is the ASSIGNED
 * reviewer; salesB (another sales user) and rev2 (another reviewer) are
 * outsiders; "forged" presents a token signed with the wrong secret.
 */
type State = 'DRAFT' | 'SUBMITTED' | 'IN_REVIEW' | 'FAILED_REVIEW';

interface RouteRule {
  route: string; // "METHOD /path/:id" as the API documents it
  /** The application state the endpoint needs, so an ALLOWED call really succeeds. */
  state: State;
  method: 'get' | 'post' | 'patch';
  path: (id: string) => string;
  body?: (h: Harness) => object;
  /** The status each principal must get. 401 = unauthenticated, 403 = wrong role, 404 = hidden object. */
  expected: Record<Principal, number>;
}

const ALL_OK = (status: number): Record<Principal, number> => ({
  anonymous: 401,
  forged: 401,
  salesA: status,
  salesB: status,
  admin: status,
  rev1: status,
  rev2: status,
});

export const ROUTES: RouteRule[] = [
  {
    route: 'GET /applications',
    state: 'DRAFT',
    method: 'get',
    path: () => '/applications',
    expected: ALL_OK(200), // everyone authenticated may list; WHAT they see is scoped (tested below)
  },
  {
    route: 'POST /applications',
    state: 'DRAFT',
    method: 'post',
    path: () => '/applications',
    body: () => validApplicationPayload,
    expected: {
      anonymous: 401,
      forged: 401,
      salesA: 201,
      salesB: 201,
      admin: 201,
      rev1: 403,
      rev2: 403,
    },
  },
  {
    route: 'GET /applications/:id',
    state: 'IN_REVIEW',
    method: 'get',
    path: (id) => `/applications/${id}`,
    expected: {
      anonymous: 401,
      forged: 401,
      salesA: 200,
      salesB: 404,
      admin: 200,
      rev1: 200,
      rev2: 404,
    },
  },
  {
    route: 'PATCH /applications/:id',
    state: 'DRAFT',
    method: 'patch',
    path: (id) => `/applications/${id}`,
    body: () => ({ businessName: 'Renamed' }),
    expected: {
      anonymous: 401,
      forged: 401,
      salesA: 200,
      salesB: 404,
      admin: 200,
      rev1: 403,
      rev2: 403,
    },
  },
  {
    route: 'POST /applications/:id/submit',
    state: 'DRAFT',
    method: 'post',
    path: (id) => `/applications/${id}/submit`,
    expected: {
      anonymous: 401,
      forged: 401,
      salesA: 200,
      salesB: 404,
      admin: 200,
      rev1: 403,
      rev2: 403,
    },
  },
  {
    route: 'POST /applications/:id/assign',
    state: 'SUBMITTED',
    method: 'post',
    path: (id) => `/applications/${id}/assign`,
    body: (h) => ({ reviewerId: h.users.rev1.id }),
    expected: {
      anonymous: 401,
      forged: 401,
      salesA: 403,
      salesB: 403,
      admin: 200,
      rev1: 403,
      rev2: 403,
    },
  },
  {
    route: 'POST /applications/:id/decision',
    state: 'IN_REVIEW',
    method: 'post',
    path: (id) => `/applications/${id}/decision`,
    body: () => ({ decision: 'APPROVED' }),
    // Only the ASSIGNED reviewer. ADMIN has no override. An unassigned reviewer
    // does not even learn the application exists.
    expected: {
      anonymous: 401,
      forged: 401,
      salesA: 403,
      salesB: 403,
      admin: 403,
      rev1: 200,
      rev2: 404,
    },
  },
  {
    route: 'POST /applications/:id/risk-review/retry',
    state: 'FAILED_REVIEW',
    method: 'post',
    path: (id) => `/applications/${id}/risk-review/retry`,
    expected: {
      anonymous: 401,
      forged: 401,
      salesA: 403,
      salesB: 403,
      admin: 202,
      rev1: 403,
      rev2: 403,
    },
  },
  {
    route: 'GET /applications/:id/audit',
    state: 'IN_REVIEW',
    method: 'get',
    path: (id) => `/applications/${id}/audit`,
    // ADMIN only: not the owner, not even the assigned reviewer.
    expected: {
      anonymous: 401,
      forged: 401,
      salesA: 403,
      salesB: 403,
      admin: 200,
      rev1: 403,
      rev2: 403,
    },
  },
  {
    route: 'GET /auth/me',
    state: 'DRAFT',
    method: 'get',
    path: () => '/auth/me',
    expected: ALL_OK(200),
  },
];

/** Reachable without a token on purpose. Everything else must demand one. */
const PUBLIC_ROUTES = ['GET /health', 'POST /auth/login'];

describe('Authorization (e2e)', () => {
  let h: Harness;
  let forgedToken: string;

  beforeAll(async () => {
    h = await createHarness();
    const secret = h.app.get(ConfigService).getOrThrow<string>('JWT_SECRET');
    forgedToken = jsonwebtoken.sign(
      { sub: h.users.admin.id, email: h.users.admin.email, role: Role.ADMIN },
      `${secret}-but-wrong`,
      { expiresIn: 3600 },
    );
  });
  afterAll(() => h.close());

  const send = (
    who: Principal,
    method: 'get' | 'post' | 'patch',
    url: string,
    body?: object,
  ) => {
    let req = h.http()[method](url);
    if (who === 'forged')
      req = req.set('Authorization', `Bearer ${forgedToken}`);
    else if (who !== 'anonymous')
      req = req.set('Authorization', `Bearer ${h.tokens[who]}`);
    return body ? req.send(body) : req;
  };

  /** A fresh application owned by salesA, put into the state an endpoint needs. */
  const fixture = async (state: State): Promise<string> => {
    const { id } = await h.createApplication('salesA');
    const set = (patch: object) => h.apps().update({ id }, patch);
    switch (state) {
      case 'SUBMITTED':
        await set({ status: ApplicationStatus.SUBMITTED });
        break;
      case 'IN_REVIEW':
        await set({
          status: ApplicationStatus.IN_REVIEW,
          assignedReviewerId: h.users.rev1.id,
          riskStatus: RiskStatus.COMPLETED,
          riskReviewRun: 1,
        });
        break;
      case 'FAILED_REVIEW':
        await set({
          status: ApplicationStatus.SUBMITTED,
          riskStatus: RiskStatus.FAILED,
          riskReviewRun: 1,
        });
        break;
    }
    return id;
  };

  describe('the authorization matrix: every route x every kind of caller', () => {
    describe.each(ROUTES)('$route', (rule) => {
      it.each(PRINCIPALS)('as %s', async (principal) => {
        const id = await fixture(rule.state);

        const res = await send(
          principal,
          rule.method,
          rule.path(id),
          rule.body?.(h),
        );

        expect(res.status).toBe(rule.expected[principal]);
      });
    });
  });

  describe('every route has an authorization row', () => {
    it('no endpoint can be added without deciding who may call it', () => {
      const document = SwaggerModule.createDocument(
        h.app,
        new DocumentBuilder().build(),
      );
      const exposed = Object.entries(document.paths)
        .flatMap(([path, operations]) =>
          Object.keys(operations).map(
            (method) =>
              `${method.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ':$1')}`,
          ),
        )
        .sort();
      const decided = [...ROUTES.map((r) => r.route), ...PUBLIC_ROUTES].sort();

      const missingFromMatrix = exposed.filter((r) => !decided.includes(r));
      const staleInMatrix = decided.filter((r) => !exposed.includes(r));

      expect({ missingFromMatrix, staleInMatrix }).toEqual({
        missingFromMatrix: [],
        staleInMatrix: [],
      });
    });

    it('every protected route refuses anonymous and forged callers', () => {
      for (const rule of ROUTES) {
        expect([rule.route, rule.expected.anonymous]).toEqual([
          rule.route,
          401,
        ]);
        expect([rule.route, rule.expected.forged]).toEqual([rule.route, 401]);
      }
    });

    it('the public routes are the only ones that work without a token', async () => {
      await h.http().get('/health').expect(200);
      const login = await h
        .http()
        .post('/auth/login')
        .send({ email: 'x@y.co', password: 'x' });
      expect(login.status).toBe(401); // reachable (it answered), just not successful
    });
  });

  describe("a SALES user cannot touch another SALES user's application, by any means", () => {
    it("salesB tries every verb on salesA's application: nothing changes and nothing is recorded", async () => {
      const id = await fixture('DRAFT');
      const before = await h.apps().findOneByOrFail({ id });
      const auditBefore = await h.ds
        .getRepository(AuditLog)
        .count({ where: { entityId: id } });

      const attempts = [
        send('salesB', 'get', `/applications/${id}`),
        send('salesB', 'patch', `/applications/${id}`, {
          businessName: 'Hijacked',
          ownerEmail: 'evil@example.com',
        }),
        send('salesB', 'post', `/applications/${id}/submit`),
        send('salesB', 'post', `/applications/${id}/assign`, {
          reviewerId: h.users.rev1.id,
        }),
        send('salesB', 'post', `/applications/${id}/decision`, {
          decision: 'APPROVED',
        }),
        send('salesB', 'post', `/applications/${id}/risk-review/retry`),
        send('salesB', 'get', `/applications/${id}/audit`),
      ];
      const statuses = (await Promise.all(attempts)).map((r) => r.status);

      expect(statuses.every((s) => [403, 404].includes(s))).toBe(true);
      const after = await h.apps().findOneByOrFail({ id });
      expect(after).toEqual(before); // every column identical, updatedAt included
      expect(
        await h.ds.getRepository(AuditLog).count({ where: { entityId: id } }),
      ).toBe(auditBefore);
      expect(
        await h.ds
          .getRepository(AuditLog)
          .count({ where: { actorId: h.users.salesB.id, entityId: id } }),
      ).toBe(0);
    });

    it('the denial reveals nothing: it looks exactly like an application that does not exist', async () => {
      const id = await fixture('DRAFT');
      const missing = '6f1c0e7e-6d0b-4a53-9a4b-2f2a9d8c1b11';
      for (const [method, path] of [
        ['get', (x: string) => `/applications/${x}`],
        ['patch', (x: string) => `/applications/${x}`],
        ['post', (x: string) => `/applications/${x}/submit`],
      ] as const) {
        const denied = await send(
          'salesB',
          method,
          path(id),
          method === 'patch' ? { businessName: 'x' } : undefined,
        );
        const absent = await send(
          'salesB',
          method,
          path(missing),
          method === 'patch' ? { businessName: 'x' } : undefined,
        );
        expect(denied.status).toBe(404);
        for (const key of ['statusCode', 'error', 'message']) {
          expect(denied.body[key]).toEqual(absent.body[key]);
        }
      }
    });

    it('a foreign edit of a LOCKED application is still a 404, so the state is not revealed', async () => {
      const id = await fixture('IN_REVIEW');
      await send('salesB', 'patch', `/applications/${id}`, {
        businessName: 'x',
      }).expect(404);
    });
  });

  describe("lists never contain other people's applications", () => {
    it("salesB sees none of salesA's, even with every filter and a huge page size", async () => {
      const id = await fixture('DRAFT');
      for (const query of [
        '',
        '?limit=100',
        '?status=DRAFT&limit=100',
        `?createdById=${h.users.salesA.id}`,
        `?createdById=${h.users.salesA.id}&status=DRAFT`,
        '?page=1&limit=100&assignedReviewerId=anything',
      ]) {
        const res = await send('salesB', 'get', `/applications${query}`).expect(
          200,
        );
        const ids = res.body.items.map((i: { id: string }) => i.id);
        expect(ids).not.toContain(id);
        for (const item of res.body.items)
          expect(item.createdById).toBe(h.users.salesB.id);
      }
    });

    it('a reviewer only ever sees applications assigned to them', async () => {
      const mine = await fixture('IN_REVIEW'); // assigned to rev1
      const others = await fixture('DRAFT');
      const res = await send('rev1', 'get', '/applications?limit=100').expect(
        200,
      );
      const ids = res.body.items.map((i: { id: string }) => i.id);
      expect(ids).toContain(mine);
      expect(ids).not.toContain(others);
      for (const item of res.body.items)
        expect(item.assignedReviewerId).toBe(h.users.rev1.id);
      const asRev2 = await send(
        'rev2',
        'get',
        '/applications?limit=100',
      ).expect(200);
      expect(asRev2.body.items.map((i: { id: string }) => i.id)).not.toContain(
        mine,
      );
    });
  });

  describe('an unassigned reviewer cannot act, an assigned one can', () => {
    it("rev2 tries everything on rev1's application: nothing changes and nothing is recorded", async () => {
      const id = await fixture('IN_REVIEW');
      const before = await h.apps().findOneByOrFail({ id });

      const statuses = (
        await Promise.all([
          send('rev2', 'get', `/applications/${id}`),
          send('rev2', 'post', `/applications/${id}/decision`, {
            decision: 'REJECTED',
            reason: 'no',
          }),
          send('rev2', 'post', `/applications/${id}/decision`, {
            decision: 'APPROVED',
          }),
          send('rev2', 'patch', `/applications/${id}`, { businessName: 'x' }),
          send('rev2', 'post', `/applications/${id}/assign`, {
            reviewerId: h.users.rev2.id,
          }),
          send('rev2', 'get', `/applications/${id}/audit`),
        ])
      ).map((r) => r.status);

      expect(statuses.every((s) => [403, 404].includes(s))).toBe(true);
      expect(await h.apps().findOneByOrFail({ id })).toEqual(before);
      expect(
        await h.ds
          .getRepository(AuditLog)
          .count({ where: { actorId: h.users.rev2.id, entityId: id } }),
      ).toBe(0);
    });

    it('the assigned reviewer can decide; the same call from anyone else cannot', async () => {
      const id = await fixture('IN_REVIEW');
      await send('admin', 'post', `/applications/${id}/decision`, {
        decision: 'APPROVED',
      }).expect(403);
      await send('salesA', 'post', `/applications/${id}/decision`, {
        decision: 'APPROVED',
      }).expect(403);
      await send('rev2', 'post', `/applications/${id}/decision`, {
        decision: 'APPROVED',
      }).expect(404);
      expect((await h.apps().findOneByOrFail({ id })).status).toBe(
        ApplicationStatus.IN_REVIEW,
      );

      await send('rev1', 'post', `/applications/${id}/decision`, {
        decision: 'APPROVED',
      }).expect(200);
      expect((await h.apps().findOneByOrFail({ id })).status).toBe(
        ApplicationStatus.APPROVED,
      );
    });

    it('after a re-assignment the previous reviewer loses every right', async () => {
      const id = await fixture('IN_REVIEW');
      await send('admin', 'post', `/applications/${id}/assign`, {
        reviewerId: h.users.rev2.id,
      }).expect(200);

      await send('rev1', 'get', `/applications/${id}`).expect(404);
      await send('rev1', 'post', `/applications/${id}/decision`, {
        decision: 'APPROVED',
      }).expect(404);
      await send('rev2', 'post', `/applications/${id}/decision`, {
        decision: 'APPROVED',
      }).expect(200);
    });
  });

  describe('forbidden fields are ignored', () => {
    it('create: status, risk fields, owner and reviewer in the body change nothing', async () => {
      const res = await send('salesA', 'post', '/applications', {
        ...validApplicationPayload,
        status: 'APPROVED',
        riskStatus: 'COMPLETED',
        riskScore: 1,
        riskResult: { level: 'LOW' },
        createdById: h.users.salesB.id,
        assignedReviewerId: h.users.rev1.id,
        decisionReason: 'pre-approved',
        decidedAt: '2020-01-01T00:00:00Z',
        id: '6f1c0e7e-6d0b-4a53-9a4b-2f2a9d8c1b11',
      }).expect(201);

      const stored = await h.apps().findOneByOrFail({ id: res.body.id });
      expect(stored).toMatchObject({
        status: ApplicationStatus.DRAFT,
        riskStatus: RiskStatus.NOT_STARTED,
        riskScore: null,
        riskResult: null,
        createdById: h.users.salesA.id,
        assignedReviewerId: null,
        decisionReason: null,
        decidedAt: null,
      });
      expect(stored.id).not.toBe('6f1c0e7e-6d0b-4a53-9a4b-2f2a9d8c1b11');
    });

    it('update: the same fields in a PATCH change nothing', async () => {
      const id = await fixture('DRAFT');
      await send('salesA', 'patch', `/applications/${id}`, {
        businessName: 'Renamed',
        status: 'APPROVED',
        riskStatus: 'COMPLETED',
        createdById: h.users.salesB.id,
        assignedReviewerId: h.users.rev1.id,
        riskReviewRun: 99,
      }).expect(200);

      expect(await h.apps().findOneByOrFail({ id })).toMatchObject({
        businessName: 'Renamed',
        status: ApplicationStatus.DRAFT,
        riskStatus: RiskStatus.NOT_STARTED,
        createdById: h.users.salesA.id,
        assignedReviewerId: null,
        riskReviewRun: 0,
      });
    });

    it('decision: naming yourself as the reviewer in the body or query does not make you the reviewer', async () => {
      const id = await fixture('IN_REVIEW');
      await h
        .http()
        .post(
          `/applications/${id}/decision?reviewerId=${h.users.rev2.id}&userId=${h.users.rev2.id}`,
        )
        .set('Authorization', `Bearer ${h.tokens.rev2}`)
        .send({
          decision: 'APPROVED',
          reviewerId: h.users.rev2.id,
          assignedReviewerId: h.users.rev2.id,
          actorId: h.users.rev1.id,
        })
        .expect(404);
      expect((await h.apps().findOneByOrFail({ id })).status).toBe(
        ApplicationStatus.IN_REVIEW,
      );
    });

    it('assign: only a REVIEWER can be assigned, so a reviewer role cannot be conferred by assignment', async () => {
      const id = await fixture('SUBMITTED');
      for (const target of [h.users.salesB, h.users.admin]) {
        await send('admin', 'post', `/applications/${id}/assign`, {
          reviewerId: target.id,
        }).expect(422);
      }
      expect(
        (await h.apps().findOneByOrFail({ id })).assignedReviewerId,
      ).toBeNull();
    });
  });

  describe('identity comes from the token only', () => {
    it.each([
      { 'x-user-id': 'admin' },
      { 'x-user-role': 'ADMIN' },
      { 'x-forwarded-user': 'admin' },
      { 'x-auth-role': 'ADMIN', 'x-auth-user': 'admin' },
      { 'x-original-user': 'admin' },
    ])('identity headers %p do not elevate a caller', async (headers) => {
      const id = await fixture('DRAFT');
      let req = h
        .http()
        .get(`/applications/${id}`)
        .set('Authorization', `Bearer ${h.tokens.salesB}`);
      for (const [name, value] of Object.entries(headers))
        req = req.set(name, value);
      await req.expect(404);
    });

    it('a role or id in the request body, query or path never overrides the token', async () => {
      const id = await fixture('DRAFT');
      // as salesB, claim to be the admin / the owner in every place a client controls
      await h
        .http()
        .patch(`/applications/${id}?role=ADMIN&userId=${h.users.salesA.id}`)
        .set('Authorization', `Bearer ${h.tokens.salesB}`)
        .send({
          businessName: 'x',
          role: 'ADMIN',
          userId: h.users.salesA.id,
          createdById: h.users.salesA.id,
          user: { role: 'ADMIN' },
        })
        .expect(404);
      await send('salesB', 'post', `/applications/${id}/assign`, {
        reviewerId: h.users.rev1.id,
        role: 'ADMIN',
      } as object).expect(403);
    });

    it("an application's creator is the caller, whatever the body says", async () => {
      const res = await send('salesB', 'post', '/applications', {
        ...validApplicationPayload,
        createdById: h.users.salesA.id,
        createdBy: { id: h.users.salesA.id },
      }).expect(201);
      expect(res.body.createdById).toBe(h.users.salesB.id);
      await send('salesA', 'get', `/applications/${res.body.id}`).expect(404);
    });

    it('a token cannot be promoted by editing its claims (that is a 401, covered in authentication)', async () => {
      const [header, , signature] = h.tokens.salesA.split('.');
      const payload = JSON.parse(
        Buffer.from(h.tokens.salesA.split('.')[1], 'base64url').toString(),
      );
      const edited = Buffer.from(
        JSON.stringify({ ...payload, role: 'ADMIN' }),
      ).toString('base64url');
      await h
        .http()
        .get('/applications')
        .set('Authorization', `Bearer ${header}.${edited}.${signature}`)
        .expect(401);
    });
  });
});
