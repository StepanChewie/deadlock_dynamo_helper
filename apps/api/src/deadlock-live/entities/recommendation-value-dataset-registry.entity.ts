import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { RecommendationValueDatasetManifestV1 } from '@deadlock-live-probe/shared';

export type RecommendationValueDatasetRegistryStatusV1 = 'REGISTERED' | 'VERIFIED';

export interface RecommendationValueDatasetArtifactVerificationV1 {
  verifier: string;
  verifiedManifestSha256: string;
  verifiedFiles: readonly { path: string; sha256: string; sizeBytes: number; rowCount: number }[];
  attestationRef?: string;
}

@Entity('recommendation_value_dataset_registry_v1')
export class RecommendationValueDatasetRegistryV1 {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('idx_recommendation_value_dataset_registry_v1_dataset_id', { unique: true })
  @Column({ type: 'varchar', length: 128 })
  datasetId!: string;

  @Index('idx_recommendation_value_dataset_registry_v1_dataset_sha256', { unique: true })
  @Column({ type: 'char', length: 64 })
  datasetSha256!: string;

  @Index('idx_recommendation_value_dataset_registry_v1_manifest_sha256', { unique: true })
  @Column({ type: 'char', length: 64 })
  manifestSha256!: string;

  @Column({ type: 'varchar', length: 2048 })
  objectBaseUri!: string;

  @Column({ type: 'jsonb' })
  manifest!: RecommendationValueDatasetManifestV1;

  @Index('idx_recommendation_value_dataset_registry_v1_status')
  @Column({ type: 'varchar', length: 32, default: 'REGISTERED' })
  status!: RecommendationValueDatasetRegistryStatusV1;

  @Column({ type: 'jsonb', nullable: true })
  verification?: RecommendationValueDatasetArtifactVerificationV1;

  @CreateDateColumn({ type: 'timestamptz' })
  registeredAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  verifiedAt?: Date;
}
