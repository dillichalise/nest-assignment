import { buildDataSourceOptions } from './database.config';

const build = (env: NodeJS.ProcessEnv = {}) =>
  buildDataSourceOptions(env) as unknown as Record<string, unknown>;

describe('buildDataSourceOptions', () => {
  it('falls back to the local docker-compose defaults', () => {
    expect(build()).toMatchObject({
      type: 'postgres',
      host: 'localhost',
      port: 5433,
      username: 'postgres',
      password: 'postgres',
      database: 'merchant_platform',
    });
  });

  it('reads every connection setting from the environment', () => {
    const options = build({
      DB_HOST: 'db.internal',
      DB_PORT: '6543',
      DB_USER: 'app',
      DB_PASSWORD: 's3cret',
      DB_NAME: 'prod_db',
    });
    expect(options).toMatchObject({
      host: 'db.internal',
      port: 6543,
      username: 'app',
      password: 's3cret',
      database: 'prod_db',
    });
  });

  it('turns the port into a number (env values are strings)', () => {
    expect(typeof build({ DB_PORT: '5432' }).port).toBe('number');
  });

  it('NEVER synchronizes the schema: changes go through reviewed migrations only', () => {
    expect(build().synchronize).toBe(false);
    expect(build({ DB_HOST: 'x', NODE_ENV: 'development' }).synchronize).toBe(
      false,
    );
    expect(build({ NODE_ENV: 'test' }).synchronize).toBe(false);
  });

  it('uses pgcrypto so uuid defaults come from gen_random_uuid()', () => {
    expect(build().uuidExtension).toBe('pgcrypto');
  });

  it('discovers entities and migrations by file convention', () => {
    const { entities, migrations } = build() as {
      entities: unknown[];
      migrations: unknown[];
    };
    expect(String(entities[0])).toMatch(/\.entity\{\.ts,\.js\}$/);
    expect(String(migrations[0])).toMatch(/migrations\/\*\{\.ts,\.js\}$/);
  });
});
