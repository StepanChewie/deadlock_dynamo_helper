import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  truncate,
  writeFile,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { In, Repository } from 'typeorm';
import type { CanonicalBuildStep } from './canonical-build-sequence.service';
import { MatchPlayer } from './entities/match-player.entity';
import {
  HeroBuildOfflineEvaluationDataLoaderService,
  HeroBuildOfflineLoadedHeroSample,
  chunkValues,
  isEvaluableBuildSequence,
} from './hero-build-offline-evaluation-data-loader.service';
import {
  HeroBuildEvaluationPhase,
  getHeroBuildEvaluationPhase,
} from './hero-build-offline-evaluation.service';

export const HERO_BUILD_DECISION_DATASET_V3_SCHEMA_VERSION = 1;
export const HERO_BUILD_DECISION_DATASET_V3_MAX_MATCHES = 1_000_000;
export const HERO_BUILD_DECISION_DATASET_V3_DEFAULT_BATCH_SIZE = 100;
export const HERO_BUILD_DECISION_DATASET_V3_MIN_BATCH_SIZE = 10;
export const HERO_BUILD_DECISION_DATASET_V3_MAX_BATCH_SIZE = 500;
export const HERO_BUILD_DECISION_DATASET_V3_PERSISTENCE_MODE =
  'CHECKPOINT_PER_HERO' as const;

const DEFAULT_STORAGE_DIRECTORY =
  '/app/apps/api/storage/build-decision-dataset-v3';
const STORAGE_DIRECTORY_ENV = 'DEADLOCK_BUILD_DECISION_DATASET_V3_STORAGE_DIR';
const AUTO_RESUME_ENV = 'DEADLOCK_BUILD_DECISION_DATASET_V3_AUTO_RESUME';
const NDJSON_BUFFER_LIMIT_BYTES = 1024 * 1024;

export type HeroBuildDecisionDatasetV3RunState =
  | 'IDLE'
  | 'RUNNING'
  | 'COMPLETE'
  | 'FAILED';

export type HeroBuildDecisionDatasetV3ProgressPhase =
  | 'PREPARING'
  | 'EXTRACTING'
  | 'FINALIZING'
  | 'COMPLETE';

export type HeroBuildDecisionActionType = 'BUY' | 'REBUY' | 'UPGRADE' | 'SELL';

export interface HeroBuildDecisionDatasetV3StartRequest {
  maxMatches?: number;
  batchSize?: number;
  includeSellActions?: boolean;
}

export interface HeroBuildDecisionDatasetV3Options {
  maxMatches?: number;
  batchSize: number;
  includeSellActions: boolean;
}

export interface HeroBuildDecisionDatasetV3Row {
  schemaVersion: typeof HERO_BUILD_DECISION_DATASET_V3_SCHEMA_VERSION;
  decisionId: string;
  matchId: number;
  matchStartTime: string;
  playerId: number;
  heroId: number;
  team: number;
  gameTimeS: number;
  phase: HeroBuildEvaluationPhase;
  inventoryBeforeStateKey: string;
  inventoryAfterStateKey: string;
  previousActionKeys: string[];
  buildPrefixKey: string;
  alliedHeroIds: number[];
  enemyHeroIds: number[];
  actualActionType: HeroBuildDecisionActionType;
  actualItemId: number;
  actualActionKey: string;
  outcomeLabel: {
    playerWon: boolean;
  };
}

export interface HeroBuildDecisionDatasetV3Audit {
  schemaVersion: typeof HERO_BUILD_DECISION_DATASET_V3_SCHEMA_VERSION;
  generatedAt: string;
  passed: boolean;
  source: {
    totalAvailableMatchCount: number;
    selectedMatchCount: number;
    excludedByLimitMatchCount: number;
    snapshotCrawledAt?: string;
    matchCountWithRows: number;
    playerCountWithRows: number;
    sourcePlayerCount: number;
    includedPlayerCount: number;
    excludedSequenceCount: number;
    excludedSellActionCount: number;
    sourceWindowLastRefreshedAt?: string;
  };
  decisions: {
    rowCount: number;
    duplicateDecisionCount: number;
    invalidItemIdCount: number;
    nonMonotonicGameTimeCount: number;
    emptyInventoryBeforeCount: number;
  };
  roster: {
    alliedHeroCountHistogram: Record<string, number>;
    enemyHeroCountHistogram: Record<string, number>;
    rowsWithIncompleteAlliedRoster: number;
    rowsWithIncompleteEnemyRoster: number;
  };
  byHero: Record<
    string,
    { rowCount: number; playerCount: number; excludedSequenceCount: number }
  >;
  byPhase: Record<HeroBuildEvaluationPhase, { rowCount: number }>;
  byActionType: Record<string, { rowCount: number }>;
  leakageAudit: {
    featureFields: string[];
    labelFields: string[];
    forbiddenFutureFields: string[];
    forbiddenFutureFieldsPresent: string[];
    candidateSetMaterialized: false;
    buildArchetypeMaterialized: false;
  };
  warnings: string[];
}

export interface HeroBuildDecisionDatasetV3Manifest {
  schemaVersion: typeof HERO_BUILD_DECISION_DATASET_V3_SCHEMA_VERSION;
  datasetVersion: 'CONTEXTUAL_V3_DECISION_DATASET_1';
  generatedAt: string;
  target: 'OBSERVED_NEXT_ITEM_ACTION';
  heroIdNamespace: 'VALVE_API';
  rowOrder: 'HERO_ID_MATCH_TIME_DECISION_SEQUENCE';
  options: HeroBuildDecisionDatasetV3Options;
  source: {
    totalAvailableMatchCount: number;
    selectedMatchCount: number;
    excludedByLimitMatchCount: number;
    snapshotCrawledAt?: string;
    selectedWindowStartTime: string;
    selectedWindowEndTime: string;
    sourceWindowLastRefreshedAt?: string;
    descriptorSha256: string;
  };
  artifact: {
    format: 'NDJSON';
    fileName: 'dataset.ndjson';
    byteLength: number;
    sha256: string;
    rowCount: number;
  };
  featureContract: {
    featureCutoff: 'DECISION_TIME';
    features: string[];
    outcomeLabels: string[];
    excludedFutureFields: string[];
    candidateSetMaterialized: false;
    buildArchetypeMaterialized: false;
  };
  auditPassed: boolean;
  warnings: string[];
}

export interface HeroBuildDecisionDatasetV3Status {
  state: HeroBuildDecisionDatasetV3RunState;
  phase: HeroBuildDecisionDatasetV3ProgressPhase;
  totalMatchCount: number;
  totalHeroCount: number;
  processedHeroCount: number;
  processedMatchCount: number;
  rowCount: number;
  excludedSequenceCount: number;
  excludedSellActionCount: number;
  currentHeroId?: number;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  options?: HeroBuildDecisionDatasetV3Options;
  datasetAvailable: boolean;
  manifestAvailable: boolean;
  auditAvailable: boolean;
  checkpointAvailable: boolean;
  resumedFromCheckpoint: boolean;
  persistenceMode: typeof HERO_BUILD_DECISION_DATASET_V3_PERSISTENCE_MODE;
  storageDirectory: string;
  datasetPath: string;
}

interface PersistedDescriptor {
  matchId: number;
  startTime: string;
}

interface AuditState {
  selectedMatchCount: number;
  sourcePlayerCount: number;
  includedPlayerCount: number;
  excludedSequenceCount: number;
  excludedSellActionCount: number;
  rowCount: number;
  duplicateDecisionCount: number;
  invalidItemIdCount: number;
  nonMonotonicGameTimeCount: number;
  emptyInventoryBeforeCount: number;
  rowsWithIncompleteAlliedRoster: number;
  rowsWithIncompleteEnemyRoster: number;
  matchIdsWithRows: number[];
  playerKeysWithRows: string[];
  alliedHeroCountHistogram: Record<string, number>;
  enemyHeroCountHistogram: Record<string, number>;
  byHero: Record<
    string,
    { rowCount: number; playerCount: number; excludedSequenceCount: number }
  >;
  byPhase: Record<HeroBuildEvaluationPhase, { rowCount: number }>;
  byActionType: Record<string, { rowCount: number }>;
}

interface DatasetCheckpoint {
  schemaVersion: typeof HERO_BUILD_DECISION_DATASET_V3_SCHEMA_VERSION;
  startedAt: string;
  options: HeroBuildDecisionDatasetV3Options;
  sourceWindowLastRefreshedAt?: string;
  sourceSnapshotCrawledAt?: string;
  totalAvailableMatchCount: number;
  descriptors: PersistedDescriptor[];
  heroIds: number[];
  nextHeroIndex: number;
  datasetByteLength: number;
  audit: AuditState;
}

@Injectable()
export class HeroBuildDecisionDatasetV3Service implements OnModuleInit {
  private readonly logger = new Logger(HeroBuildDecisionDatasetV3Service.name);
  private readonly storageDirectory =
    process.env[STORAGE_DIRECTORY_ENV]?.trim() || DEFAULT_STORAGE_DIRECTORY;
  private readonly autoResume = readBooleanEnvironmentValue(AUTO_RESUME_ENV, true);
  private readonly datasetPath = join(this.storageDirectory, 'dataset.ndjson');
  private readonly partialDatasetPath = join(
    this.storageDirectory,
    'dataset.ndjson.partial',
  );
  private readonly checkpointPath = join(this.storageDirectory, 'checkpoint.json');
  private readonly manifestPath = join(this.storageDirectory, 'manifest.json');
  private readonly auditPath = join(this.storageDirectory, 'audit.json');

  private status: HeroBuildDecisionDatasetV3Status = this.createIdleStatus();
  private manifest?: HeroBuildDecisionDatasetV3Manifest;
  private audit?: HeroBuildDecisionDatasetV3Audit;

  constructor(
    private readonly dataLoader: HeroBuildOfflineEvaluationDataLoaderService,
    @InjectRepository(MatchPlayer)
    private readonly matchPlayerRepository: Repository<MatchPlayer>,
  ) {}

  async onModuleInit(): Promise<void> {
    await mkdir(this.storageDirectory, { recursive: true });
    const checkpoint = await readJsonFile<DatasetCheckpoint>(this.checkpointPath);
    this.manifest = await readJsonFile<HeroBuildDecisionDatasetV3Manifest>(
      this.manifestPath,
    );
    this.audit = await readJsonFile<HeroBuildDecisionDatasetV3Audit>(
      this.auditPath,
    );
    if (this.autoResume && isCheckpoint(checkpoint)) {
      this.status = this.createRunningStatus(checkpoint, true);
      void this.run(checkpoint);
      return;
    }
    if (this.manifest && this.audit) {
      this.status = {
        ...this.createIdleStatus(),
        state: 'COMPLETE',
        phase: 'COMPLETE',
        totalMatchCount: this.manifest.source.selectedMatchCount,
        rowCount: this.manifest.artifact.rowCount,
        options: { ...this.manifest.options },
        completedAt: this.manifest.generatedAt,
        datasetAvailable: true,
        manifestAvailable: true,
        auditAvailable: true,
      };
    }
  }

  getStatus(): HeroBuildDecisionDatasetV3Status {
    return cloneJson(this.status);
  }

  getManifest(): HeroBuildDecisionDatasetV3Manifest | undefined {
    return this.manifest ? cloneJson(this.manifest) : undefined;
  }

  getAudit(): HeroBuildDecisionDatasetV3Audit | undefined {
    return this.audit ? cloneJson(this.audit) : undefined;
  }

  async start(
    request: HeroBuildDecisionDatasetV3StartRequest = {},
  ): Promise<HeroBuildDecisionDatasetV3Status> {
    if (this.status.state === 'RUNNING') {
      throw new Error('Contextual V3 decision dataset extraction is already running.');
    }
    const options = normalizeHeroBuildDecisionDatasetV3Options(request);
    const loaded = await this.dataLoader.loadMatchDescriptors(options.maxMatches);
    const descriptors = loaded.descriptors
      .map((descriptor) => ({
        matchId: descriptor.matchId,
        startTime: descriptor.startTime.toISOString(),
      }))
      .sort(compareDescriptors);
    if (descriptors.length === 0) {
      throw new Error('No valid matches are available for V3 dataset extraction.');
    }
    const heroIds = await this.dataLoader.collectHeroIds(
      loaded.descriptors,
      options.batchSize,
    );
    if (heroIds.length === 0) {
      throw new Error('No valid heroes are available for V3 dataset extraction.');
    }
    await mkdir(this.storageDirectory, { recursive: true });
    await Promise.all([
      rm(this.datasetPath, { force: true }),
      rm(this.partialDatasetPath, { force: true }),
      rm(this.checkpointPath, { force: true }),
      rm(this.manifestPath, { force: true }),
      rm(this.auditPath, { force: true }),
    ]);
    await writeFile(this.partialDatasetPath, '', 'utf8');
    const checkpoint: DatasetCheckpoint = {
      schemaVersion: HERO_BUILD_DECISION_DATASET_V3_SCHEMA_VERSION,
      startedAt: new Date().toISOString(),
      options,
      sourceWindowLastRefreshedAt:
        loaded.sourceLastRefreshedAt?.toISOString(),
      sourceSnapshotCrawledAt:
        loaded.sourceSnapshotCrawledAt?.toISOString(),
      totalAvailableMatchCount: loaded.totalAvailableMatchCount,
      descriptors,
      heroIds,
      nextHeroIndex: 0,
      datasetByteLength: 0,
      audit: createEmptyAuditState(descriptors.length),
    };
    this.manifest = undefined;
    this.audit = undefined;
    await this.persistCheckpoint(checkpoint);
    this.status = this.createRunningStatus(checkpoint, false);
    void this.run(checkpoint);
    return this.getStatus();
  }

  private async run(initialCheckpoint: DatasetCheckpoint): Promise<void> {
    let checkpoint = cloneJson(initialCheckpoint);
    try {
      await ensureFile(this.partialDatasetPath);
      await truncate(this.partialDatasetPath, checkpoint.datasetByteLength);
      const matchesWithRows = new Set(checkpoint.audit.matchIdsWithRows);
      const playersWithRows = new Set(checkpoint.audit.playerKeysWithRows);

      for (
        let heroIndex = checkpoint.nextHeroIndex;
        heroIndex < checkpoint.heroIds.length;
        heroIndex += 1
      ) {
        const heroId = checkpoint.heroIds[heroIndex];
        const heroFilePath = join(this.storageDirectory, `hero-${heroId}.ndjson.tmp`);
        await rm(heroFilePath, { force: true });
        const writer = await BufferedNdjsonWriter.create(heroFilePath);
        const heroDecisionIds = new Set<string>();
        const heroAudit = getHeroAudit(checkpoint.audit, heroId);
        this.status = {
          ...this.status,
          phase: 'EXTRACTING',
          currentHeroId: heroId,
          processedHeroCount: heroIndex,
          processedMatchCount: 0,
        };

        try {
          const descriptorBatches = chunkValues(
            checkpoint.descriptors,
            checkpoint.options.batchSize,
          );
          for (
            let batchIndex = 0;
            batchIndex < descriptorBatches.length;
            batchIndex += 1
          ) {
            const descriptors = descriptorBatches[batchIndex].map((descriptor) => ({
              matchId: descriptor.matchId,
              startTime: new Date(descriptor.startTime),
            }));
            const [loaded, roster] = await Promise.all([
              this.dataLoader.loadHeroBatch(
                heroId,
                descriptors,
                checkpoint.options.batchSize,
                `V3 dataset hero ${heroId}, batch ${batchIndex + 1}`,
              ),
              this.loadRoster(descriptors.map((descriptor) => descriptor.matchId)),
            ]);
            const rosterByMatchId = groupBy(roster, (player) => Number(player.matchId));
            checkpoint.audit.sourcePlayerCount += loaded.sourcePlayerCount;

            for (const sample of loaded.samples.sort(compareSamples)) {
              if (!isEvaluableBuildSequence(sample.sequence)) {
                checkpoint.audit.excludedSequenceCount += 1;
                heroAudit.excludedSequenceCount += 1;
                continue;
              }
              checkpoint.audit.includedPlayerCount += 1;
              heroAudit.playerCount += 1;
              const alliedHeroIds = normalizeHeroIds(
                (rosterByMatchId.get(sample.descriptor.matchId) ?? [])
                  .filter(
                    (player) =>
                      Number(player.team) === sample.player.team &&
                      Number(player.id) !== sample.player.id,
                  )
                  .map((player) => Number(player.heroId)),
              );
              const extracted = createHeroBuildDecisionRows(
                sample,
                alliedHeroIds,
                checkpoint.options.includeSellActions,
              );
              checkpoint.audit.excludedSellActionCount +=
                extracted.excludedSellActionCount;
              checkpoint.audit.nonMonotonicGameTimeCount +=
                extracted.nonMonotonicGameTimeCount;
              if (extracted.rows.length > 0) {
                matchesWithRows.add(sample.descriptor.matchId);
                playersWithRows.add(
                  `${sample.descriptor.matchId}:${sample.player.id}`,
                );
              }
              for (const row of extracted.rows) {
                if (heroDecisionIds.has(row.decisionId)) {
                  checkpoint.audit.duplicateDecisionCount += 1;
                } else {
                  heroDecisionIds.add(row.decisionId);
                }
                applyRowAudit(checkpoint.audit, row);
                await writer.write(row);
              }
            }

            this.status = {
              ...this.status,
              processedMatchCount: Math.min(
                checkpoint.descriptors.length,
                (batchIndex + 1) * checkpoint.options.batchSize,
              ),
              rowCount: checkpoint.audit.rowCount,
              excludedSequenceCount: checkpoint.audit.excludedSequenceCount,
              excludedSellActionCount: checkpoint.audit.excludedSellActionCount,
            };
            await yieldToEventLoop();
          }
        } finally {
          await writer.close();
        }

        await pipeline(
          createReadStream(heroFilePath),
          createWriteStream(this.partialDatasetPath, { flags: 'a' }),
        );
        await rm(heroFilePath, { force: true });
        const partialStat = await stat(this.partialDatasetPath);
        checkpoint.nextHeroIndex = heroIndex + 1;
        checkpoint.datasetByteLength = partialStat.size;
        checkpoint.audit.matchIdsWithRows = [...matchesWithRows].sort((a, b) => a - b);
        checkpoint.audit.playerKeysWithRows = [...playersWithRows].sort();
        await this.persistCheckpoint(checkpoint);
        this.status = {
          ...this.status,
          processedHeroCount: heroIndex + 1,
          currentHeroId: undefined,
          checkpointAvailable: true,
        };
      }

      this.status = { ...this.status, phase: 'FINALIZING' };
      await rm(this.datasetPath, { force: true });
      await rename(this.partialDatasetPath, this.datasetPath);
      const artifactStat = await stat(this.datasetPath);
      const generatedAt = new Date().toISOString();
      const audit = buildAudit(checkpoint, generatedAt);
      const manifest = await buildManifest(
        checkpoint,
        generatedAt,
        this.datasetPath,
        artifactStat.size,
        audit,
      );
      await Promise.all([
        writeJsonAtomically(this.auditPath, audit),
        writeJsonAtomically(this.manifestPath, manifest),
      ]);
      await rm(this.checkpointPath, { force: true });
      this.audit = audit;
      this.manifest = manifest;
      this.status = {
        ...this.status,
        state: 'COMPLETE',
        phase: 'COMPLETE',
        processedHeroCount: checkpoint.heroIds.length,
        processedMatchCount: checkpoint.descriptors.length,
        currentHeroId: undefined,
        completedAt: generatedAt,
        datasetAvailable: true,
        manifestAvailable: true,
        auditAvailable: true,
        checkpointAvailable: false,
        error: undefined,
      };
      this.logger.log(
        `Contextual V3 decision dataset completed with ${audit.decisions.rowCount} rows. ` +
          `Audit decision: ${audit.passed ? 'PASS' : 'FAIL'}.`,
      );
    } catch (error) {
      const message = getErrorMessage(error);
      this.status = {
        ...this.status,
        state: 'FAILED',
        error: message,
        completedAt: new Date().toISOString(),
        checkpointAvailable: true,
      };
      this.logger.error(`Contextual V3 decision dataset failed: ${message}`);
    }
  }

  private async loadRoster(matchIds: number[]): Promise<MatchPlayer[]> {
    if (matchIds.length === 0) {
      return [];
    }
    return this.dataLoader.withDatabaseRetry('loading V3 dataset rosters', () =>
      this.matchPlayerRepository.find({ where: { matchId: In(matchIds) } }),
    );
  }

  private async persistCheckpoint(checkpoint: DatasetCheckpoint): Promise<void> {
    await writeJsonAtomically(this.checkpointPath, checkpoint);
  }

  private createIdleStatus(): HeroBuildDecisionDatasetV3Status {
    return {
      state: 'IDLE',
      phase: 'PREPARING',
      totalMatchCount: 0,
      totalHeroCount: 0,
      processedHeroCount: 0,
      processedMatchCount: 0,
      rowCount: 0,
      excludedSequenceCount: 0,
      excludedSellActionCount: 0,
      datasetAvailable: false,
      manifestAvailable: false,
      auditAvailable: false,
      checkpointAvailable: false,
      resumedFromCheckpoint: false,
      persistenceMode: HERO_BUILD_DECISION_DATASET_V3_PERSISTENCE_MODE,
      storageDirectory: this.storageDirectory,
      datasetPath: this.datasetPath,
    };
  }

  private createRunningStatus(
    checkpoint: DatasetCheckpoint,
    resumedFromCheckpoint: boolean,
  ): HeroBuildDecisionDatasetV3Status {
    return {
      ...this.createIdleStatus(),
      state: 'RUNNING',
      phase: checkpoint.nextHeroIndex > 0 ? 'EXTRACTING' : 'PREPARING',
      totalMatchCount: checkpoint.descriptors.length,
      totalHeroCount: checkpoint.heroIds.length,
      processedHeroCount: checkpoint.nextHeroIndex,
      rowCount: checkpoint.audit.rowCount,
      excludedSequenceCount: checkpoint.audit.excludedSequenceCount,
      excludedSellActionCount: checkpoint.audit.excludedSellActionCount,
      startedAt: checkpoint.startedAt,
      options: { ...checkpoint.options },
      checkpointAvailable: true,
      resumedFromCheckpoint,
    };
  }
}

export function createHeroBuildDecisionRows(
  sample: HeroBuildOfflineLoadedHeroSample,
  alliedHeroIds: readonly number[],
  includeSellActions: boolean,
): {
  rows: HeroBuildDecisionDatasetV3Row[];
  excludedSellActionCount: number;
  nonMonotonicGameTimeCount: number;
} {
  const rows: HeroBuildDecisionDatasetV3Row[] = [];
  const previousActionKeys: string[] = [];
  let excludedSellActionCount = 0;
  let nonMonotonicGameTimeCount = 0;
  let previousGameTimeS = Number.NEGATIVE_INFINITY;
  for (const step of sample.sequence.steps) {
    if (step.gameTimeS < previousGameTimeS) {
      nonMonotonicGameTimeCount += 1;
    }
    previousGameTimeS = Math.max(previousGameTimeS, step.gameTimeS);
    if (step.actionType === 'SELL' && !includeSellActions) {
      excludedSellActionCount += 1;
      previousActionKeys.push(step.actionKey);
      continue;
    }
    rows.push(createDecisionRow(sample, alliedHeroIds, step, previousActionKeys));
    previousActionKeys.push(step.actionKey);
  }
  return { rows, excludedSellActionCount, nonMonotonicGameTimeCount };
}

function createDecisionRow(
  sample: HeroBuildOfflineLoadedHeroSample,
  alliedHeroIds: readonly number[],
  step: CanonicalBuildStep,
  previousActionKeys: readonly string[],
): HeroBuildDecisionDatasetV3Row {
  return {
    schemaVersion: HERO_BUILD_DECISION_DATASET_V3_SCHEMA_VERSION,
    decisionId: `${sample.descriptor.matchId}:${sample.player.id}:${step.sequence}`,
    matchId: sample.descriptor.matchId,
    matchStartTime: sample.descriptor.startTime.toISOString(),
    playerId: sample.player.id,
    heroId: sample.sequence.heroId,
    team: sample.player.team,
    gameTimeS: step.gameTimeS,
    phase: getHeroBuildEvaluationPhase(step.gameTimeS),
    inventoryBeforeStateKey: step.beforeStateKey,
    inventoryAfterStateKey: step.afterStateKey,
    previousActionKeys: [...previousActionKeys],
    buildPrefixKey:
      previousActionKeys.length > 0 ? previousActionKeys.join('>') : 'EMPTY',
    alliedHeroIds: [...alliedHeroIds],
    enemyHeroIds: [...sample.enemyHeroIds],
    actualActionType: step.actionType,
    actualItemId: step.itemId,
    actualActionKey: step.actionKey,
    outcomeLabel: { playerWon: sample.player.won },
  };
}

function applyRowAudit(audit: AuditState, row: HeroBuildDecisionDatasetV3Row): void {
  audit.rowCount += 1;
  getHeroAudit(audit, row.heroId).rowCount += 1;
  audit.byPhase[row.phase].rowCount += 1;
  const actionBucket = audit.byActionType[row.actualActionType] ?? { rowCount: 0 };
  actionBucket.rowCount += 1;
  audit.byActionType[row.actualActionType] = actionBucket;
  increment(audit.alliedHeroCountHistogram, String(row.alliedHeroIds.length));
  increment(audit.enemyHeroCountHistogram, String(row.enemyHeroIds.length));
  if (!Number.isSafeInteger(row.actualItemId) || row.actualItemId <= 0) {
    audit.invalidItemIdCount += 1;
  }
  if (row.inventoryBeforeStateKey === 'EMPTY') {
    audit.emptyInventoryBeforeCount += 1;
  }
  if (row.alliedHeroIds.length < 5) {
    audit.rowsWithIncompleteAlliedRoster += 1;
  }
  if (row.enemyHeroIds.length < 6) {
    audit.rowsWithIncompleteEnemyRoster += 1;
  }
}

function buildAudit(
  checkpoint: DatasetCheckpoint,
  generatedAt: string,
): HeroBuildDecisionDatasetV3Audit {
  const state = checkpoint.audit;
  const featureFields = [
    'heroId',
    'team',
    'gameTimeS',
    'phase',
    'inventoryBeforeStateKey',
    'previousActionKeys',
    'buildPrefixKey',
    'alliedHeroIds',
    'enemyHeroIds',
  ];
  const forbiddenFutureFields = [
    'kills',
    'deaths',
    'assists',
    'netWorth',
    'finalKills',
    'finalDeaths',
    'finalAssists',
    'finalNetWorth',
  ];
  const warnings = [
    'Candidate sets are intentionally not materialized in this extraction stage.',
    'Build archetypes are intentionally not assigned; buildPrefixKey is observed history, not an archetype label.',
  ];
  if (checkpoint.descriptors.length < checkpoint.totalAvailableMatchCount) {
    warnings.push(
      `${checkpoint.totalAvailableMatchCount - checkpoint.descriptors.length} matches were excluded by the explicit maxMatches request.`,
    );
  }
  if (state.excludedSequenceCount > 0) {
    warnings.push(
      `${state.excludedSequenceCount} player sequences were excluded because they were not safe to evaluate.`,
    );
  }
  if (state.rowsWithIncompleteAlliedRoster > 0) {
    warnings.push(
      `${state.rowsWithIncompleteAlliedRoster} rows have fewer than five stored allied heroes.`,
    );
  }
  if (state.rowsWithIncompleteEnemyRoster > 0) {
    warnings.push(
      `${state.rowsWithIncompleteEnemyRoster} rows have fewer than six stored enemy heroes.`,
    );
  }
  return {
    schemaVersion: HERO_BUILD_DECISION_DATASET_V3_SCHEMA_VERSION,
    generatedAt,
    passed:
      state.rowCount > 0 &&
      state.duplicateDecisionCount === 0 &&
      state.invalidItemIdCount === 0 &&
      state.nonMonotonicGameTimeCount === 0,
    source: {
      totalAvailableMatchCount: checkpoint.totalAvailableMatchCount,
      selectedMatchCount: state.selectedMatchCount,
      excludedByLimitMatchCount: Math.max(
        0,
        checkpoint.totalAvailableMatchCount - checkpoint.descriptors.length,
      ),
      snapshotCrawledAt: checkpoint.sourceSnapshotCrawledAt,
      matchCountWithRows: state.matchIdsWithRows.length,
      playerCountWithRows: state.playerKeysWithRows.length,
      sourcePlayerCount: state.sourcePlayerCount,
      includedPlayerCount: state.includedPlayerCount,
      excludedSequenceCount: state.excludedSequenceCount,
      excludedSellActionCount: state.excludedSellActionCount,
      sourceWindowLastRefreshedAt: checkpoint.sourceWindowLastRefreshedAt,
    },
    decisions: {
      rowCount: state.rowCount,
      duplicateDecisionCount: state.duplicateDecisionCount,
      invalidItemIdCount: state.invalidItemIdCount,
      nonMonotonicGameTimeCount: state.nonMonotonicGameTimeCount,
      emptyInventoryBeforeCount: state.emptyInventoryBeforeCount,
    },
    roster: {
      alliedHeroCountHistogram: { ...state.alliedHeroCountHistogram },
      enemyHeroCountHistogram: { ...state.enemyHeroCountHistogram },
      rowsWithIncompleteAlliedRoster: state.rowsWithIncompleteAlliedRoster,
      rowsWithIncompleteEnemyRoster: state.rowsWithIncompleteEnemyRoster,
    },
    byHero: cloneJson(state.byHero),
    byPhase: cloneJson(state.byPhase),
    byActionType: cloneJson(state.byActionType),
    leakageAudit: {
      featureFields,
      labelFields: ['outcomeLabel.playerWon'],
      forbiddenFutureFields,
      forbiddenFutureFieldsPresent: featureFields.filter((field) =>
        forbiddenFutureFields.includes(field),
      ),
      candidateSetMaterialized: false,
      buildArchetypeMaterialized: false,
    },
    warnings,
  };
}

async function buildManifest(
  checkpoint: DatasetCheckpoint,
  generatedAt: string,
  datasetPath: string,
  byteLength: number,
  audit: HeroBuildDecisionDatasetV3Audit,
): Promise<HeroBuildDecisionDatasetV3Manifest> {
  return {
    schemaVersion: HERO_BUILD_DECISION_DATASET_V3_SCHEMA_VERSION,
    datasetVersion: 'CONTEXTUAL_V3_DECISION_DATASET_1',
    generatedAt,
    target: 'OBSERVED_NEXT_ITEM_ACTION',
    heroIdNamespace: 'VALVE_API',
    rowOrder: 'HERO_ID_MATCH_TIME_DECISION_SEQUENCE',
    options: { ...checkpoint.options },
    source: {
      totalAvailableMatchCount: checkpoint.totalAvailableMatchCount,
      selectedMatchCount: checkpoint.descriptors.length,
      excludedByLimitMatchCount: Math.max(
        0,
        checkpoint.totalAvailableMatchCount - checkpoint.descriptors.length,
      ),
      snapshotCrawledAt: checkpoint.sourceSnapshotCrawledAt,
      selectedWindowStartTime: checkpoint.descriptors[0].startTime,
      selectedWindowEndTime:
        checkpoint.descriptors[checkpoint.descriptors.length - 1].startTime,
      sourceWindowLastRefreshedAt: checkpoint.sourceWindowLastRefreshedAt,
      descriptorSha256: hashText(
        checkpoint.descriptors
          .map((descriptor) => `${descriptor.matchId}:${descriptor.startTime}`)
          .join('\n'),
      ),
    },
    artifact: {
      format: 'NDJSON',
      fileName: 'dataset.ndjson',
      byteLength,
      sha256: await hashFile(datasetPath),
      rowCount: audit.decisions.rowCount,
    },
    featureContract: {
      featureCutoff: 'DECISION_TIME',
      features: [...audit.leakageAudit.featureFields],
      outcomeLabels: [...audit.leakageAudit.labelFields],
      excludedFutureFields: [...audit.leakageAudit.forbiddenFutureFields],
      candidateSetMaterialized: false,
      buildArchetypeMaterialized: false,
    },
    auditPassed: audit.passed,
    warnings: [...audit.warnings],
  };
}

function createEmptyAuditState(selectedMatchCount: number): AuditState {
  return {
    selectedMatchCount,
    sourcePlayerCount: 0,
    includedPlayerCount: 0,
    excludedSequenceCount: 0,
    excludedSellActionCount: 0,
    rowCount: 0,
    duplicateDecisionCount: 0,
    invalidItemIdCount: 0,
    nonMonotonicGameTimeCount: 0,
    emptyInventoryBeforeCount: 0,
    rowsWithIncompleteAlliedRoster: 0,
    rowsWithIncompleteEnemyRoster: 0,
    matchIdsWithRows: [],
    playerKeysWithRows: [],
    alliedHeroCountHistogram: {},
    enemyHeroCountHistogram: {},
    byHero: {},
    byPhase: {
      EARLY: { rowCount: 0 },
      MID: { rowCount: 0 },
      LATE: { rowCount: 0 },
    },
    byActionType: {},
  };
}

function getHeroAudit(
  audit: AuditState,
  heroId: number,
): { rowCount: number; playerCount: number; excludedSequenceCount: number } {
  const key = String(heroId);
  const existing = audit.byHero[key];
  if (existing) {
    return existing;
  }
  const created = { rowCount: 0, playerCount: 0, excludedSequenceCount: 0 };
  audit.byHero[key] = created;
  return created;
}

export function normalizeHeroBuildDecisionDatasetV3Options(
  request: HeroBuildDecisionDatasetV3StartRequest,
): HeroBuildDecisionDatasetV3Options {
  return {
    maxMatches: optionalBoundedInteger(
      request.maxMatches,
      1,
      HERO_BUILD_DECISION_DATASET_V3_MAX_MATCHES,
      'maxMatches',
    ),
    batchSize: boundedInteger(
      request.batchSize,
      HERO_BUILD_DECISION_DATASET_V3_DEFAULT_BATCH_SIZE,
      HERO_BUILD_DECISION_DATASET_V3_MIN_BATCH_SIZE,
      HERO_BUILD_DECISION_DATASET_V3_MAX_BATCH_SIZE,
      'batchSize',
    ),
    includeSellActions: request.includeSellActions ?? false,
  };
}

function optionalBoundedInteger(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fieldName: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${fieldName} must be a safe integer from ${minimum} to ${maximum}.`,
    );
  }
  return value;
}

function boundedInteger(
  value: number | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
  fieldName: string,
): number {
  const resolved = value ?? defaultValue;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(
      `${fieldName} must be a safe integer from ${minimum} to ${maximum}.`,
    );
  }
  return resolved;
}

class BufferedNdjsonWriter {
  private buffer = '';

  private constructor(private readonly handle: FileHandle) {}

  static async create(path: string): Promise<BufferedNdjsonWriter> {
    return new BufferedNdjsonWriter(await open(path, 'w'));
  }

  async write(row: HeroBuildDecisionDatasetV3Row): Promise<void> {
    this.buffer += `${JSON.stringify(row)}\n`;
    if (Buffer.byteLength(this.buffer) >= NDJSON_BUFFER_LIMIT_BYTES) {
      await this.flush();
    }
  }

  async close(): Promise<void> {
    await this.flush();
    await this.handle.close();
  }

  private async flush(): Promise<void> {
    if (!this.buffer) {
      return;
    }
    const value = this.buffer;
    this.buffer = '';
    await this.handle.write(value);
  }
}

function compareDescriptors(left: PersistedDescriptor, right: PersistedDescriptor): number {
  return (
    new Date(left.startTime).getTime() - new Date(right.startTime).getTime() ||
    left.matchId - right.matchId
  );
}

function compareSamples(
  left: HeroBuildOfflineLoadedHeroSample,
  right: HeroBuildOfflineLoadedHeroSample,
): number {
  return (
    left.descriptor.startTime.getTime() - right.descriptor.startTime.getTime() ||
    left.descriptor.matchId - right.descriptor.matchId ||
    left.player.id - right.player.id
  );
}

function normalizeHeroIds(heroIds: readonly number[]): number[] {
  return [
    ...new Set(
      heroIds.filter((heroId) => Number.isSafeInteger(heroId) && heroId > 0),
    ),
  ].sort((left, right) => left - right);
}

function groupBy<T, K>(values: readonly T[], keyOf: (value: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }
  return groups;
}

function increment(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

function isCheckpoint(value: DatasetCheckpoint | undefined): value is DatasetCheckpoint {
  return (
    value?.schemaVersion === HERO_BUILD_DECISION_DATASET_V3_SCHEMA_VERSION &&
    Array.isArray(value.descriptors) &&
    Array.isArray(value.heroIds) &&
    Number.isSafeInteger(value.nextHeroIndex) &&
    Number.isSafeInteger(value.datasetByteLength)
  );
}

async function ensureFile(path: string): Promise<void> {
  const handle = await open(path, 'a');
  await handle.close();
}

async function readJsonFile<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return undefined;
    }
    throw error;
  }
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(value, undefined, 2), 'utf8');
  await rename(temporaryPath, path);
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function readBooleanEnvironmentValue(name: string, defaultValue: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) {
    return defaultValue;
  }
  return value !== 'false' && value !== '0' && value !== 'no';
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
