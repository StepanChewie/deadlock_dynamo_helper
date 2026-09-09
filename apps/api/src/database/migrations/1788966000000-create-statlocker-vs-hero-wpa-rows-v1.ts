import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateStatlockerVsHeroWpaRowsV11788966000000 implements MigrationInterface {
  name = 'CreateStatlockerVsHeroWpaRowsV11788966000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "statlocker_vs_hero_wpa_rows_v1" (
        "id" SERIAL NOT NULL,
        "snapshotId" varchar(96) NOT NULL,
        "statlockerPatchId" varchar(128) NOT NULL,
        "rulesetVersion" varchar(128) NOT NULL,
        "catalogSha256" char(64) NOT NULL,
        "rankBucket" varchar(64) NOT NULL,
        "heroId" integer NOT NULL,
        "enemyHeroId" integer NOT NULL,
        "itemId" bigint NOT NULL,
        "count" integer NOT NULL,
        "deltaWpa" double precision NOT NULL,
        "meanWpa" double precision,
        CONSTRAINT "PK_statlocker_vs_hero_wpa_rows_v1" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_statlocker_vs_hero_wpa_identity_hero_enemy_v1"
      ON "statlocker_vs_hero_wpa_rows_v1" (
        "statlockerPatchId",
        "rulesetVersion",
        "catalogSha256",
        "heroId",
        "enemyHeroId"
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_statlocker_vs_hero_wpa_identity_hero_item_v1"
      ON "statlocker_vs_hero_wpa_rows_v1" (
        "statlockerPatchId",
        "rulesetVersion",
        "catalogSha256",
        "heroId",
        "itemId"
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_statlocker_vs_hero_wpa_source_row_v1"
      ON "statlocker_vs_hero_wpa_rows_v1" (
        "snapshotId",
        "rankBucket",
        "heroId",
        "enemyHeroId",
        "itemId"
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX IF EXISTS "uq_statlocker_vs_hero_wpa_source_row_v1"',
    );
    await queryRunner.query(
      'DROP INDEX IF EXISTS "idx_statlocker_vs_hero_wpa_identity_hero_item_v1"',
    );
    await queryRunner.query(
      'DROP INDEX IF EXISTS "idx_statlocker_vs_hero_wpa_identity_hero_enemy_v1"',
    );
    await queryRunner.query('DROP TABLE IF EXISTS "statlocker_vs_hero_wpa_rows_v1"');
  }
}
