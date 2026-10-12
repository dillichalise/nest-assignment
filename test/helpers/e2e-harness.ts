import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import { Queue } from 'bullmq';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { MerchantApplication } from '../../src/applications/merchant-application.entity';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { Role } from '../../src/common/enums/role.enum';
import { RISK_REVIEW_QUEUE } from '../../src/queue/queue.constants';
import { RiskProviderClient } from '../../src/risk-review/risk-provider';
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
/**
 * To run the real risk-review worker, import './enable-risk-worker' first in
 * the test file (see that file for why).
 */
export interface HarnessOptions {
  /** Replace the risk provider, e.g. with a ScriptedRiskProvider. */
  riskProvider?: RiskProviderClient;
}

/** Polls until `check` returns a truthy value; fails with a clear message on timeout. */
export const waitFor = async <T>(
  check: () => Promise<T | false | null | undefined>,
  { timeoutMs = 8000, intervalMs = 40, what = 'condition' } = {},
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
};

export const createHarness = async (options: HarnessOptions = {}) => {
  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (options.riskProvider) {
    builder = builder
      .overrideProvider(RiskProviderClient)
      .useValue(options.riskProvider);
  }
  const moduleRef = await builder.compile();
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
  const queue = app.get<Queue>(getQueueToken(RISK_REVIEW_QUEUE));

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
    // Drop this run's Redis keys (the prefix is unique to this test file).
    await queue.obliterate({ force: true }).catch(() => undefined);
    await app.close();
  };

  return {
    app,
    ds,
    users,
    tokens,
    as,
    apps,
    queue,
    createApplication,
    close,
    http: () => request(app.getHttpServer()),
  };
};

export type Harness = Awaited<ReturnType<typeof createHarness>>;
