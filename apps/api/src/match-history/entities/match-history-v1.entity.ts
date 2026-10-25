import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { MatchHistoryPlayer } from '../match-history.types';

export type MatchEnrichmentStatus = 'PENDING' | 'DONE' | 'NOT_FOUND' | 'FAILED';

@Entity('match_history_v1')
@Index('idx_match_history_user_v1', ['localSteamId', 'startedAt'])
export class MatchHistoryV1Entity {
  @PrimaryColumn({ type: 'varchar', length: 128 })
  matchId!: string;

  @Column({ type: 'varchar', length: 32 })
  localSteamId!: string;

  @Column({ type: 'int', nullable: true })
  localHeroId?: number | null;

  @Column({ type: 'int', nullable: true })
  kills?: number | null;

  @Column({ type: 'int', nullable: true })
  deaths?: number | null;

  @Column({ type: 'int', nullable: true })
  assists?: number | null;

  @Column({ type: 'bigint', nullable: true })
  souls?: string | null;

  @Column({ type: 'int', nullable: true })
  durationSec?: number | null;

  @Column({ type: 'jsonb' })
  players!: MatchHistoryPlayer[];

  @Column({ type: 'timestamptz' })
  startedAt!: Date;

  @Column({ type: 'timestamptz' })
  lastEventAt!: Date;

  @Column({ type: 'varchar', length: 16 })
  enrichmentStatus!: MatchEnrichmentStatus;

  @Column({ type: 'int' })
  enrichmentAttempts!: number;

  @Column({ type: 'timestamptz', nullable: true })
  enrichmentFetchedAt?: Date | null;

  @Column({ type: 'jsonb', nullable: true })
  enrichment?: Record<string, unknown> | null;

  @Column({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'timestamptz' })
  updatedAt!: Date;
}
