import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  decryptField,
  encryptField,
  ENCRYPTION_CONTEXT,
  getFieldEncryptionKey,
  isEncryptedField,
} from '../../common/security/field-encryption';

/**
 * Data migration: encrypts any plaintext "ownerTaxId" already in the table so
 * existing rows keep working once the column is read through the encrypting
 * transformer. Idempotent: rows that are already encrypted are skipped.
 * Needs FIELD_ENCRYPTION_KEY, and the SAME key must be used afterwards.
 *
 * The column type does not change (text), so there is no schema change here.
 */
export class EncryptOwnerTaxId1791519713962 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const key = getFieldEncryptionKey();
    const rows: { id: string; ownerTaxId: string }[] = await queryRunner.query(
      `SELECT id, "ownerTaxId" FROM "merchant_applications"`,
    );
    for (const row of rows) {
      if (isEncryptedField(row.ownerTaxId)) {
        continue;
      }
      await queryRunner.query(
        `UPDATE "merchant_applications" SET "ownerTaxId" = $1 WHERE id = $2`,
        [
          encryptField(row.ownerTaxId, key, ENCRYPTION_CONTEXT.MERCHANT_OWNER_TAX_ID),
          row.id,
        ],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const key = getFieldEncryptionKey();
    const rows: { id: string; ownerTaxId: string }[] = await queryRunner.query(
      `SELECT id, "ownerTaxId" FROM "merchant_applications"`,
    );
    for (const row of rows) {
      if (!isEncryptedField(row.ownerTaxId)) {
        continue;
      }
      await queryRunner.query(
        `UPDATE "merchant_applications" SET "ownerTaxId" = $1 WHERE id = $2`,
        [
          decryptField(row.ownerTaxId, key, ENCRYPTION_CONTEXT.MERCHANT_OWNER_TAX_ID),
          row.id,
        ],
      );
    }
  }
}
