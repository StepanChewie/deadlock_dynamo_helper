import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateMatchHistoryV11792982400000 implements MigrationInterface {
  name = 'CreateMatchHistoryV11792982400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "app_users_v1" (
        "steamId" varchar(32) NOT NULL,
        "playerName" varchar(128),
        "lastClientId" varchar(128),
        "firstSeenAt" timestamptz NOT NULL DEFAULT now(),
        "lastSeenAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_app_users_v1" PRIMARY KEY ("steamId")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "match_history_v1" (
        "matchId" varchar(128) NOT NULL,
        "localSteamId" varchar(32) NOT NULL,
        "localHeroId" int,
        "kills" int,
        "deaths" int,
        "assists" int,
        "souls" bigint,
        "durationSec" int,
        "players" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "startedAt" timestamptz NOT NULL,
        "lastEventAt" timestamptz NOT NULL,
        "enrichmentStatus" varchar(16) NOT NULL DEFAULT 'PENDING',
        "enrichmentAttempts" int NOT NULL DEFAULT 0,
        "enrichmentFetchedAt" timestamptz,
        "enrichment" jsonb,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_match_history_v1" PRIMARY KEY ("matchId")
      )
    `);
    await queryRunner.query(`
      COMMENT ON TABLE "match_history_v1" IS
        'Per-user match summaries projected from live ingest; enrichment column holds the raw deadlock-api /v1/matches response.'
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_match_history_user_v1"
      ON "match_history_v1" ("localSteamId", "startedAt" DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_match_history_enrichment_v1"
      ON "match_history_v1" ("enrichmentStatus")
      WHERE "enrichmentStatus" IN ('PENDING', 'FAILED', 'NOT_FOUND')
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "match_history_v1"');
    await queryRunner.query('DROP TABLE IF EXISTS "app_users_v1"');
  }
}
