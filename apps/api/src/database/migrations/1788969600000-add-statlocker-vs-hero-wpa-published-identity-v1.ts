import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddStatlockerVsHeroWpaPublishedIdentityV11788969600000 implements MigrationInterface {
  name = 'AddStatlockerVsHeroWpaPublishedIdentityV11788969600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_statlocker_vs_hero_wpa_published_identity_v1"
      ON "statlocker_vs_hero_wpa_raw_snapshots_v1" (
        "statlockerPatchId",
        "rulesetVersion",
        "catalogSha256"
      )
      WHERE "ingestStatus" = 'PUBLISHED'
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX IF EXISTS "uq_statlocker_vs_hero_wpa_published_identity_v1"',
    );
  }
}
