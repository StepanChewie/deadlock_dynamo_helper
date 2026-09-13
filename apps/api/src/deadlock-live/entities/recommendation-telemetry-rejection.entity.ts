import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('recommendation_telemetry_rejections_v8')
export class RecommendationTelemetryRejectionV8 {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('idx_recommendation_telemetry_rejections_v8_received_at')
  @CreateDateColumn({ type: 'timestamptz' })
  receivedAt!: Date;

  @Column({ type: 'varchar', length: 128, nullable: true })
  eventId?: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  eventType?: string;

  @Column({ type: 'varchar', length: 128, nullable: true })
  matchId?: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  playerKey?: string;

  @Column({ type: 'varchar', length: 128, nullable: true })
  source?: string;

  @Index('idx_recommendation_telemetry_rejections_v8_runtime_mode')
  @Column({ type: 'varchar', length: 32, nullable: true })
  runtimeMode?: string;

  @Column({ type: 'jsonb' })
  errors!: string[];
}
