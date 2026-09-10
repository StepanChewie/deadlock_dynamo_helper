import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('build_archetype_snapshots_v2')
@Index('idx_build_archetype_snapshot_scope_v2', [
  'heroId',
  'rulesetVersion',
  'statlockerPatchId',
  'catalogSha256',
  'isActive',
  'publishedAt',
])
export class BuildArchetypeSnapshotV2Entity {
  @PrimaryColumn({ type: 'varchar', length: 128 })
  snapshotId!: string;

  @Column({ type: 'int' })
  heroId!: number;

  @Column({ type: 'varchar', length: 128 })
  rulesetVersion!: string;

  @Column({ type: 'varchar', length: 128 })
  statlockerPatchId!: string;

  @Column({ type: 'char', length: 64 })
  catalogSha256!: string;

  @Column({ type: 'int' })
  sourceProfileCount!: number;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Column({ type: 'jsonb' })
  quality!: Record<string, unknown>;

  @Column({ type: 'timestamptz' })
  publishedAt!: Date;
}
