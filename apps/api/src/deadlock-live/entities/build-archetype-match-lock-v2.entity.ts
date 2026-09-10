import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('build_archetype_match_locks_v2')
@Index('idx_build_archetype_match_lock_hero_v2', ['heroId', 'lockedAt'])
export class BuildArchetypeMatchLockV2Entity {
  @PrimaryColumn({ type: 'varchar', length: 128 })
  matchId!: string;

  @Column({ type: 'int' })
  heroId!: number;

  @Column({ type: 'varchar', length: 128 })
  snapshotId!: string;

  @Column({ type: 'varchar', length: 192 })
  archetypeId!: string;

  @Column({ type: 'jsonb' })
  enemyHeroIds!: number[];

  @Column({ type: 'jsonb' })
  selection!: Record<string, unknown>;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  degradedReasons!: string[];

  @Column({ type: 'timestamptz' })
  lockedAt!: Date;

  @Column({ type: 'double precision', nullable: true })
  lockedGameTimeS?: number;
}
