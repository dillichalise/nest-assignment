import { DataSource, EntityManager } from 'typeorm';

/**
 * Unit-test stand-in for a DataSource. `transaction(cb)` runs `cb` with a
 * manager whose `getRepository()` always returns `repo`, so code that does its
 * writes inside a transaction can be tested with the same mock repository as
 * before. It does not model rollback; that is covered against real Postgres in
 * the e2e suite.
 *
 * Excluded from the production build (tsconfig.build.json).
 */
export const fakeDataSource = (repo: unknown) => {
  const manager = {
    getRepository: jest.fn(() => repo),
  } as unknown as EntityManager;
  const transaction = jest.fn(
    (callback: (m: EntityManager) => Promise<unknown>) => callback(manager),
  );
  return {
    dataSource: { transaction } as unknown as DataSource,
    manager,
    transaction,
  };
};
