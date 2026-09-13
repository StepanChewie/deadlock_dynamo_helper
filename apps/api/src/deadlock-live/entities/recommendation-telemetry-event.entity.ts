import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('recommendation_telemetry_events')
export class RecommendationTelemetryEvent {
  @PrimaryColumn({ type: 'varchar', length: 128 })
  eventId!: string;

  @Index('idx_recommendation_telemetry_dedup_key', { unique: true })
  @Column({ type: 'varchar', length: 512 })
  deduplicationKey!: string;

  @Column({ type: 'int' })
  schemaVersion!: number;

  @Column({ type: 'varchar', length: 64 })
  contractVersion!: string;

  @Index('idx_recommendation_telemetry_event_type')
  @Column({ type: 'varchar', length: 64 })
  eventType!: string;

  @Index('idx_recommendation_telemetry_match_id')
  @Column({ type: 'varchar', length: 128 })
  matchId!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  playerKey?: string;

  @Column({ type: 'varchar', length: 64 })
  source!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  sourceEventId?: string;

  @Index('idx_recommendation_telemetry_source_occurred_at')
  @Column({ type: 'timestamptz' })
  sourceOccurredAt!: Date;

  @Column({ type: 'timestamptz' })
  receivedAt!: Date;

  @Column({ type: 'int', nullable: true })
  gameTimeMs?: number;

  @Column({ type: 'int', nullable: true })
  sequenceNo?: number;

  @Column({ type: 'varchar', length: 128 })
  clientVersion!: string;

  @Column({ type: 'varchar', length: 128 })
  gepVersion!: string;

  @Column({ type: 'varchar', length: 128 })
  normalizerVersion!: string;

  @Column({ type: 'varchar', length: 128 })
  rulesetVersion!: string;

  @Column({ type: 'char', length: 64 })
  catalogSha256!: string;

  @Column({ type: 'boolean' })
  directlyObserved!: boolean;

  @Column({ type: 'boolean' })
  reconstructed!: boolean;

  @Column({ type: 'boolean' })
  stale!: boolean;

  @Column({ type: 'int' })
  alignmentAgeMs!: number;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;
}
