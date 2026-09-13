import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import {
  RecommendationRoadmapEvidenceGateNameV1,
  RecommendationRoadmapEvidenceRecordV1,
  RecommendationRoadmapGateStateV1,
} from '@deadlock-live-probe/shared';

@Entity('recommendation_roadmap_evidence_v1')
export class RecommendationRoadmapEvidenceEntityV1 {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('idx_recommendation_roadmap_evidence_v1_evidence_id', { unique: true })
  @Column({ type: 'varchar', length: 128 })
  evidenceId!: string;

  @Index('idx_recommendation_roadmap_evidence_v1_gate')
  @Column({ type: 'varchar', length: 64 })
  gateName!: RecommendationRoadmapEvidenceGateNameV1;

  @Column({ type: 'varchar', length: 32 })
  status!: RecommendationRoadmapGateStateV1;

  @Column({ type: 'varchar', length: 2048 })
  evidenceRef!: string;

  @Column({ type: 'varchar', length: 256 })
  evaluator!: string;

  @Column({ type: 'timestamptz' })
  evaluatedAt!: Date;

  @Column({ type: 'char', length: 64, nullable: true })
  subjectSha256?: string;

  @Column({ type: 'text', nullable: true })
  notes?: string;

  @Column({ type: 'jsonb' })
  record!: RecommendationRoadmapEvidenceRecordV1;

  @CreateDateColumn({ type: 'timestamptz' })
  recordedAt!: Date;
}
