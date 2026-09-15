import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { SoulsAffordabilityControlledObservationV2 } from '@dynamo-lab/shared';

@Entity('souls_affordability_evidence_v2')
export class SoulsAffordabilityEvidenceV2Entity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('idx_souls_affordability_evidence_v2_observation_id', { unique: true })
  @Column({ type: 'varchar', length: 128 })
  observationId!: string;

  @Index('idx_souls_affordability_evidence_v2_session_id')
  @Column({ type: 'varchar', length: 128 })
  sessionId!: string;

  @Index('idx_souls_affordability_evidence_v2_ruleset')
  @Column({ type: 'varchar', length: 128 })
  rulesetVersion!: string;

  @Index('idx_souls_affordability_evidence_v2_catalog')
  @Column({ type: 'char', length: 64 })
  catalogSha256!: string;

  @Column({ type: 'jsonb' })
  observation!: SoulsAffordabilityControlledObservationV2;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
