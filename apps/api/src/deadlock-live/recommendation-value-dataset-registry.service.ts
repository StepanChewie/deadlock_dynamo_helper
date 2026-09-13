import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  RecommendationValueDatasetManifestV1,
  validateRecommendationValueDatasetManifestV1,
} from '@deadlock-live-probe/shared';
import {
  RecommendationValueDatasetArtifactVerificationV1,
  RecommendationValueDatasetRegistryV1,
} from './entities/recommendation-value-dataset-registry.entity';

export interface RegisterRecommendationValueDatasetV1Input {
  manifest: RecommendationValueDatasetManifestV1;
  objectBaseUri: string;
}

export interface VerifyRecommendationValueDatasetV1Input {
  datasetId: string;
  verifier: string;
  manifestSha256: string;
  files: readonly { path: string; sha256: string; sizeBytes: number; rowCount: number }[];
  attestationRef?: string;
}

@Injectable()
export class RecommendationValueDatasetRegistryService {
  constructor(
    @InjectRepository(RecommendationValueDatasetRegistryV1)
    private readonly registryRepo: Repository<RecommendationValueDatasetRegistryV1>,
  ) {}

  async register(input: RegisterRecommendationValueDatasetV1Input): Promise<RecommendationValueDatasetRegistryV1> {
    const errors = validateRecommendationValueDatasetManifestV1(input.manifest);
    if (errors.length > 0) throw new Error(`Invalid causal Value dataset manifest: ${errors.join(',')}`);
    const objectBaseUri = validateArtifactBaseUri(input.objectBaseUri);
    const manifestSha256 = valueDatasetManifestSha256V1(input.manifest);
    const existing = await this.registryRepo.findOne({ where: { datasetId: input.manifest.datasetId } });
    if (existing) {
      assertIdentity(existing, input.manifest, manifestSha256, objectBaseUri);
      return existing;
    }
    try {
      return await this.registryRepo.save(this.registryRepo.create({
        datasetId: input.manifest.datasetId,
        datasetSha256: input.manifest.datasetSha256,
        manifestSha256,
        objectBaseUri,
        manifest: canonicalizeManifest(input.manifest),
        status: 'REGISTERED',
      }));
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.registryRepo.findOne({ where: { datasetId: input.manifest.datasetId } });
      if (!raced) throw error;
      assertIdentity(raced, input.manifest, manifestSha256, objectBaseUri);
      return raced;
    }
  }

  async verify(input: VerifyRecommendationValueDatasetV1Input): Promise<RecommendationValueDatasetRegistryV1> {
    if (!input.verifier) throw new Error('verifier is required');
    const target = await this.registryRepo.findOne({ where: { datasetId: input.datasetId } });
    if (!target) throw new Error(`Causal Value dataset not found: ${input.datasetId}`);
    if (target.manifestSha256 !== input.manifestSha256) {
      throw new Error('Verified manifest SHA does not match registered causal Value manifest');
    }
    const expectedFiles = normalizedFiles(target.manifest.files);
    const verifiedFiles = normalizedFiles(input.files);
    if (JSON.stringify(expectedFiles) !== JSON.stringify(verifiedFiles)) {
      throw new Error('Verified causal Value files do not exactly match manifest');
    }
    const verification: RecommendationValueDatasetArtifactVerificationV1 = {
      verifier: input.verifier,
      verifiedManifestSha256: input.manifestSha256,
      verifiedFiles,
      attestationRef: input.attestationRef,
    };
    target.verification = verification;
    target.verifiedAt = new Date();
    target.status = 'VERIFIED';
    return this.registryRepo.save(target);
  }

  async getVerified(datasetId: string): Promise<RecommendationValueDatasetRegistryV1> {
    const target = await this.registryRepo.findOne({ where: { datasetId } });
    if (!target) throw new Error(`Causal Value dataset not found: ${datasetId}`);
    if (target.status !== 'VERIFIED') throw new Error(`Causal Value dataset is not verified: ${target.status}`);
    if (!target.verification || target.verification.verifiedManifestSha256 !== target.manifestSha256) {
      throw new Error('Causal Value dataset verification evidence is missing or stale');
    }
    if (JSON.stringify(normalizedFiles(target.manifest.files)) !== JSON.stringify(normalizedFiles(target.verification.verifiedFiles))) {
      throw new Error('Causal Value dataset verification file evidence is missing or stale');
    }
    if (!target.verifiedAt || !Number.isFinite(target.verifiedAt.getTime())) {
      throw new Error('Causal Value dataset verification timestamp is missing or invalid');
    }
    return target;
  }
}

export function valueDatasetManifestSha256V1(manifest: RecommendationValueDatasetManifestV1): string {
  return createHash('sha256').update(canonicalJson(canonicalizeManifest(manifest))).digest('hex');
}

function assertIdentity(
  entity: RecommendationValueDatasetRegistryV1,
  manifest: RecommendationValueDatasetManifestV1,
  manifestSha256: string,
  objectBaseUri: string,
): void {
  if (
    entity.datasetSha256 !== manifest.datasetSha256
    || entity.manifestSha256 !== manifestSha256
    || entity.objectBaseUri !== objectBaseUri
  ) throw new Error(`Immutable causal Value dataset identity conflict: ${manifest.datasetId}`);
}

function canonicalizeManifest(manifest: RecommendationValueDatasetManifestV1): RecommendationValueDatasetManifestV1 {
  return {
    ...manifest,
    splits: [...manifest.splits].map((split) => ({ ...split })),
    files: [...manifest.files].map((file) => ({ ...file })).sort((left, right) => left.path.localeCompare(right.path)),
  };
}

function normalizedFiles(
  files: readonly { path: string; sha256: string; sizeBytes: number; rowCount: number }[],
): Array<{ path: string; sha256: string; sizeBytes: number; rowCount: number }> {
  return files
    .map((file) => ({ path: file.path, sha256: file.sha256, sizeBytes: file.sizeBytes, rowCount: file.rowCount }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function validateArtifactBaseUri(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('objectBaseUri is required');
  if (trimmed.includes('..')) throw new Error('objectBaseUri must not contain parent traversal');
  if (/^(s3|gs|https):\/\//.test(trimmed)) return trimmed.replace(/\/+$/, '');
  if (process.env.NODE_ENV !== 'production' && process.env.RECOMMENDATION_ALLOW_LOCAL_ARTIFACTS === 'true' && trimmed.startsWith('file://')) {
    return trimmed.replace(/\/+$/, '');
  }
  throw new Error('objectBaseUri must use an approved immutable remote store');
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}
