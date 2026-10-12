import { DataSource } from 'typeorm';

/**
 * Removes the audit rows a test run produced, plus its applications and users.
 *
 * audit_logs is append-only (a trigger rejects UPDATE/DELETE), so test
 * clean-up uses the documented maintenance flag, scoped to one transaction with
 * SET LOCAL: it cannot leak to other connections or outlive the transaction.
 */
export const purgeTestData = async (
  ds: DataSource,
  userIds: string[],
  extra: { correlationIds?: string[] } = {},
): Promise<void> => {
  if (userIds.length === 0) return;

  await ds.transaction(async (m) => {
    const apps: { id: string }[] = await m.query(
      'SELECT id FROM merchant_applications WHERE "createdById" = ANY($1::uuid[])',
      [userIds],
    );
    const appIds = apps.map((a) => a.id);
    const entityIds = [...userIds, ...appIds];

    await m.query(`SET LOCAL app.audit_maintenance = 'on'`);
    await m.query(
      `DELETE FROM audit_logs
        WHERE "actorId" = ANY($1::uuid[])
           OR "entityId" = ANY($2::uuid[])
           OR "correlationId" = ANY($3::text[])`,
      [userIds, entityIds, extra.correlationIds ?? []],
    );
    await m.query(
      'DELETE FROM merchant_applications WHERE "createdById" = ANY($1::uuid[])',
      [userIds],
    );
    await m.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
  });
};
