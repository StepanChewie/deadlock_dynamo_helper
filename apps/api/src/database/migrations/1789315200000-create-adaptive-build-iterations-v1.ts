import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAdaptiveBuildIterationsV11789315200000 implements MigrationInterface {
  name = 'CreateAdaptiveBuildIterationsV11789315200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "adaptive_build_iterations_v1" (
        "id" bigserial NOT NULL,
        "matchId" varchar(128) NOT NULL,
        "steamId" varchar(32) NOT NULL,
        "heroId" integer,
        "gameTimeSec" integer,
        "kind" varchar(16) NOT NULL,
        "fingerprint" char(64) NOT NULL,
        "stateRevision" varchar(64) NOT NULL,
        "plan" jsonb,
        "rejects" jsonb,
        "archetype" jsonb,
        "score" jsonb NOT NULL,
        "evidence" jsonb NOT NULL,
        "context" jsonb NOT NULL,
        "blockers" jsonb,
        "truncated" boolean NOT NULL DEFAULT false,
        "pinned" boolean NOT NULL DEFAULT false,
        "capturedAt" timestamptz NOT NULL,
        CONSTRAINT "PK_adaptive_build_iterations_v1" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      COMMENT ON TABLE "adaptive_build_iterations_v1" IS
      'Per-iteration recommendation history for incident review only. Never a training corpus (ADR-007).'
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN "adaptive_build_iterations_v1"."rejects" IS
      'Candidates rejected or suppressed by hysteresis. Incident review only (ADR-007).'
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_build_iteration_plan_v1"
      ON "adaptive_build_iterations_v1" ("matchId", "steamId", "fingerprint")
      WHERE "kind" = 'PLAN'
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_build_iteration_not_ready_v1"
      ON "adaptive_build_iterations_v1" ("matchId", "steamId", "fingerprint")
      WHERE "kind" = 'NOT_READY'
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_build_iteration_match_v1"
      ON "adaptive_build_iterations_v1" ("matchId", "capturedAt")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_build_iteration_player_v1"
      ON "adaptive_build_iterations_v1" ("steamId", "capturedAt" DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_build_iteration_retention_v1"
      ON "adaptive_build_iterations_v1" ("capturedAt")
      WHERE "pinned" = false
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "adaptive_build_iterations_v1"');
  }
}
