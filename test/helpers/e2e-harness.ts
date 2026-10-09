import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { MerchantApplication } from '../../src/applications/merchant-application.entity';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { Role } from '../../src/common/enums/role.enum';
import { User } from '../../src/users/user.entity';

export type TestUserKey = 'salesA' | 'salesB' | 'admin' | 'rev1' | 'rev2';

const ROLES: Record<TestUserKey, Role> = {
  salesA: Role.SALES,
  salesB: Role.SALES,
  admin: Role.ADMIN,
  rev1: Role.REVIEWER,
  rev2: Role.REVIEWER,
};

const PASSWORD = 'E2e-Passw0rd!';

export const validApplicationPayload = {
  businessName: 'Test Cafe',
  legalBusinessName: 'Test Cafe Ltd',
  businessType: 'cafe',
  ownerName: 'Cafe Owner',
  ownerEmail: 'cafe_owner@example.com',
  ownerPhone: '+977 9876543210',
  ownerTaxId: '123-456-789',
  monthlyVolume: 25000,
  averageTicketSize: 42.5,
  currency: 'USD',
};

/**
 * Boots the real app against the dev database with throwaway users (unique
 * emails, deleted in `close()`).
 */
export const createHarness = async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app: INestApplication = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  const ds = app.get(DataSource);

  const tag = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const users = {} as Record<TestUserKey, User>;
  const tokens = {} as Record<TestUserKey, string>;
  const hash = await bcrypt.hash(PASSWORD, 4);

  for (const key of Object.keys(ROLES) as TestUserKey[]) {
    const repo = ds.getRepository(User);
    users[key] = await repo.save(
      repo.create({
        email: `${tag}-${key}@example.com`.toLowerCase(),
        name: key,
        role: ROLES[key],
        passwordHash: hash,
        isActive: true,
      }),
    );
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: users[key].email, password: PASSWORD });
    if (login.status !== 200) {
      throw new Error(`harness login failed for ${key}: ${login.status}`);
    }
    tokens[key] = login.body.accessToken;
  }

  const as = (who: TestUserKey) => {
    const auth = (r: request.Test) =>
      r.set('Authorization', `Bearer ${tokens[who]}`);
    const http = () => request(app.getHttpServer());
    return {
      get: (url: string) => auth(http().get(url)),
      post: (url: string) => auth(http().post(url)),
      patch: (url: string) => auth(http().patch(url)),
    };
  };

  const apps = () => ds.getRepository(MerchantApplication);

  const createApplication = async (who: TestUserKey, over: object = {}) => {
    const res = await as(who)
      .post('/applications')
      .send({ ...validApplicationPayload, ...over });
    if (res.status !== 201) {
      throw new Error(
        `createApplication failed: ${res.status} ${JSON.stringify(res.body)}`,
      );
    }
    return res.body as { id: string };
  };

  const close = async () => {
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
  };

  return {
    app,
    ds,
    users,
    tokens,
    as,
    apps,
    createApplication,
    close,
    http: () => request(app.getHttpServer()),
  };
};

export type Harness = Awaited<ReturnType<typeof createHarness>>;
