import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, Unique } from 'typeorm';

@Entity('statlocker_vs_hero_wpa_raw_snapshots_v1')
@Unique('uq_statlocker_vs_hero_wpa_raw_content_v1', ['contentSha256'])
@Index(
  'uq_statlocker_vs_hero_wpa_published_identity_v1',
  ['statlockerPatchId', 'rulesetVersion', 'catalogSha256'],
  { unique: true, where: `"ingestStatus" = 'PUBLISHED'` },
)
export class StatlockerVsHeroWpaRawSnapshotV1Entity {
  @PrimaryColumn({ type: 'varchar', length: 96 })
  snapshotId!: string;

  @Column({ type: 'char', length: 64 })
  contentSha256!: string;

  @Column({ type: 'timestamptz' })
  fetchedAt!: Date;

  @Column({ type: 'varchar', length: 512 })
  sourcePath!: string;

  @Column({ type: 'integer', nullable: true })
  sourceStatus!: number;

  @Column({ type: 'varchar', length: 128 })
  statlockerPatchId!: string;

  @Column({ type: 'varchar', length: 128 })
  rulesetVersion!: string;

  @Column({ type: 'char', length: 64 })
  catalogSha256!: string;

  @Column({ type: 'varchar', length: 64 })
  collectorVersion!: string;

  @Column({ type: 'jsonb' })
  rawPayload!: unknown;

  @Column({ type: 'varchar', length: 32 })
  ingestStatus!: string;

  @Column({ type: 'jsonb', default: {} })
  ingestMetadata!: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
