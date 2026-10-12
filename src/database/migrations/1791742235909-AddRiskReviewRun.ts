import { MigrationInterface, QueryRunner } from "typeorm";

export class AddRiskReviewRun1791742235909 implements MigrationInterface {
    name = 'AddRiskReviewRun1791742235909'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "merchant_applications" ADD "riskReviewRun" integer NOT NULL DEFAULT '0'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "merchant_applications" DROP COLUMN "riskReviewRun"`);
    }

}
