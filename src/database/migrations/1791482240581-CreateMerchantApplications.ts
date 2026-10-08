import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateMerchantApplications1791482240581 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."application_status" AS ENUM('DRAFT', 'SUBMITTED', 'IN_REVIEW', 'INFO_REQUESTED', 'APPROVED', 'REJECTED')`);
        await queryRunner.query(`CREATE TYPE "public"."risk_status" AS ENUM('NOT_STARTED', 'PENDING', 'COMPLETED', 'FAILED')`);
        await queryRunner.query(`CREATE TABLE "merchant_applications" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "businessName" character varying(255) NOT NULL, "legalBusinessName" character varying(255) NOT NULL, "businessType" character varying(100) NOT NULL, "ownerName" character varying(255) NOT NULL, "ownerEmail" character varying(255) NOT NULL, "ownerPhone" character varying(50) NOT NULL, "ownerTaxId" text NOT NULL, "monthlyVolume" numeric(14,2) NOT NULL, "averageTicketSize" numeric(12,2) NOT NULL, "currency" character(3) NOT NULL, "status" "public"."application_status" NOT NULL DEFAULT 'DRAFT', "riskStatus" "public"."risk_status" NOT NULL DEFAULT 'NOT_STARTED', "riskScore" integer, "riskResult" jsonb, "createdById" uuid NOT NULL, "assignedReviewerId" uuid, "decisionReason" text, "decidedAt" TIMESTAMP WITH TIME ZONE, "submittedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_09b9df0877db73b8a232c8c7ed4" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_5ef72d2f5091a614fa6c9300c0" ON "merchant_applications"  ("createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_7cebc08ee446c36158cbd584a0" ON "merchant_applications"  ("assignedReviewerId") `);
        await queryRunner.query(`CREATE INDEX "IDX_524da5b7f60bec9e2c86797f58" ON "merchant_applications"  ("createdById") `);
        await queryRunner.query(`CREATE INDEX "IDX_f9b444dd14c28c317a317eddac" ON "merchant_applications"  ("status") `);
        await queryRunner.query(`ALTER TABLE "merchant_applications" ADD CONSTRAINT "FK_524da5b7f60bec9e2c86797f58c" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "merchant_applications" ADD CONSTRAINT "FK_7cebc08ee446c36158cbd584a0a" FOREIGN KEY ("assignedReviewerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "merchant_applications" DROP CONSTRAINT "FK_7cebc08ee446c36158cbd584a0a"`);
        await queryRunner.query(`ALTER TABLE "merchant_applications" DROP CONSTRAINT "FK_524da5b7f60bec9e2c86797f58c"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_f9b444dd14c28c317a317eddac"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_524da5b7f60bec9e2c86797f58"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_7cebc08ee446c36158cbd584a0"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_5ef72d2f5091a614fa6c9300c0"`);
        await queryRunner.query(`DROP TABLE "merchant_applications"`);
        await queryRunner.query(`DROP TYPE "public"."risk_status"`);
        await queryRunner.query(`DROP TYPE "public"."application_status"`);
    }

}
