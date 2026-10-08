import { Repository } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { ConflictError } from '../common/errors/domain.error';
import { assertTransition } from './application-state-machine';
import { ApplicationStatus } from './enums/application-status.enum';
import { MerchantApplication } from './merchant-application.entity';

/**
 * Concurrency strategy: compare-and-set on the status column.
 *
 * The UPDATE only matches while the row is STILL in `from`. If two requests
 * race (double-submit, two reviewers deciding), exactly one UPDATE affects a
 * row; the other affects zero and gets a 409. This needs no extra column and
 * no explicit lock, and works inside a transaction (pass that transaction's
 * repository) so the audit row in Pack 08 commits atomically with it.
 *
 * Trade-off vs. a @VersionColumn: this guards status changes only, not
 * concurrent edits of other fields - which is what the lifecycle needs.
 */
export const applyTransition = async (
  repo: Repository<MerchantApplication>,
  id: string,
  from: ApplicationStatus,
  to: ApplicationStatus,
  patch: QueryDeepPartialEntity<MerchantApplication> = {},
): Promise<void> => {
  assertTransition(from, to);

  const result = await repo.update(
    { id, status: from },
    { ...patch, status: to },
  );
  if (!result.affected) {
    throw new ConflictError(
      'Application status changed concurrently; reload and retry',
      { expected: from },
    );
  }
};
