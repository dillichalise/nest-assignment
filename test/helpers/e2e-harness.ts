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
import {
  assertSafeTestDatabaseName,
  createDatabaseFromTemplate,
  dropDatabase,
} from './test-database';

export type TestUserKey = 'salesA' | 'salesB' | 'admin' | 'rev1' | 'rev2';

const ROLES: Record<TestUserKey, Role> = {
  salesA: Role.SALES,
  salesB: Role.SALES,
  admin: Role.ADMIN,
  rev1: Role.REVIEWER,
  rev2: Role.REVIEWER,
};

export const E2E_PASSWORD = 'E2e-Passw0rd!';

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
  // This test file's own database: a clone of the migrated template. The name
  // was fixed (and checked) in setup-env.ts, before the app module was imported.
  const databaseName = assertSafeTestDatabaseName(process.env.E2E_DB_NAME);
  await createDatabaseFromTemplate(
    databaseName,
    assertSafeTestDatabaseName(process.env.E2E_TEMPLATE_DB),
  );

  try {
    return await buildHarness(options, databaseName);
  } catch (error) {
    // The file's afterAll(close) is never reached when setup itself fails
    // (the app cannot boot, a login fails, ...): do not leak the database.
    await dropDatabase(databaseName).catch(() => undefined);
    throw error;
  }
};

const buildHarness = async (options: HarnessOptions, databaseName: string) => {
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

  // Belt and braces: whatever the configuration said, prove the app is really
  // connected to the disposable database and not to the dev one.
  const [{ current_database: connectedTo }] = await ds.query(
    'SELECT current_database()',
  );
  if (connectedTo !== databaseName) {
    await app.close();
    throw new Error(
      `e2e harness is connected to "${connectedTo}", expected "${databaseName}". Aborting before any test runs.`,
    );
  }

  const tag = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const users = {} as Record<TestUserKey, User>;
  const tokens = {} as Record<TestUserKey, string>;
  const hash = await bcrypt.hash(E2E_PASSWORD, 4);

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
      .send({ email: users[key].email, password: E2E_PASSWORD });
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

  /**
   * A brand-new user with their own token, for a describe block that needs a
   * clean slate (e.g. exact list totals) without depending on what other tests
   * in the file happened to create for the five standard users.
   */
  const createExtraUser = async (role: Role, label = 'extra') => {
    const repo = ds.getRepository(User);
    const user = await repo.save(
      repo.create({
        email:
          `${tag}-${label}-${Math.random().toString(36).slice(2, 8)}@example.com`.toLowerCase(),
        name: label,
        role,
        passwordHash: hash,
        isActive: true,
      }),
    );
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: user.email, password: E2E_PASSWORD });
    if (login.status !== 200) {
      throw new Error(`harness login failed for ${label}: ${login.status}`);
    }
    const token = login.body.accessToken as string;
    const authed = (r: request.Test) =>
      r.set('Authorization', `Bearer ${token}`);
    const http = () => request(app.getHttpServer());
    return {
      user,
      token,
      get: (url: string) => authed(http().get(url)),
      post: (url: string) => authed(http().post(url)),
      patch: (url: string) => authed(http().patch(url)),
      createApplication: async (over: object = {}) => {
        const res = await authed(http().post('/applications')).send({
          ...validApplicationPayload,
          ...over,
        });
        if (res.status !== 201) {
          throw new Error(
            `createApplication failed: ${res.status} ${JSON.stringify(res.body)}`,
          );
        }
        return res.body as { id: string };
      },
    };
  };

  /**
   * Empties the data tables (not users, not the migrations table) between
   * tests that need a blank slate. Not needed for isolation between test FILES:
   * each has its own database.
   */
  const truncateApplicationData = () =>
    ds.query(
      'TRUNCATE TABLE merchant_applications, audit_logs RESTART IDENTITY',
    );

  const close = async () => {
    // This file's Redis keys, then the app (and its DB pool), then the database.
    await queue.obliterate({ force: true }).catch(() => undefined);
    await app.close();
    await dropDatabase(databaseName);
  };

  return {
    app,
    ds,
    users,
    tokens,
    as,
    apps,
    queue,
    truncateApplicationData,
    createExtraUser,
    databaseName,
    createApplication,
    close,
    http: () => request(app.getHttpServer()),
  };
};

export type Harness = Awaited<ReturnType<typeof createHarness>>;
