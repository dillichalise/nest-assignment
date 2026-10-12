import 'dotenv/config';
import { execFileSync } from 'child_process';
import * as path from 'path';
import {
  createEmptyDatabase,
  DB_PREFIX,
  dropDatabase,
  findStaleTestDatabases,
} from './helpers/test-database';

const ONE_HOUR_MS = 60 * 60 * 1000;
const PROJECT_ROOT = path.resolve(__dirname, '..');

/**
 * Runs once in the Jest parent process, before any worker starts.
 *
 * 1. Gives this run an id. Workers inherit it (setup-env.ts puts it in every
 *    queue prefix and database name) so global-teardown.ts can remove exactly
 *    this run's Redis keys and databases, and nobody else's.
 * 2. Removes databases left behind by runs that crashed more than an hour ago.
 * 3. Creates a TEMPLATE database and runs every migration into it. Migrations
 *    are therefore exercised from scratch on each run, and each test file gets
 *    a ready-to-use clone of it (see test/helpers/test-database.ts).
 */
export default async function globalSetup(): Promise<void> {
  const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const template = `${DB_PREFIX}tpl_${runId}`;
  process.env.E2E_RUN_ID = runId;
  process.env.E2E_TEMPLATE_DB = template;

  for (const stale of await findStaleTestDatabases(ONE_HOUR_MS)) {
    await dropDatabase(stale);
  }

  await createEmptyDatabase(template);
  try {
    // The project's own migration command, pointed at the template.
    execFileSync(
      'npx',
      [
        'typeorm-ts-node-commonjs',
        '-d',
        'src/database/data-source.ts',
        'migration:run',
      ],
      {
        cwd: PROJECT_ROOT,
        env: { ...process.env, DB_NAME: template },
        encoding: 'utf8',
        stdio: 'pipe',
      },
    );
  } catch (error) {
    await dropDatabase(template);
    const e = error as { stdout?: string; stderr?: string; message: string };
    throw new Error(
      `Running the migrations into the e2e template database failed:\n${e.stderr || e.stdout || e.message}`,
      { cause: error },
    );
  }
}
