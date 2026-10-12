import 'dotenv/config';
import { DataSource } from 'typeorm';

/**
 * Throwaway Postgres databases for the e2e suite.
 *
 * Design: the migrations run ONCE per run into a template database
 * (global-setup.ts); every test file then clones that template with
 * `CREATE DATABASE ... TEMPLATE`, which is fast, fully isolated and safe to do
 * from many Jest workers at once, and drops its clone when it finishes. There
 * is nothing to truncate or clean up, test files can never see each other's
 * data, and the dev database is never touched.
 */

/** Every database this suite creates starts with this; nothing else may be dropped. */
export const DB_PREFIX = 'merchant_platform_e2e_';

const SAFE_NAME = /^[a-z0-9_]{1,63}$/;

const ident = (name: string): string => {
  if (!SAFE_NAME.test(name)) {
    throw new Error(`Unsafe database name: ${name}`);
  }
  return `"${name}"`;
};

/**
 * The guard behind everything else: the e2e suite refuses to run, create or
 * drop anything that is not clearly one of its own disposable databases.
 */
export const assertSafeTestDatabaseName = (
  name: string | undefined,
): string => {
  if (!name || !name.startsWith(DB_PREFIX) || !SAFE_NAME.test(name)) {
    throw new Error(
      `Refusing to use database "${name}" for e2e tests: test databases must be named ${DB_PREFIX}*. ` +
        'Run the suite with `npm run test:e2e`, which provisions them.',
    );
  }
  return name;
};

const withAdminConnection = async <T>(
  fn: (ds: DataSource) => Promise<T>,
): Promise<T> => {
  const admin = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5433),
    username: process.env.DB_USER ?? 'postgres',
    password: process.env.DB_PASSWORD ?? 'postgres',
    // CREATE/DROP DATABASE cannot run inside the target; use a maintenance database.
    database: process.env.E2E_ADMIN_DB ?? 'postgres',
  });
  try {
    await admin.initialize();
  } catch (error) {
    throw new Error(
      `Cannot reach Postgres to provision e2e databases (${(error as Error).message}). ` +
        'Is the infrastructure up? Run `npm run docker:up`.',
      { cause: error },
    );
  }
  try {
    return await fn(admin);
  } finally {
    await admin.destroy();
  }
};

export const createEmptyDatabase = (name: string) =>
  withAdminConnection((ds) =>
    ds.query(`CREATE DATABASE ${ident(assertSafeTestDatabaseName(name))}`),
  );

export const createDatabaseFromTemplate = (name: string, template: string) =>
  withAdminConnection((ds) =>
    ds.query(
      `CREATE DATABASE ${ident(assertSafeTestDatabaseName(name))} TEMPLATE ${ident(assertSafeTestDatabaseName(template))}`,
    ),
  );

/** WITH (FORCE) disconnects any session still attached, e.g. a pool that has not closed yet. */
export const dropDatabase = (name: string) =>
  withAdminConnection((ds) =>
    ds.query(
      `DROP DATABASE IF EXISTS ${ident(assertSafeTestDatabaseName(name))} WITH (FORCE)`,
    ),
  );

export const listTestDatabases = (): Promise<string[]> =>
  withAdminConnection(async (ds) => {
    const rows: { datname: string }[] = await ds.query(
      `SELECT datname FROM pg_database WHERE datname LIKE $1`,
      [`${DB_PREFIX.replace(/_/g, '\\_')}%`],
    );
    return rows.map((r) => r.datname);
  });

export const dropDatabasesStartingWith = async (
  prefix: string,
): Promise<string[]> => {
  const dropped: string[] = [];
  for (const name of await listTestDatabases()) {
    if (name.startsWith(prefix)) {
      await dropDatabase(name);
      dropped.push(name);
    }
  }
  return dropped;
};

/** Ids look like `<8 base36 chars of Date.now()><4 random>`; recover when the run started. */
const startedAt = (databaseName: string): number | null => {
  const match = new RegExp(`^${DB_PREFIX}(?:tpl_)?([a-z0-9]{8})`).exec(
    databaseName,
  );
  const ms = match ? parseInt(match[1], 36) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

/** Leftovers of crashed runs (a killed process cannot run its teardown). */
export const findStaleTestDatabases = async (
  maxAgeMs: number,
): Promise<string[]> => {
  const now = Date.now();
  return (await listTestDatabases()).filter((name) => {
    const started = startedAt(name);
    return started !== null && now - started > maxAgeMs;
  });
};
