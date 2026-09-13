import { Injectable } from '@nestjs/common';
import {
  existsSync,
  readFileSync,
  renameSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  HeroBuildDecisionDatasetV3Audit,
  HeroBuildDecisionDatasetV3Manifest,
  HeroBuildDecisionDatasetV3Service,
  HeroBuildDecisionDatasetV3StartRequest,
  HeroBuildDecisionDatasetV3Status,
} from './hero-build-decision-dataset-v3.service';

const DEFAULT_STORAGE_DIRECTORY =
  '/app/apps/api/storage/build-decision-dataset-v3';
const STORAGE_DIRECTORY_ENV =
  'DEADLOCK_BUILD_DECISION_DATASET_V3_STORAGE_DIR';

interface FinalizationCheckpointShape {
  nextHeroIndex?: unknown;
  heroIds?: unknown;
  datasetByteLength?: unknown;
}

@Injectable()
export class HeroBuildDecisionDatasetV3CoordinatorService {
  private starting = false;

  constructor(
    private readonly datasetService: HeroBuildDecisionDatasetV3Service,
  ) {
    recoverInterruptedFinalization();
  }

  getStatus(): HeroBuildDecisionDatasetV3Status {
    return this.datasetService.getStatus();
  }

  getManifest(): HeroBuildDecisionDatasetV3Manifest | undefined {
    return this.datasetService.getManifest();
  }

  getAudit(): HeroBuildDecisionDatasetV3Audit | undefined {
    return this.datasetService.getAudit();
  }

  async start(
    request: HeroBuildDecisionDatasetV3StartRequest = {},
  ): Promise<HeroBuildDecisionDatasetV3Status> {
    if (
      this.starting ||
      this.datasetService.getStatus().state === 'RUNNING'
    ) {
      throw new Error(
        'Contextual V3 decision dataset extraction is already running.',
      );
    }

    this.starting = true;
    try {
      return await this.datasetService.start(request);
    } finally {
      this.starting = false;
    }
  }
}

export function recoverInterruptedFinalization(
  storageDirectory = resolveStorageDirectory(),
): boolean {
  const checkpointPath = join(storageDirectory, 'checkpoint.json');
  const datasetPath = join(storageDirectory, 'dataset.ndjson');
  const partialDatasetPath = join(
    storageDirectory,
    'dataset.ndjson.partial',
  );

  if (
    !existsSync(checkpointPath) ||
    !existsSync(datasetPath) ||
    existsSync(partialDatasetPath)
  ) {
    return false;
  }

  let checkpoint: FinalizationCheckpointShape;
  try {
    checkpoint = JSON.parse(
      readFileSync(checkpointPath, 'utf8'),
    ) as FinalizationCheckpointShape;
  } catch {
    return false;
  }

  const heroIds = Array.isArray(checkpoint.heroIds)
    ? checkpoint.heroIds
    : [];
  const nextHeroIndex = Number(checkpoint.nextHeroIndex);
  const datasetByteLength = Number(checkpoint.datasetByteLength);
  if (
    heroIds.length === 0 ||
    !Number.isSafeInteger(nextHeroIndex) ||
    nextHeroIndex < heroIds.length ||
    !Number.isSafeInteger(datasetByteLength) ||
    datasetByteLength < 0
  ) {
    return false;
  }

  try {
    if (statSync(datasetPath).size !== datasetByteLength) {
      return false;
    }
    renameSync(datasetPath, partialDatasetPath);
    return true;
  } catch {
    return false;
  }
}

function resolveStorageDirectory(): string {
  return (
    process.env[STORAGE_DIRECTORY_ENV]?.trim() ||
    DEFAULT_STORAGE_DIRECTORY
  );
}
