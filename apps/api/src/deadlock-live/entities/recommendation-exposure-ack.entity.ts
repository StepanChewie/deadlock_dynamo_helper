import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('recommendation_exposure_acks_v8')
export class RecommendationExposureAckV8 {
  @PrimaryColumn({ type: 'varchar', length: 128 })
  eventId!: string;

  @Index('idx_recommendation_exposure_acks_v8_decision_id')
  @Column({ type: 'varchar', length: 128 })
  decisionId!: string;

  @Column({ type: 'varchar', length: 255 })
  selectedActionKey!: string;

  @Index('idx_recommendation_exposure_acks_v8_displayed_at')
  @Column({ type: 'timestamptz' })
  displayedAt!: Date;

  @Column({ type: 'jsonb' })
  displayOrder!: string[];

  @Column({ type: 'int' })
  ttlMs!: number;
}
