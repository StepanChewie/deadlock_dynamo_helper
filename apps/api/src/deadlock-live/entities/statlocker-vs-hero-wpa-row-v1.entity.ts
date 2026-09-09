import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('statlocker_vs_hero_wpa_rows_v1')
@Index(
  'idx_statlocker_vs_hero_wpa_identity_hero_enemy_v1',
  ['statlockerPatchId', 'rulesetVersion', 'catalogSha256', 'heroId', 'enemyHeroId'],
)
@Index(
  'idx_statlocker_vs_hero_wpa_identity_hero_item_v1',
  ['statlockerPatchId', 'rulesetVersion', 'catalogSha256', 'heroId', 'itemId'],
)
@Index(
  'uq_statlocker_vs_hero_wpa_source_row_v1',
  ['snapshotId', 'rankBucket', 'heroId', 'enemyHeroId', 'itemId'],
  { unique: true },
)
export class StatlockerVsHeroWpaRowV1Entity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 96 })
  snapshotId!: string;

  @Column({ type: 'varchar', length: 128 })
  statlockerPatchId!: string;

  @Column({ type: 'varchar', length: 128 })
  rulesetVersion!: string;

  @Column({ type: 'char', length: 64 })
  catalogSha256!: string;

  @Column({ type: 'varchar', length: 64 })
  rankBucket!: string;

  @Column({ type: 'integer' })
  heroId!: number;

  @Column({ type: 'integer' })
  enemyHeroId!: number;

  @Column({ type: 'bigint' })
  itemId!: number;

  @Column({ type: 'integer' })
  count!: number;

  @Column({ type: 'double precision' })
  deltaWpa!: number;

  @Column({ type: 'double precision', nullable: true })
  meanWpa?: number;
}
