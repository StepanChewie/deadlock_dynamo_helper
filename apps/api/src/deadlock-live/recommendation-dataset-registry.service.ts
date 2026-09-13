import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  RecommendationDatasetArtifactFileV1,
  RecommendationDatasetManifestV1,
  assertRecommendationDatasetManifestV1,
} from '@deadlock-live-probe/shared';
import {
  RecommendationDatasetArtifactVerificationV1,
  RecommendationDatasetRegistryV1,
} from './entities/recommendation-dataset-registry.entity';

export interface RegisterRecommendationDatasetV1Input {
  manifest: RecommendationDatasetManifestV1;
  objectBaseUri: string;
}

export interface RegisterRecommendationDatasetV1Result {
  status: 'REGISTERED' | 'DUPLICATE';
  datasetId: string;
  datasetSha256: string;
  manifestSha256: string;
}

export interface VerifyRecommendationDatasetV1Input {
  datasetId: string;
  verifier: string;
  manifestSha256: string;
  files: readonly RecommendationDatasetArtifactFileV1[];
  attestationRef?: string;
}

@Injectable()
export class RecommendationDatasetRegistryService {
  constructor(
    @InjectRepository(RecommendationDatasetRegistryV1)
    private readonly datasetRepo: Repository<RecommendationDatasetRegistryV1>,
  ) {}

  async register(input: RegisterRecommendationDatasetV1Input): Promise<RegisterRecommendationDatasetV1Result> {
    assertRecommendationDatasetManifestV1(input.manifest);
    assertRemoteImmutableUri(input.objectBaseUri);
    const manifestSha256 = hashCanonicalJson(input.manifest);
    const existing = await this.datasetRepo.findOne({ where: { datasetId: input.manifest.datasetId } });
    if (existing) {
      assertRegistryIdentity(existing);
      if (
        existing.datasetSha256 !== input.manifest.datasetSha256
        || existing.manifestSha256 !== manifestSha256
        || existing.objectBaseUri !== input.objectBaseUri
      ) {
        throw new Error(`Immutable dataset registry conflict: ${input.manifest.datasetId}`);
      }
      return result('DUPLICATE', existing);
    }

    try {
      const saved = await this.datasetRepo.save(this.datasetRepo.create({
        datasetId: input.manifest.datasetId,
        datasetSha256: input.manifest.datasetSha256,
        manifestSha256,
        objectBaseUri: input.objectBaseUri,
        manifest: input.manifest,
        status: 'REGISTERED',
      }));
      return result('REGISTERED', saved);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.datasetRepo.findOne({ where: { datasetId: input.manifest.datasetId } });
      if (!raced) throw error;
      assertRegistryIdentity(raced);
      if (
        raced.datasetSha256 !== input.manifest.datasetSha256
        || raced.manifestSha256 !== manifestSha256
        || raced.objectBaseUri !== input.objectBaseUri
      ) {
        throw new Error(`Immutable dataset registry conflict: ${input.manifest.datasetId}`);
      }
      return result('DUPLICATE', raced);
    }
  }

  async verify(input: VerifyRecommendationDatasetV1Input): Promise<RecommendationDatasetRegistryV1> {
    if (!input.datasetId) throw new Error('datasetId is required');
    if (!input.verifier) throw new Error('verifier is required');
    const row = await this.get(input.datasetId);
    assertRegistryIdentity(row);
    if (row.manifestSha256 !== input.manifestSha256) {
      throw new Error('Verified dataset manifest SHA does not match registry');
    }
    const expectedFiles = normalizeFiles(row.manifest.files);
    const verifiedFiles = normalizeFiles(input.files);
    if (JSON.stringify(expectedFiles) !== JSON.stringify(verifiedFiles)) {
      throw new Error('Verified dataset files do not exactly match dataset manifest');
    }
    if (row.status === 'VERIFIED') {
      assertFreshVerification(row);
      const current = row.verification;
      if (
        current?.verifiedManifestSha256 !== input.manifestSha256
        || JSON.stringify(normalizeFiles(current.verifiedFiles)) !== JSON.stringify(verifiedFiles)
      ) {
        throw new Error(`Immutable verified dataset conflict: ${input.datasetId}`);
      }
      return row;
    }
    const verification: RecommendationDatasetArtifactVerificationV1 = {
      verifier: input.verifier,
      verifiedManifestSha256: input.manifestSha256,
      verifiedFiles,
      attestationRef: input.attestationRef,
    };
    row.verification = verification;
    row.verifiedAt = new Date();
    row.status = 'VERIFIED';
    return this.datasetRepo.save(row);
  }

  async get(datasetId: string): Promise<RecommendationDatasetRegistryV1> {
    if (!datasetId) throw new Error('datasetId is required');
    const row = await this.datasetRepo.findOne({ where: { datasetId } });
    if (!row) throw new Error(`Dataset is not registered: ${datasetId}`);
    return row;
  }

  async getVerified(datasetId: string): Promise<RecommendationDatasetRegistryV1> {
    const row = await this.get(datasetId);
    if (row.status !== 'VERIFIED') throw new Error(`Dataset is not verified: ${datasetId}`);
    assertFreshVerification(row);
    return row;
  }
}

function result(
  status: RegisterRecommendationDatasetV1Result['status'],
  row: RecommendationDatasetRegistryV1,
): RegisterRecommendationDatasetV1Result {
  return {
    status,
    datasetId: row.datasetId,
    datasetSha256: row.datasetSha256,
    manifestSha256: row.manifestSha256,
  };
}

function assertRemoteImmutableUri(value: string): void {
  if (!value) throw new Error('objectBaseUri is required');
  if (/^(s3|gs|az|https):\/\//i.test(value)) return;
  if (process.env.NODE_ENV !== 'production' && process.env.RECOMMENDATION_ALLOW_LOCAL_ARTIFACTS === 'true' && value.startsWith('file://')) return;
  throw new Error('objectBaseUri must reference an approved remote immutable artifact store');
}

function assertRegistryIdentity(row: RecommendationDatasetRegistryV1): void {
  assertRecommendationDatasetManifestV1(row.manifest);
  if (row.manifest.datasetId !== row.datasetId) {
    throw new Error('Dataset registry manifest identity is stale');
  }
  if (row.manifest.datasetSha256 !== row.datasetSha256) {
    throw new Error('Dataset registry dataset SHA is stale');
  }
  const manifestWithoutDatasetSha = { ...row.manifest } as Record<string, unknown>;
  delete manifestWithoutDatasetSha.datasetSha256;
  if (hashCanonicalJson(manifestWithoutDatasetSha) !== row.datasetSha256) {
    throw new Error('Dataset registry dataset content SHA is stale');
  }
  if (hashCanonicalJson(row.manifest) !== row.manifestSha256) {
    throw new Error('Dataset registry manifest SHA is stale');
  }
}

function assertFreshVerification(row: RecommendationDatasetRegistryV1): void {
  assertRegistryIdentity(row);
  if (!row.verification || row.verification.verifiedManifestSha256 !== row.manifestSha256) {
    throw new Error('Dataset registry verification evidence is missing or stale');
  }
  const expectedFiles = normalizeFiles(row.manifest.files);
  const verifiedFiles = normalizeFiles(row.verification.verifiedFiles);
  if (JSON.stringify(expectedFiles) !== JSON.stringify(verifiedFiles)) {
    throw new Error('Dataset registry verification files are missing or stale');
  }
  if (!row.verifiedAt || !Number.isFinite(row.verifiedAt.getTime())) {
    throw new Error('Dataset registry verification timestamp is missing or invalid');
  }
}

function normalizeFiles(
  files: readonly RecommendationDatasetArtifactFileV1[],
): Array<{ path: string; sha256: string; sizeBytes: number; rowCount: number }> {
  return files
    .map((file) => ({
      path: file.path,
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
      rowCount: file.rowCount,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function hashCanonicalJson(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}
