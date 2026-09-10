import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateBuildArchetypeV2Runtime1789056000000 implements MigrationInterface {
  name = 'CreateBuildArchetypeV2Runtime1789056000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "build_archetype_snapshots_v2" (
        "snapshotId" varchar(128) NOT NULL,
        "heroId" integer NOT NULL,
        "rulesetVersion" varchar(128) NOT NULL,
        "statlockerPatchId" varchar(128) NOT NULL,
        "catalogSha256" char(64) NOT NULL,
        "sourceProfileCount" integer NOT NULL,
        "isActive" boolean NOT NULL DEFAULT true,
        "payload" jsonb NOT NULL,
        "quality" jsonb NOT NULL,
        "publishedAt" timestamptz NOT NULL,
        CONSTRAINT "PK_build_archetype_snapshots_v2" PRIMARY KEY ("snapshotId")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_build_archetype_snapshot_scope_v2"
      ON "build_archetype_snapshots_v2"
        ("heroId", "rulesetVersion", "statlockerPatchId", "catalogSha256", "isActive", "publishedAt")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_build_archetype_snapshot_active_scope_v2"
      ON "build_archetype_snapshots_v2" ("heroId", "rulesetVersion", "statlockerPatchId", "catalogSha256")
      WHERE "isActive" = true
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "build_archetype_match_locks_v2" (
        "matchId" varchar(128) NOT NULL,
        "heroId" integer NOT NULL,
        "snapshotId" varchar(128) NOT NULL,
        "archetypeId" varchar(192) NOT NULL,
        "enemyHeroIds" jsonb NOT NULL,
        "selection" jsonb NOT NULL,
        "degradedReasons" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "lockedAt" timestamptz NOT NULL,
        "lockedGameTimeS" double precision,
        CONSTRAINT "PK_build_archetype_match_locks_v2" PRIMARY KEY ("matchId"),
        CONSTRAINT "FK_build_archetype_match_lock_snapshot_v2"
          FOREIGN KEY ("snapshotId") REFERENCES "build_archetype_snapshots_v2"("snapshotId") ON DELETE RESTRICT
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_build_archetype_match_lock_hero_v2"
      ON "build_archetype_match_locks_v2" ("heroId", "lockedAt")
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "idx_build_archetype_match_lock_hero_v2"');
    await queryRunner.query('DROP TABLE IF EXISTS "build_archetype_match_locks_v2"');
    await queryRunner.query('DROP INDEX IF EXISTS "uq_build_archetype_snapshot_active_scope_v2"');
    await queryRunner.query('DROP INDEX IF EXISTS "idx_build_archetype_snapshot_scope_v2"');
    await queryRunner.query('DROP TABLE IF EXISTS "build_archetype_snapshots_v2"');
  }
}
