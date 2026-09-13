import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { ModelBundleManifestV1 } from '@deadlock-live-probe/shared';

export type ModelBundleRegistryStatus = 'REGISTERED' | 'VERIFIED' | 'ACTIVE' | 'RETIRED';

export interface ModelBundleArtifactVerificationV1 {
  verifier: string;
  verifiedManifestSha256: string;
  verifiedFiles: readonly { path: string; sha256: string; sizeBytes: number }[];
  attestationRef?: string;
}

@Entity('model_bundle_registry_v1')
@Index('idx_model_bundle_registry_v1_identity', ['modelId', 'modelVersion'], { unique: true })
export class ModelBundleRegistryV1 {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('idx_model_bundle_registry_v1_model_id')
  @Column({ type: 'varchar', length: 128 })
  modelId!: string;

  @Column({ type: 'varchar', length: 128 })
  modelVersion!: string;

  @Index('idx_model_bundle_registry_v1_manifest_sha256', { unique: true })
  @Column({ type: 'char', length: 64 })
  manifestSha256!: string;

  @Column({ type: 'jsonb' })
  manifest!: ModelBundleManifestV1;

  @Column({ type: 'varchar', length: 1024 })
  artifactBaseUri!: string;

  @Index('idx_model_bundle_registry_v1_status')
  @Column({ type: 'varchar', length: 32, default: 'REGISTERED' })
  status!: ModelBundleRegistryStatus;

  @Column({ type: 'jsonb', nullable: true })
  verification?: ModelBundleArtifactVerificationV1;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  verifiedAt?: Date;

  @Column({ type: 'timestamptz', nullable: true })
  activatedAt?: Date;

  @Column({ type: 'timestamptz', nullable: true })
  retiredAt?: Date;
}
