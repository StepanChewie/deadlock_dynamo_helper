import { Column, Entity, Index, PrimaryGeneratedColumn, ValueTransformer } from 'typeorm';

const SAFE_BIGINT_NUMBER_TRANSFORMER: ValueTransformer = {
  to(value: number): number {
    return value;
  },
  from(value: string | number): number {
    const normalized = Number(value);
    if (!Number.isSafeInteger(normalized)) {
      throw new Error(`Unsafe bigint value for Statlocker itemId: ${String(value)}`);
    }
    return normalized;
  },
};

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

  @Column({ type: 'bigint', transformer: SAFE_BIGINT_NUMBER_TRANSFORMER })
  itemId!: number;

  @Column({ type: 'integer' })
  count!: number;

  @Column({ type: 'double precision' })
  deltaWpa!: number;

  @Column({ type: 'double precision', nullable: true })
  meanWpa?: number;
}
