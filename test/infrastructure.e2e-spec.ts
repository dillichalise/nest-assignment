import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { createHarness, Harness } from './helpers/e2e-harness';
import {
  assertSafeTestDatabaseName,
  createEmptyDatabase,
  DB_PREFIX,
  dropDatabase,
  findStaleTestDatabases,
  listTestDatabases,
} from './helpers/test-database';

/**
 * The guarantees the rest of the e2e suite stands on: tests run in a
 * disposable, fully migrated database; they can never reach the dev database;
 * and each test file is isolated from the others.
 */
describe('E2E test infrastructure', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  const connectTo = async (database: string) => {
    const ds = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5433),
      username: process.env.DB_USER ?? 'postgres',
      password: process.env.DB_PASSWORD ?? 'postgres',
      database,
    });
    await ds.initialize();
    return ds;
  };
  const count = (ds: DataSource, table: string) =>
    ds
      .query(`SELECT count(*)::int AS n FROM ${table}`)
      .then((r) => r[0].n as number);

  /** The development database's name as configured in .env, ignoring this run's override. */
  const devDatabaseName = () => {
    const envFile = path.resolve(__dirname, '..', '.env');
    const fromFile = fs.existsSync(envFile)
      ? dotenv.parse(fs.readFileSync(envFile)).DB_NAME
      : undefined;
    return fromFile ?? 'merchant_platform';
  };

  describe('the database', () => {
    it('is a disposable e2e database, never the development one', async () => {
      const [{ current_database: current }] = await h.ds.query(
        'SELECT current_database()',
      );
      expect(current).toBe(h.databaseName);
      expect(current.startsWith(DB_PREFIX)).toBe(true);
      expect(current).not.toBe(devDatabaseName());
    });

    it('has every migration applied: all tables, the audit trigger and the migrations ledger', async () => {
      const migrationFiles = fs
        .readdirSync(
          path.resolve(__dirname, '..', 'src', 'database', 'migrations'),
        )
        .filter((f) => f.endsWith('.ts'));
      const applied: { name: string }[] = await h.ds.query(
        'SELECT name FROM migrations ORDER BY id',
      );
      expect(applied).toHaveLength(migrationFiles.length);

      const tables: { table_name: string }[] = await h.ds.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
      );
      expect(tables.map((t) => t.table_name)).toEqual(
        expect.arrayContaining([
          'users',
          'merchant_applications',
          'audit_logs',
          'migrations',
        ]),
      );
      const triggers: { tgname: string }[] = await h.ds.query(
        `SELECT tgname FROM pg_trigger WHERE tgrelid = 'audit_logs'::regclass AND NOT tgisinternal`,
      );
      expect(triggers.map((t) => t.tgname)).toContain('audit_logs_append_only');
    });

    it("is not touched by other tests: it contains only this file's five users", async () => {
      expect(await count(h.ds, 'users')).toBe(5);
    });

    it("is the only e2e database with this file's name, next to the run's template", async () => {
      const names = await listTestDatabases();
      expect(names.filter((n) => n === h.databaseName)).toHaveLength(1);
      expect(names).toContain(process.env.E2E_TEMPLATE_DB);
    });

    it('is a clone: the template it came from stays pristine (migrated, but no data)', async () => {
      await h.createApplication('salesA'); // writes data into THIS database only
      const template = await connectTo(process.env.E2E_TEMPLATE_DB as string);
      try {
        expect(await count(template, 'users')).toBe(0);
        expect(await count(template, 'merchant_applications')).toBe(0);
        expect(await count(template, 'audit_logs')).toBe(0);
        expect(await count(template, 'migrations')).toBeGreaterThan(0);
      } finally {
        await template.destroy();
      }
    });
  });

  describe('the development database is out of reach', () => {
    it("contains none of this suite's data", async () => {
      const dev = await connectTo(devDatabaseName());
      try {
        const leaked = await dev.query(
          `SELECT count(*)::int AS n FROM users WHERE email LIKE 'e2e-%'`,
        );
        expect(leaked[0].n).toBe(0);
        const auditLeak = await dev.query(
          `SELECT count(*)::int AS n FROM audit_logs WHERE "actorId" = ANY($1::uuid[])`,
          [Object.values(h.users).map((u) => u.id)],
        );
        expect(auditLeak[0].n).toBe(0);
      } finally {
        await dev.destroy();
      }
    });

    it.each([
      ['the dev database', 'merchant_platform'],
      ['a name that merely contains the prefix', `x${DB_PREFIX}abc`],
      ['postgres itself', 'postgres'],
      ['an empty name', ''],
      [
        'an injection attempt',
        `${DB_PREFIX}x"; DROP DATABASE merchant_platform; --`,
      ],
      ['an upper-case name', `${DB_PREFIX}ABC`],
    ])('refuses to treat %s as a test database', (_name, name) => {
      expect(() => assertSafeTestDatabaseName(name)).toThrow(/Refusing/);
    });

    it('accepts only names it generated', () => {
      expect(assertSafeTestDatabaseName(`${DB_PREFIX}abc123_x9`)).toBe(
        `${DB_PREFIX}abc123_x9`,
      );
      expect(() => assertSafeTestDatabaseName(undefined)).toThrow(/Refusing/);
    });

    it('cannot drop the development database, or anything that is not a test database', async () => {
      await expect(dropDatabase(devDatabaseName())).rejects.toThrow(/Refusing/);
      await expect(dropDatabase('postgres')).rejects.toThrow(/Refusing/);
      const dev = await connectTo(devDatabaseName()); // still there
      await dev.destroy();
    });
  });

  describe('leftovers from crashed runs', () => {
    it('are recognised by age, and a current run is never mistaken for one', async () => {
      const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000).toString(36);
      const stale = `${DB_PREFIX}${twoHoursAgo}zzzz_old1`;
      await createEmptyDatabase(stale);
      try {
        const found = await findStaleTestDatabases(60 * 60 * 1000);
        expect(found).toContain(stale);
        expect(found).not.toContain(h.databaseName);
        expect(found).not.toContain(process.env.E2E_TEMPLATE_DB);
      } finally {
        await dropDatabase(stale);
      }
      expect(await listTestDatabases()).not.toContain(stale);
    });
  });

  describe('truncating between tests', () => {
    it('empties applications and the audit trail but keeps the users', async () => {
      await h.createApplication('salesA');
      expect(await count(h.ds, 'merchant_applications')).toBeGreaterThan(0);
      expect(await count(h.ds, 'audit_logs')).toBeGreaterThan(0);

      await h.truncateApplicationData();

      expect(await count(h.ds, 'merchant_applications')).toBe(0);
      expect(await count(h.ds, 'audit_logs')).toBe(0);
      expect(await count(h.ds, 'users')).toBe(5);
      // and the tokens issued earlier still work
      await h.as('salesA').get('/auth/me').expect(200);
    });
  });

  describe('background work is isolated too', () => {
    it("uses this run's own Redis prefix, never the development queue's", () => {
      const prefix = h.queue.opts.prefix as string;
      expect(prefix.startsWith(`e2e-${process.env.E2E_RUN_ID}-`)).toBe(true);
      expect(prefix).not.toBe('bull');
    });

    it('keeps the risk-review worker off unless a suite asks for it, so hand-set state cannot race it', async () => {
      const id = (await h.createApplication('salesA')).id;
      await h.as('salesA').post(`/applications/${id}/submit`).expect(200);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const stored = await h.apps().findOneByOrFail({ id });
      expect(stored.riskStatus).toBe('PENDING'); // nothing picked the job up
    });
  });
});
