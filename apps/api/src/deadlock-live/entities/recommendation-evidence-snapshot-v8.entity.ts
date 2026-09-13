import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import { RecommendationRoadmapEvidenceGateNameV1 } from '@deadlock-live-probe/shared';

@Entity('recommendation_evidence_snapshots_v8')
export class RecommendationEvidenceSnapshotV8 {
  @PrimaryColumn({ type: 'char', length: 64 })
  subjectSha256!: string;

  @Index('idx_recommendation_evidence_snapshots_v8_gate')
  @Column({ type: 'varchar', length: 64 })
  gateName!: RecommendationRoadmapEvidenceGateNameV1;

  @Column({ type: 'varchar', length: 256 })
  evaluator!: string;

  @Column({ type: 'timestamptz' })
  evaluatedAt!: Date;

  @Column({ type: 'jsonb' })
  report!: unknown;

  @CreateDateColumn({ type: 'timestamptz' })
  recordedAt!: Date;
}
