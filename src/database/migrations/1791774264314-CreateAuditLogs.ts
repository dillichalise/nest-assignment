import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateAuditLogs1791774264314 implements MigrationInterface {
    name = 'CreateAuditLogs1791774264314'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "audit_logs" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "actorId" uuid, "actorRole" character varying(50), "action" character varying(64) NOT NULL, "entityType" character varying(100) NOT NULL, "entityId" uuid, "metadata" jsonb NOT NULL DEFAULT '{}', "correlationId" character varying(128), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp(), CONSTRAINT "PK_1bb179d048bbc581caa3b013439" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_c69efb19bf127c97e6740ad530" ON "audit_logs"  ("createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_13c69424c440a0e765053feb4b" ON "audit_logs"  ("entityType", "entityId") `);

        // Append-only enforcement. Not generated from the entity; kept here by hand.
        // This stops application bugs and casual edits from rewriting history. It is
        // NOT a security boundary against someone with database access (they can set
        // the maintenance flag below or drop the trigger): production should also
        // revoke UPDATE/DELETE on this table from the application's database role.
        // The flag exists so test clean-up and a deliberate, reviewed data fix can
        // still remove rows: SET LOCAL app.audit_maintenance = 'on' inside a transaction.
        await queryRunner.query(`
            CREATE FUNCTION "audit_logs_block_modification"() RETURNS trigger AS $$
            BEGIN
                IF current_setting('app.audit_maintenance', true) = 'on' THEN
                    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
                    RETURN NEW;
                END IF;
                RAISE EXCEPTION 'audit_logs is append-only: % is not allowed', TG_OP
                    USING ERRCODE = 'insufficient_privilege';
            END;
            $$ LANGUAGE plpgsql
        `);
        await queryRunner.query(`
            CREATE TRIGGER "audit_logs_append_only"
            BEFORE UPDATE OR DELETE ON "audit_logs"
            FOR EACH ROW EXECUTE FUNCTION "audit_logs_block_modification"()
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TRIGGER "audit_logs_append_only" ON "audit_logs"`);
        await queryRunner.query(`DROP FUNCTION "audit_logs_block_modification"()`);
        await queryRunner.query(`DROP INDEX "public"."IDX_13c69424c440a0e765053feb4b"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c69efb19bf127c97e6740ad530"`);
        await queryRunner.query(`DROP TABLE "audit_logs"`);
    }

}
