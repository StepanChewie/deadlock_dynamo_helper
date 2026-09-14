import { MigrationInterface, QueryRunner } from 'typeorm';

export class ScopeBuildArchetypeMatchLocksByPlayerV11789228800000 implements MigrationInterface {
  name = 'ScopeBuildArchetypeMatchLocksByPlayerV11789228800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // Lock rows from earlier deployments cannot be attributed to a player.
    // A lock only matters inside an active match (ADR-004), so dropping the
    // history costs at most one archetype re-selection for a match live during
    // the deploy.
    await queryRunner.query(`DELETE FROM "build_archetype_match_locks_v2"`);

    await queryRunner.query(`
      ALTER TABLE "build_archetype_match_locks_v2"
        ADD COLUMN "steamId" varchar(32) NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "build_archetype_match_locks_v2"
        DROP CONSTRAINT "PK_build_archetype_match_locks_v2"
    `);
    await queryRunner.query(`
      ALTER TABLE "build_archetype_match_locks_v2"
        ADD CONSTRAINT "PK_build_archetype_match_locks_v2" PRIMARY KEY ("matchId", "steamId")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_build_archetype_match_lock_player_v2"
      ON "build_archetype_match_locks_v2" ("steamId", "lockedAt")
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Deliberate no-op for the deleted rows; restore from a pg_dump if needed.
    await queryRunner.query('DROP INDEX IF EXISTS "idx_build_archetype_match_lock_player_v2"');
    await queryRunner.query('DELETE FROM "build_archetype_match_locks_v2"');
    await queryRunner.query(`
      ALTER TABLE "build_archetype_match_locks_v2"
        DROP CONSTRAINT "PK_build_archetype_match_locks_v2"
    `);
    await queryRunner.query(`
      ALTER TABLE "build_archetype_match_locks_v2"
        ADD CONSTRAINT "PK_build_archetype_match_locks_v2" PRIMARY KEY ("matchId")
    `);
    await queryRunner.query('ALTER TABLE "build_archetype_match_locks_v2" DROP COLUMN "steamId"');
  }
}
