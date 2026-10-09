import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { ApplicationStatus } from '../src/applications/enums/application-status.enum';
import { MerchantApplication } from '../src/applications/merchant-application.entity';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { Role } from '../src/common/enums/role.enum';
import { User } from '../src/users/user.entity';

describe('Applications: CRUD & object-level isolation (e2e)', () => {
  const PASSWORD = 'E2e-Passw0rd!';
  const tag = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  let app: INestApplication;
  let ds: DataSource;
  const users = {} as Record<
    'salesA' | 'salesB' | 'admin' | 'rev1' | 'rev2',
    User
  >;
  const tokens = {} as Record<keyof typeof users, string>;

  const payload = {
    businessName: 'Test Cafe',
    legalBusinessName: 'Test Cafe Pvt Ltd',
    businessType: 'retail',
    ownerName: 'Cafe Owner',
    ownerEmail: 'cafeowner@example.com',
    ownerPhone: '+977',
    ownerTaxId: '123-456-789',
    monthlyVolume: 25000,
    averageTicketSize: 42.5,
    currency: 'USD',
  };

  const as = (who: keyof typeof users) => ({
    get: (url: string) =>
      request(app.getHttpServer())
        .get(url)
        .set('Authorization', `Bearer ${tokens[who]}`),
    post: (url: string) =>
      request(app.getHttpServer())
        .post(url)
        .set('Authorization', `Bearer ${tokens[who]}`),
    patch: (url: string) =>
      request(app.getHttpServer())
        .patch(url)
        .set('Authorization', `Bearer ${tokens[who]}`),
  });

  const createAs = async (who: keyof typeof users, over: object = {}) => {
    const res = await as(who)
      .post('/applications')
      .send({ ...payload, ...over });
    expect(res.status).toBe(201);
    return res.body as { id: string };
  };

  const setStatus = (id: string, status: ApplicationStatus) =>
    ds.getRepository(MerchantApplication).update({ id }, { status });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    ds = app.get(DataSource);

    const hash = await bcrypt.hash(PASSWORD, 4);
    const defs: [keyof typeof users, Role][] = [
      ['salesA', Role.SALES],
      ['salesB', Role.SALES],
      ['admin', Role.ADMIN],
      ['rev1', Role.REVIEWER],
      ['rev2', Role.REVIEWER],
    ];
    for (const [key, role] of defs) {
      const repo = ds.getRepository(User);
      users[key] = await repo.save(
        repo.create({
          email: `${tag}-${key}@example.com`.toLowerCase(),
          name: key,
          role,
          passwordHash: hash,
          isActive: true,
        }),
      );
      const login = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: users[key].email, password: PASSWORD });
      expect(login.status).toBe(200);
      tokens[key] = login.body.accessToken;
    }
  });

  afterAll(async () => {
    const ids = Object.values(users).map((u) => u.id);
    if (ids.length) {
      await ds
        .createQueryBuilder()
        .delete()
        .from(MerchantApplication)
        .where('"createdById" IN (:...ids)', { ids })
        .execute();
      await ds
        .createQueryBuilder()
        .delete()
        .from(User)
        .where('id IN (:...ids)', { ids })
        .execute();
    }
    await app.close();
  });

  describe('authentication & role gates', () => {
    it('rejects requests without a token', async () => {
      await request(app.getHttpServer()).get('/applications').expect(401);
      await request(app.getHttpServer())
        .post('/applications')
        .send(payload)
        .expect(401);
    });

    it('REVIEWER cannot create or update applications (403)', async () => {
      await as('rev1').post('/applications').send(payload).expect(403);
      const { id } = await createAs('salesA');
      await as('rev1')
        .patch(`/applications/${id}`)
        .send({ businessName: 'x' })
        .expect(403);
    });
  });

  describe('create', () => {
    it('creates a DRAFT owned by the caller, with a masked tax id', async () => {
      const res = await as('salesA')
        .post('/applications')
        .send(payload)
        .expect(201);
      expect(res.body).toMatchObject({
        status: 'DRAFT',
        riskStatus: 'NOT_STARTED',
        createdById: users.salesA.id,
        assignedReviewerId: null,
        monthlyVolume: '25000.00',
        averageTicketSize: '42.50',
        currency: 'USD',
      });
      expect(res.body.ownerTaxId).toBe('*******6789');
      expect(JSON.stringify(res.body)).not.toContain('123-456-789');
    });

    it('ADMIN can create too, owned by the admin', async () => {
      const res = await as('admin')
        .post('/applications')
        .send(payload)
        .expect(201);
      expect(res.body.createdById).toBe(users.admin.id);
    });

    it('ignores smuggled workflow fields', async () => {
      const res = await as('salesA')
        .post('/applications')
        .send({
          ...payload,
          status: 'APPROVED',
          riskStatus: 'COMPLETED',
          createdById: users.salesB.id,
          assignedReviewerId: users.rev1.id,
        })
        .expect(201);
      expect(res.body).toMatchObject({
        status: 'DRAFT',
        riskStatus: 'NOT_STARTED',
        createdById: users.salesA.id,
        assignedReviewerId: null,
      });
    });

    it('returns structured validation errors', async () => {
      const res = await as('salesA')
        .post('/applications')
        .send({ ...payload, ownerEmail: 'nope', monthlyVolume: -5 })
        .expect(400);
      expect(res.body.message).toBe('Validation failed');
      const fields = res.body.details.map((d: { field: string }) => d.field);
      expect(fields).toEqual(
        expect.arrayContaining(['ownerEmail', 'monthlyVolume']),
      );
      expect(res.body.requestId).toBeDefined();
    });
  });

  describe('object-level isolation (SALES)', () => {
    let appIdA: string;

    beforeAll(async () => {
      appIdA = (await createAs('salesA', { businessName: 'Isolation target' }))
        .id;
    });

    it("SALES B cannot READ SALES A's application by id (404)", async () => {
      await as('salesB').get(`/applications/${appIdA}`).expect(404);
      await as('salesA').get(`/applications/${appIdA}`).expect(200);
    });

    it("SALES B cannot UPDATE SALES A's application, and it stays unchanged", async () => {
      await as('salesB')
        .patch(`/applications/${appIdA}`)
        .send({ businessName: 'Hijacked' })
        .expect(404);
      const res = await as('salesA').get(`/applications/${appIdA}`).expect(200);
      expect(res.body.businessName).toBe('Isolation target');
    });

    it('the denial is indistinguishable from a non-existent id', async () => {
      const denied = await as('salesB')
        .get(`/applications/${appIdA}`)
        .expect(404);
      const missing = await as('salesB')
        .get(`/applications/${randomUUID()}`)
        .expect(404);
      for (const key of ['statusCode', 'error', 'message']) {
        expect(denied.body[key]).toEqual(missing.body[key]);
      }
    });

    it('also hides state: a foreign edit of a locked application is 404, not 409', async () => {
      const { id } = await createAs('salesA');
      await setStatus(id, ApplicationStatus.APPROVED);
      await as('salesB')
        .patch(`/applications/${id}`)
        .send({ businessName: 'x' })
        .expect(404);
    });

    it("SALES B's list never contains SALES A's applications", async () => {
      const res = await as('salesB').get('/applications').expect(200);
      expect(res.body.total).toBe(0);
      expect(res.body.items).toEqual([]);
    });

    it('SALES A list only contains their own', async () => {
      const res = await as('salesA').get('/applications?limit=100').expect(200);
      expect(res.body.total).toBeGreaterThan(0);
      for (const item of res.body.items) {
        expect(item.createdById).toBe(users.salesA.id);
      }
    });

    it('a status filter cannot be used to widen the scope', async () => {
      const res = await as('salesB')
        .get('/applications?status=DRAFT')
        .expect(200);
      expect(res.body.total).toBe(0);
    });
  });

  describe('ADMIN and REVIEWER visibility', () => {
    it('ADMIN can read and update any application', async () => {
      const { id } = await createAs('salesA');
      await as('admin').get(`/applications/${id}`).expect(200);
      const res = await as('admin')
        .patch(`/applications/${id}`)
        .send({ businessName: 'Admin edit' })
        .expect(200);
      expect(res.body.businessName).toBe('Admin edit');
    });

    it('REVIEWER sees only applications assigned to them', async () => {
      const { id } = await createAs('salesA');
      await as('rev1').get(`/applications/${id}`).expect(404);

      await ds
        .getRepository(MerchantApplication)
        .update({ id }, { assignedReviewerId: users.rev1.id });

      await as('rev1').get(`/applications/${id}`).expect(200);
      await as('rev2').get(`/applications/${id}`).expect(404);

      const list = await as('rev1').get('/applications').expect(200);
      expect(list.body.items.map((i: { id: string }) => i.id)).toContain(id);
      for (const item of list.body.items) {
        expect(item.assignedReviewerId).toBe(users.rev1.id);
      }
      expect(
        (await as('rev2').get('/applications').expect(200)).body.total,
      ).toBe(0);
    });
  });

  describe('update rules', () => {
    it('updates only the sent fields, bumping updatedAt', async () => {
      const { id } = await createAs('salesA');
      const before = (await as('salesA').get(`/applications/${id}`)).body;
      const res = await as('salesA')
        .patch(`/applications/${id}`)
        .send({ businessName: 'Renamed', monthlyVolume: 99.9 })
        .expect(200);
      expect(res.body.businessName).toBe('Renamed');
      expect(res.body.monthlyVolume).toBe('99.90');
      expect(res.body.legalBusinessName).toBe(before.legalBusinessName);
      expect(new Date(res.body.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(before.updatedAt).getTime(),
      );
    });

    it('cannot change status, owner, reviewer or risk fields through PATCH', async () => {
      const { id } = await createAs('salesA');
      const res = await as('salesA')
        .patch(`/applications/${id}`)
        .send({
          businessName: 'ok',
          status: 'APPROVED',
          createdById: users.salesB.id,
          assignedReviewerId: users.rev1.id,
          riskStatus: 'COMPLETED',
          riskScore: 1,
          decisionReason: 'trust me',
        })
        .expect(200);
      expect(res.body).toMatchObject({
        businessName: 'ok',
        status: 'DRAFT',
        createdById: users.salesA.id,
        assignedReviewerId: null,
        riskStatus: 'NOT_STARTED',
        riskScore: null,
        decisionReason: null,
      });
    });

    it.each([
      ApplicationStatus.SUBMITTED,
      ApplicationStatus.IN_REVIEW,
      ApplicationStatus.APPROVED,
      ApplicationStatus.REJECTED,
    ])('rejects edits while %s with a clear 409', async (status) => {
      const { id } = await createAs('salesA');
      await setStatus(id, status);
      const res = await as('salesA')
        .patch(`/applications/${id}`)
        .send({ businessName: 'x' })
        .expect(409);
      expect(res.body.message).toMatch(/DRAFT or INFO_REQUESTED/);
      expect(res.body.details).toEqual({ currentStatus: status });
    });

    it('allows edits while INFO_REQUESTED', async () => {
      const { id } = await createAs('salesA');
      await setStatus(id, ApplicationStatus.INFO_REQUESTED);
      await as('salesA')
        .patch(`/applications/${id}`)
        .send({ businessName: 'fixed' })
        .expect(200);
    });

    it('returns 400 for a malformed id and 404 for an unknown one', async () => {
      await as('salesA').get('/applications/not-a-uuid').expect(400);
      await as('salesA')
        .patch(`/applications/${randomUUID()}`)
        .send({ businessName: 'x' })
        .expect(404);
    });
  });

  describe('listing: filtering & pagination', () => {
    // salesB starts empty, so counts are deterministic.
    beforeAll(async () => {
      const ids: string[] = [];
      for (let i = 1; i <= 3; i++) {
        ids.push((await createAs('salesB', { businessName: `List ${i}` })).id);
      }
      await setStatus(ids[0], ApplicationStatus.SUBMITTED);
    });

    it('paginates with total, page and limit', async () => {
      const p1 = await as('salesB')
        .get('/applications?page=1&limit=2')
        .expect(200);
      expect(p1.body).toMatchObject({ total: 3, page: 1, limit: 2 });
      expect(p1.body.items).toHaveLength(2);

      const p2 = await as('salesB')
        .get('/applications?page=2&limit=2')
        .expect(200);
      expect(p2.body.items).toHaveLength(1);

      const ids = [...p1.body.items, ...p2.body.items].map(
        (i: { id: string }) => i.id,
      );
      expect(new Set(ids).size).toBe(3);
    });

    it('orders newest first', async () => {
      const res = await as('salesB').get('/applications').expect(200);
      const times = res.body.items.map(
        (i: { createdAt: string }) => +new Date(i.createdAt),
      );
      expect(times).toEqual([...times].sort((a, b) => b - a));
    });

    it('returns an empty page (not an error) beyond the last page', async () => {
      const res = await as('salesB')
        .get('/applications?page=9&limit=2')
        .expect(200);
      expect(res.body).toMatchObject({ items: [], total: 3, page: 9 });
    });

    it('filters by status', async () => {
      const res = await as('salesB')
        .get('/applications?status=SUBMITTED')
        .expect(200);
      expect(res.body.total).toBe(1);
      expect(res.body.items[0].status).toBe('SUBMITTED');
      expect(
        (await as('salesB').get('/applications?status=APPROVED')).body.total,
      ).toBe(0);
    });

    it.each(['limit=101', 'limit=0', 'page=0', 'page=abc', 'status=NOPE'])(
      'rejects invalid query "%s" with 400',
      async (qs) => {
        await as('salesB').get(`/applications?${qs}`).expect(400);
      },
    );
  });
});
