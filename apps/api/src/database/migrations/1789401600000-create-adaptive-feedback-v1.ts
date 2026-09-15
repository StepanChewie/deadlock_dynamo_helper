import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAdaptiveFeedbackV11789401600000 implements MigrationInterface {
  name = 'CreateAdaptiveFeedbackV11789401600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "adaptive_feedback_v1" (
        "id" bigserial NOT NULL,
        "appVersion" varchar(32) NOT NULL,
        "matchId" varchar(128) NOT NULL,
        "useful" boolean NOT NULL,
        "reason" varchar(64),
        "requestId" varchar(128),
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_adaptive_feedback_v1" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      COMMENT ON TABLE "adaptive_feedback_v1" IS
      'Post-match usefulness votes. Product signal only, never a training corpus (ADR-007). Stores no player identifier.'
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_adaptive_feedback_match_v1"
      ON "adaptive_feedback_v1" ("matchId", "createdAt" DESC)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "adaptive_feedback_v1"');
  }
}
