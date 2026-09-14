import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Build iteration history for incident review only.
 * Never a training corpus — see ADR-007.
 */
@Entity('adaptive_build_iterations_v1')
@Index('idx_build_iteration_match_v1', ['matchId', 'capturedAt'])
@Index('idx_build_iteration_player_v1', ['steamId', 'capturedAt'])
export class AdaptiveBuildIterationV1Entity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ type: 'varchar', length: 128 })
  matchId!: string;

  @Column({ type: 'varchar', length: 32 })
  steamId!: string;

  @Column({ type: 'int', nullable: true })
  heroId?: number | null;

  @Column({ type: 'int', nullable: true })
  gameTimeSec?: number | null;

  @Column({ type: 'varchar', length: 16 })
  kind!: 'PLAN' | 'NOT_READY';

  @Column({ type: 'char', length: 64 })
  fingerprint!: string;

  @Column({ type: 'varchar', length: 64 })
  stateRevision!: string;

  @Column({ type: 'jsonb', nullable: true })
  plan?: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  rejects?: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  archetype?: Record<string, unknown> | null;

  @Column({ type: 'jsonb' })
  score!: Record<string, unknown>;

  @Column({ type: 'jsonb' })
  evidence!: Record<string, unknown>;

  @Column({ type: 'jsonb' })
  context!: Record<string, unknown>;

  @Column({ type: 'jsonb', nullable: true })
  blockers?: string[] | null;

  @Column({ type: 'boolean', default: false })
  truncated!: boolean;

  @Column({ type: 'boolean', default: false })
  pinned!: boolean;

  @Column({ type: 'timestamptz' })
  capturedAt!: Date;
}
