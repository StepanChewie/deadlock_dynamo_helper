import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateStatlockerVsHeroWpaRawSnapshotsV11788962400000 implements MigrationInterface {
  name = 'CreateStatlockerVsHeroWpaRawSnapshotsV11788962400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "statlocker_vs_hero_wpa_raw_snapshots_v1" (
        "snapshotId" varchar(96) NOT NULL,
        "contentSha256" char(64) NOT NULL,
        "fetchedAt" timestamptz NOT NULL,
        "sourcePath" varchar(512) NOT NULL,
        "sourceStatus" integer,
        "statlockerPatchId" varchar(128) NOT NULL,
        "rulesetVersion" varchar(128) NOT NULL,
        "catalogSha256" char(64) NOT NULL,
        "collectorVersion" varchar(64) NOT NULL,
        "rawPayload" jsonb NOT NULL,
        "ingestStatus" varchar(32) NOT NULL,
        "ingestMetadata" jsonb NOT NULL DEFAULT '{}',
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_statlocker_vs_hero_wpa_raw_snapshots_v1" PRIMARY KEY ("snapshotId"),
        CONSTRAINT "UQ_statlocker_vs_hero_wpa_raw_content_v1" UNIQUE ("contentSha256")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_statlocker_vs_hero_wpa_raw_identity_v1"
      ON "statlocker_vs_hero_wpa_raw_snapshots_v1" (
        "statlockerPatchId",
        "rulesetVersion",
        "catalogSha256",
        "fetchedAt"
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX IF EXISTS "idx_statlocker_vs_hero_wpa_raw_identity_v1"',
    );
    await queryRunner.query('DROP TABLE IF EXISTS "statlocker_vs_hero_wpa_raw_snapshots_v1"');
  }
}
