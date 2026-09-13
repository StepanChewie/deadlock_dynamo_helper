import { MigrationInterface, QueryRunner } from 'typeorm';

export class DropLegacyMatchAndCrawlerTables1789142400000 implements MigrationInterface {
  name = 'DropLegacyMatchAndCrawlerTables1789142400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // Children before parents. raw_match_metadata owns outbound FKs to
    // game_rulesets/item_catalog_versions; no surviving table references it.
    await queryRunner.query(`DROP TABLE IF EXISTS "match_player_skill_upgrades"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "match_player_items"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "match_players"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "matches"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "raw_match_metadata"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "crawler_runs"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "crawler_state"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "shadow_mode_decisions"`);
  }

  async down(): Promise<void> {
    // Deliberate no-op: recreating empty tables would not restore the dropped
    // match history. Restore from a pre-migration pg_dump instead.
  }
}
