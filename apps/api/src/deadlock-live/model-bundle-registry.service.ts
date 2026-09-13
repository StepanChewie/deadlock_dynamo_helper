import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import {
  ModelBundleManifestV1,
  ModelBundleRuntimeCompatibilityV1,
  validateModelBundleManifestV1,
  validateModelBundleRuntimeCompatibilityV1,
} from '@deadlock-live-probe/shared';
import {
  ModelBundleArtifactVerificationV1,
  ModelBundleRegistryV1,
} from './entities/model-bundle-registry.entity';

export interface RegisterModelBundleV1Input {
  manifest: ModelBundleManifestV1;
  artifactBaseUri: string;
}

export interface RegisterModelBundleV1Result {
  created: boolean;
  id: string;
  modelId: string;
  modelVersion: string;
  manifestSha256: string;
  status: string;
}

export interface VerifyModelBundleV1Input {
  modelId: string;
  modelVersion: string;
  verifier: string;
  manifestSha256: string;
  files: readonly { path: string; sha256: string; sizeBytes: number }[];
  attestationRef?: string;
}

export interface ActivateModelBundleV1Input {
  modelId: string;
  modelVersion: string;
  runtime: ModelBundleRuntimeCompatibilityV1;
}

@Injectable()
export class ModelBundleRegistryService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(ModelBundleRegistryV1)
    private readonly registryRepo: Repository<ModelBundleRegistryV1>,
  ) {}

  async register(input: RegisterModelBundleV1Input): Promise<RegisterModelBundleV1Result> {
    const validation = validateModelBundleManifestV1(input.manifest);
    if (!validation.valid) {
      throw new Error(`Invalid model bundle manifest: ${validation.errors.join(',')}`);
    }
    const artifactBaseUri = validateArtifactBaseUri(input.artifactBaseUri);
    const manifestSha256 = modelManifestSha256V1(input.manifest);
    const existing = await this.registryRepo.findOne({
      where: { modelId: input.manifest.modelId, modelVersion: input.manifest.modelVersion },
    });
    if (existing) {
      if (existing.manifestSha256 !== manifestSha256 || existing.artifactBaseUri !== artifactBaseUri) {
        throw new Error(
          `Immutable model identity conflict for ${input.manifest.modelId}@${input.manifest.modelVersion}`,
        );
      }
      return toRegisterResult(existing, false);
    }

    try {
      const created = await this.registryRepo.save(this.registryRepo.create({
        modelId: input.manifest.modelId,
        modelVersion: input.manifest.modelVersion,
        manifestSha256,
        manifest: canonicalizeManifest(input.manifest),
        artifactBaseUri,
        status: 'REGISTERED',
      }));
      return toRegisterResult(created, true);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.registryRepo.findOne({
        where: { modelId: input.manifest.modelId, modelVersion: input.manifest.modelVersion },
      });
      if (!raced || raced.manifestSha256 !== manifestSha256 || raced.artifactBaseUri !== artifactBaseUri) {
        throw new Error(
          `Immutable model identity conflict for ${input.manifest.modelId}@${input.manifest.modelVersion}`,
        );
      }
      return toRegisterResult(raced, false);
    }
  }

  async verify(input: VerifyModelBundleV1Input): Promise<ModelBundleRegistryV1> {
    if (!input.verifier) throw new Error('verifier is required');
    const target = await this.registryRepo.findOne({
      where: { modelId: input.modelId, modelVersion: input.modelVersion },
    });
    if (!target) throw new Error(`Model bundle not found: ${input.modelId}@${input.modelVersion}`);
    if (target.status === 'ACTIVE' || target.status === 'RETIRED') {
      throw new Error(`Model bundle verification cannot mutate ${target.status} artifact`);
    }
    if (target.manifestSha256 !== input.manifestSha256) {
      throw new Error('Verified manifest SHA does not match registered manifest');
    }
    const expectedFiles = normalizedFiles(target.manifest.files);
    const verifiedFiles = normalizedFiles(input.files);
    if (JSON.stringify(expectedFiles) !== JSON.stringify(verifiedFiles)) {
      throw new Error('Verified artifact files do not exactly match model manifest');
    }
    const verification: ModelBundleArtifactVerificationV1 = {
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

  async activate(input: ActivateModelBundleV1Input): Promise<ModelBundleRegistryV1> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(ModelBundleRegistryV1);
      const target = await repo.findOne({
        where: { modelId: input.modelId, modelVersion: input.modelVersion },
      });
      if (!target) throw new Error(`Model bundle not found: ${input.modelId}@${input.modelVersion}`);
      if (target.status !== 'VERIFIED' && target.status !== 'ACTIVE') {
        throw new Error(`Model bundle is not verified: ${target.status}`);
      }
      assertFreshVerification(target);
      const compatibility = validateModelBundleRuntimeCompatibilityV1(target.manifest, input.runtime);
      if (!compatibility.valid) {
        throw new Error(`Model bundle is not runtime-compatible: ${compatibility.errors.join(',')}`);
      }

      const active = await repo.find({ where: { modelId: input.modelId, status: 'ACTIVE' } });
      const now = new Date();
      for (const previous of active) {
        if (previous.id === target.id) continue;
        previous.status = 'RETIRED';
        previous.retiredAt = now;
        await repo.save(previous);
      }
      target.status = 'ACTIVE';
      target.activatedAt = target.activatedAt ?? now;
      target.retiredAt = undefined;
      return repo.save(target);
    });
  }

  async getVerified(modelId: string, modelVersion: string): Promise<ModelBundleRegistryV1> {
    if (!modelId) throw new Error('modelId is required');
    if (!modelVersion) throw new Error('modelVersion is required');
    const target = await this.registryRepo.findOne({ where: { modelId, modelVersion } });
    if (!target) throw new Error(`Model bundle not found: ${modelId}@${modelVersion}`);
    if (target.status !== 'VERIFIED' && target.status !== 'ACTIVE') {
      throw new Error(`Model bundle is not verified: ${target.status}`);
    }
    assertFreshVerification(target);
    return target;
  }

  async getActive(
    modelId: string,
    runtime: ModelBundleRuntimeCompatibilityV1,
  ): Promise<ModelBundleRegistryV1 | undefined> {
    const active = await this.registryRepo.findOne({ where: { modelId, status: 'ACTIVE' } });
    if (!active) return undefined;
    try {
      assertFreshVerification(active);
    } catch {
      return undefined;
    }
    const compatibility = validateModelBundleRuntimeCompatibilityV1(active.manifest, runtime);
    return compatibility.valid ? active : undefined;
  }
}

export function modelManifestSha256V1(manifest: ModelBundleManifestV1): string {
  return createHash('sha256').update(JSON.stringify(canonicalizeManifest(manifest))).digest('hex');
}

function assertFreshVerification(entity: ModelBundleRegistryV1): void {
  if (!entity.verification || entity.verification.verifiedManifestSha256 !== entity.manifestSha256) {
    throw new Error('Model bundle verification evidence is missing or stale');
  }
  const expectedFiles = normalizedFiles(entity.manifest.files);
  const verifiedFiles = normalizedFiles(entity.verification.verifiedFiles);
  if (JSON.stringify(expectedFiles) !== JSON.stringify(verifiedFiles)) {
    throw new Error('Model bundle verification evidence files are missing or stale');
  }
  if (!entity.verifiedAt || !Number.isFinite(entity.verifiedAt.getTime())) {
    throw new Error('Model bundle verification timestamp is missing or invalid');
  }
}

function canonicalizeManifest(manifest: ModelBundleManifestV1): ModelBundleManifestV1 {
  return {
    ...manifest,
    supportedRulesetVersions: [...manifest.supportedRulesetVersions].sort(),
    supportedCatalogSha256: [...manifest.supportedCatalogSha256].sort(),
    files: [...manifest.files].map((file) => ({ ...file })).sort((a, b) => a.path.localeCompare(b.path)),
    gates: [...manifest.gates].map((gate) => ({ ...gate })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function validateArtifactBaseUri(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('artifactBaseUri is required');
  if (trimmed.includes('..')) throw new Error('artifactBaseUri must not contain parent traversal');
  if (/^(s3|gs|https):\/\//.test(trimmed)) return trimmed.replace(/\/+$/, '');
  if (process.env.NODE_ENV !== 'production' && process.env.RECOMMENDATION_ALLOW_LOCAL_ARTIFACTS === 'true' && trimmed.startsWith('file://')) {
    return trimmed.replace(/\/+$/, '');
  }
  throw new Error('artifactBaseUri must use an approved immutable remote store');
}

function normalizedFiles(
  files: readonly { path: string; sha256: string; sizeBytes: number }[],
): Array<{ path: string; sha256: string; sizeBytes: number }> {
  return files
    .map((file) => ({ path: file.path, sha256: file.sha256, sizeBytes: file.sizeBytes }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function toRegisterResult(entity: ModelBundleRegistryV1, created: boolean): RegisterModelBundleV1Result {
  return {
    created,
    id: entity.id,
    modelId: entity.modelId,
    modelVersion: entity.modelVersion,
    manifestSha256: entity.manifestSha256,
    status: entity.status,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}
