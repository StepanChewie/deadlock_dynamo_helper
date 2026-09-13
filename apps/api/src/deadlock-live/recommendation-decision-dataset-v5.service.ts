import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  appendFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  RECOMMENDATION_DECISION_DATASET_V4_VERSION,
  type RecommendationDecisionDatasetV4Row,
} from './recommendation-decision-dataset-v4.service';
import {
  MATCH_TIMELINE_VERSION,
  type MatchTimelineObjectiveEvent,
  type MatchTimelinePlayerSnapshot,
} from './match-timeline-collector.service';
import { parseInventoryStateKey } from './inventory-multiset-action-engine';
import { sha256StableJson } from './stable-json';

export const RECOMMENDATION_DECISION_DATASET_V5_SCHEMA_VERSION = 3;
export const RECOMMENDATION_DECISION_DATASET_V5_VERSION =
  'RECOMMENDATION_DECISION_DATASET_V5_3' as const;

const DEFAULT_SOURCE_DIR =
  '/app/apps/api/storage/recommendation-decision-dataset-v4';
const DEFAULT_TIMELINE_DIR =
  '/app/apps/api/storage/match-timeline-events-v1';
const DEFAULT_OUTPUT_DIR =
  '/app/apps/api/storage/recommendation-decision-dataset-v5';
const DATASET_FILE = 'dataset.ndjson';
const HORIZONS = [
  { key: '3m', seconds: 180 },
  { key: '5m', seconds: 300 },
  { key: '10m', seconds: 600 },
] as const;

export interface RecommendationDecisionDatasetV5StartRequest {
  expectedSourceSha256?: string;
  partitionCount?: number;
  snapshotStalenessS?: number;
  catalogSnapshotPath?: string;
  expectedCatalogSha256?: string;
  resume?: boolean;
}

export interface RecommendationDecisionDatasetV5Status {
  state: 'IDLE' | 'RUNNING' | 'COMPLETE' | 'FAILED';
  phase: 'PREPARING' | 'PARTITIONING' | 'ENRICHING' | 'FINALIZING' | 'COMPLETE';
  sourceRowCount: number;
  processedPartitionCount: number;
  partitionCount: number;
  outputRowCount: number;
  rowsWithTimelineCount: number;
  rowsWithComplete3mOutcomeCount: number;
  duplicateDecisionIdCount: number;
  outputDirectory: string;
  datasetPath: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  datasetAvailable: boolean;
  manifestAvailable: boolean;
  auditAvailable: boolean;
  sourceAvailabilityAvailable: boolean;
}

interface Options {
  expectedSourceSha256?: string;
  partitionCount: number;
  snapshotStalenessS: number;
  catalogSnapshotPath?: string;
  expectedCatalogSha256?: string;
  resume: boolean;
}

interface Checkpoint {
  datasetVersion: typeof RECOMMENDATION_DECISION_DATASET_V5_VERSION;
  sourceSha256: string;
  optionsHash: string;
  partitioningComplete: boolean;
  sourceRowCount: number;
  completedPartitions: number[];
  updatedAt: string;
}

interface PartStats {
  partitionIndex: number;
  sourceRowCount: number;
  outputRowCount: number;
  rowsWithTimelineCount: number;
  complete3m: number;
  complete5m: number;
  complete10m: number;
  rowsWithCatalogCount: number;
  duplicateDecisionIdCount: number;
  invalidRowCount: number;
}

interface TimelineData {
  available: boolean;
  snapshots: MatchTimelinePlayerSnapshot[];
  objectives: MatchTimelineObjectiveEvent[];
}

interface CatalogItem {
  itemId: number;
  name?: string;
  cost: number;
  tier: number;
  slotType: string;
  itemType?: string;
  isActiveItem?: boolean;
  activationType?: string;
  tags?: string[];
}

interface CatalogData {
  available: boolean;
  path?: string;
  sha256?: string;
  catalogVersionId?: number;
  items: Map<number, CatalogItem>;
  recipes: Map<number, number[]>;
}

interface Paths {
  dataset: string;
  manifest: string;
  audit: string;
  availability: string;
  work: string;
  checkpoint: string;
  sourceParts: string;
  outputParts: string;
  partStats: string;
}

@Injectable()
export class RecommendationDecisionDatasetV5Service implements OnModuleInit {
  private readonly logger = new Logger(
    RecommendationDecisionDatasetV5Service.name,
  );
  private readonly sourceDirectory =
    process.env.DEADLOCK_RECOMMENDATION_DECISION_DATASET_V5_SOURCE_DIR?.trim() ||
    DEFAULT_SOURCE_DIR;
  private readonly timelineDirectory =
    process.env.DEADLOCK_TIMELINE_STORAGE_DIR?.trim() || DEFAULT_TIMELINE_DIR;
  private readonly outputDirectory =
    process.env.DEADLOCK_RECOMMENDATION_DECISION_DATASET_V5_DIR?.trim() ||
    DEFAULT_OUTPUT_DIR;
  private readonly paths = createPaths(this.outputDirectory);
  private status = this.idleStatus();
  private manifest?: Record<string, unknown>;
  private audit?: Record<string, unknown>;
  private availability?: Record<string, unknown>;
  private runPromise: Promise<void> = Promise.resolve();

  async onModuleInit(): Promise<void> {
    await mkdir(this.outputDirectory, { recursive: true });
    const [manifest, audit, availability] = await Promise.all([
      readJson<Record<string, unknown>>(this.paths.manifest),
      readJson<Record<string, unknown>>(this.paths.audit),
      readJson<Record<string, unknown>>(this.paths.availability),
    ]);
    this.manifest = manifest;
    this.audit = audit;
    this.availability = availability;
    if (manifest && audit && availability && (await exists(this.paths.dataset))) {
      const artifact = record(manifest.artifact);
      const rows = record(audit.rows);
      const processing = record(audit.processing);
      const integrity = record(audit.integrity);
      this.status = {
        ...this.idleStatus(),
        state: 'COMPLETE',
        phase: 'COMPLETE',
        sourceRowCount: numeric(record(audit.source).rowCount),
        partitionCount: numeric(processing.partitionCount),
        processedPartitionCount: numeric(processing.partitionCount),
        outputRowCount: numeric(artifact.rowCount),
        rowsWithTimelineCount: numeric(rows.withTimelineCount),
        rowsWithComplete3mOutcomeCount: numeric(rows.withComplete3mOutcomeCount),
        duplicateDecisionIdCount: numeric(integrity.duplicateDecisionIdCount),
        completedAt: text(manifest.generatedAt),
        datasetAvailable: true,
        manifestAvailable: true,
        auditAvailable: true,
        sourceAvailabilityAvailable: true,
      };
    }
  }

  async start(
    request: RecommendationDecisionDatasetV5StartRequest = {},
  ): Promise<RecommendationDecisionDatasetV5Status> {
    if (this.status.state === 'RUNNING') {
      throw new Error('Recommendation Dataset V5 build is already running.');
    }
    const options = normalizeOptions(request);
    const startedAt = new Date().toISOString();
    this.status = {
      ...this.idleStatus(),
      state: 'RUNNING',
      phase: 'PREPARING',
      startedAt,
      partitionCount: options.partitionCount,
    };
    this.runPromise = this.run(options, startedAt);
    return this.getStatus();
  }

  async waitForIdle(): Promise<void> {
    await this.runPromise;
  }

  getStatus(): RecommendationDecisionDatasetV5Status {
    return clone(this.status);
  }

  getManifest(): Record<string, unknown> | undefined {
    return this.manifest ? clone(this.manifest) : undefined;
  }

  getAudit(): Record<string, unknown> | undefined {
    return this.audit ? clone(this.audit) : undefined;
  }

  getSourceAvailability(): Record<string, unknown> | undefined {
    return this.availability ? clone(this.availability) : undefined;
  }

  private async run(options: Options, startedAt: string): Promise<void> {
    try {
      const source = await loadSource(this.sourceDirectory, options);
      const catalog = await loadCatalog(options);
      const optionsHash = sha256StableJson(options);
      let checkpoint = options.resume
        ? await readJson<Checkpoint>(this.paths.checkpoint)
        : undefined;
      if (
        !checkpoint ||
        checkpoint.datasetVersion !== RECOMMENDATION_DECISION_DATASET_V5_VERSION ||
        checkpoint.sourceSha256 !== source.sha256 ||
        checkpoint.optionsHash !== optionsHash
      ) {
        await this.clearBuild();
        checkpoint = {
          datasetVersion: RECOMMENDATION_DECISION_DATASET_V5_VERSION,
          sourceSha256: source.sha256,
          optionsHash,
          partitioningComplete: false,
          sourceRowCount: 0,
          completedPartitions: [],
          updatedAt: new Date().toISOString(),
        };
        await atomicJson(this.paths.checkpoint, checkpoint);
      }
      await Promise.all([
        mkdir(this.paths.sourceParts, { recursive: true }),
        mkdir(this.paths.outputParts, { recursive: true }),
        mkdir(this.paths.partStats, { recursive: true }),
      ]);

      if (!checkpoint.partitioningComplete) {
        this.status = { ...this.status, phase: 'PARTITIONING' };
        checkpoint.sourceRowCount = await partitionSource(
          source.path,
          this.paths,
          options.partitionCount,
          (count) => {
            this.status = { ...this.status, sourceRowCount: count };
          },
        );
        checkpoint.partitioningComplete = true;
        checkpoint.updatedAt = new Date().toISOString();
        await atomicJson(this.paths.checkpoint, checkpoint);
      }

      this.status = {
        ...this.status,
        phase: 'ENRICHING',
        sourceRowCount: checkpoint.sourceRowCount,
        processedPartitionCount: checkpoint.completedPartitions.length,
      };
      const complete = new Set(checkpoint.completedPartitions);
      for (let index = 0; index < options.partitionCount; index += 1) {
        if (complete.has(index)) {
          continue;
        }
        const stats = await processPartition({
          index,
          paths: this.paths,
          timelineDirectory: this.timelineDirectory,
          snapshotStalenessS: options.snapshotStalenessS,
          catalog,
        });
        await atomicJson(statsPath(this.paths, index), stats);
        checkpoint.completedPartitions.push(index);
        checkpoint.completedPartitions.sort((left, right) => left - right);
        checkpoint.updatedAt = new Date().toISOString();
        await atomicJson(this.paths.checkpoint, checkpoint);
        this.status = {
          ...this.status,
          processedPartitionCount: checkpoint.completedPartitions.length,
        };
      }

      this.status = { ...this.status, phase: 'FINALIZING' };
      await combineParts(this.paths, options.partitionCount);
      const totals = await loadTotals(this.paths, options.partitionCount);
      const datasetStat = await stat(this.paths.dataset);
      const datasetSha256 = await hashFile(this.paths.dataset);
      const generatedAt = new Date().toISOString();
      const warnings = [
        'Historical completed-match metadata does not contain exact bounded KDA, net-worth, or objective snapshots; live timeline or replay artifacts are required.',
      ];
      if (totals.rowsWithTimelineCount < totals.outputRowCount) {
        warnings.push(
          `${totals.outputRowCount - totals.rowsWithTimelineCount} rows have no matching live timeline artifact.`,
        );
      }
      const availability = sourceAvailability(generatedAt, totals, catalog);
      const audit = {
        schemaVersion: RECOMMENDATION_DECISION_DATASET_V5_SCHEMA_VERSION,
        datasetVersion: RECOMMENDATION_DECISION_DATASET_V5_VERSION,
        generatedAt,
        passed:
          totals.sourceRowCount === totals.outputRowCount &&
          totals.duplicateDecisionIdCount === 0 &&
          totals.invalidRowCount === 0,
        source: {
          kind: 'RECOMMENDATION_DECISION_DATASET_V4',
          datasetVersion: source.datasetVersion,
          path: source.path,
          sha256: source.sha256,
          byteLength: source.byteLength,
          rowCount: totals.sourceRowCount,
          auditPassed: true,
        },
        processing: {
          partitionCount: options.partitionCount,
          deterministicPartitionKey: 'matchId + steamId + heroId',
          checkpointResumeEnabled: options.resume,
          snapshotStalenessS: options.snapshotStalenessS,
        },
        rows: {
          rowCount: totals.outputRowCount,
          withTimelineCount: totals.rowsWithTimelineCount,
          withComplete3mOutcomeCount: totals.complete3m,
          withComplete5mOutcomeCount: totals.complete5m,
          withComplete10mOutcomeCount: totals.complete10m,
          withCatalogCount: totals.rowsWithCatalogCount,
        },
        integrity: {
          duplicateDecisionIdCount: totals.duplicateDecisionIdCount,
          invalidRowCount: totals.invalidRowCount,
        },
        leakage: {
          featureCutoff: 'DECISION_GAME_TIME_INCLUSIVE',
          futureTimelineUsedAsInputFeature: false,
          teamEconomySnapshotsAtOrBeforeDecisionOnly: true,
          horizonWindowLowerBoundExclusive: true,
          horizonWindowUpperBoundInclusive: true,
          finalOutcomeUsedAsInputFeature: false,
          candidateSetReconstructedFromFutureActions: false,
        },
        warnings,
      };
      const manifest = {
        schemaVersion: RECOMMENDATION_DECISION_DATASET_V5_SCHEMA_VERSION,
        datasetVersion: RECOMMENDATION_DECISION_DATASET_V5_VERSION,
        generatedAt,
        source: {
          datasetVersion: source.datasetVersion,
          directory: this.sourceDirectory,
          fileName: DATASET_FILE,
          sha256: source.sha256,
          byteLength: source.byteLength,
          rowCount: totals.sourceRowCount,
        },
        timelineSource: {
          timelineVersion: MATCH_TIMELINE_VERSION,
          directory: this.timelineDirectory,
          optional: true,
        },
        catalogSource: catalog.available
          ? {
              path: catalog.path,
              sha256: catalog.sha256,
              catalogVersionId: catalog.catalogVersionId,
            }
          : { available: false },
        options,
        artifact: {
          format: 'NDJSON',
          fileName: DATASET_FILE,
          byteLength: datasetStat.size,
          sha256: datasetSha256,
          rowCount: totals.outputRowCount,
        },
        featureContract: {
          featureCutoff: 'DECISION_GAME_TIME_INCLUSIVE',
          trajectoryFields: [
            'fullPreviousActionKeys',
            'decisionIndex',
            'nextObservedActionKey',
            'timeToNextObservedActionS',
          ],
          stateFeatures: [
            'playerTimelineSnapshot',
            'teamEconomy',
            'inventory',
            'candidateActions',
          ],
          shortHorizonTargets: ['3m', '5m', '10m'],
          finalOutcomeAuxiliaryOnly: true,
        },
        auditPassed: audit.passed,
        warnings,
      };
      await Promise.all([
        atomicJson(this.paths.audit, audit),
        atomicJson(this.paths.manifest, manifest),
        atomicJson(this.paths.availability, availability),
      ]);
      this.audit = audit;
      this.manifest = manifest;
      this.availability = availability;
      this.status = {
        ...this.status,
        state: 'COMPLETE',
        phase: 'COMPLETE',
        completedAt: generatedAt,
        sourceRowCount: totals.sourceRowCount,
        processedPartitionCount: options.partitionCount,
        outputRowCount: totals.outputRowCount,
        rowsWithTimelineCount: totals.rowsWithTimelineCount,
        rowsWithComplete3mOutcomeCount: totals.complete3m,
        duplicateDecisionIdCount: totals.duplicateDecisionIdCount,
        datasetAvailable: true,
        manifestAvailable: true,
        auditAvailable: true,
        sourceAvailabilityAvailable: true,
      };
      await rm(this.paths.work, { recursive: true, force: true });
      this.logger.log(
        `Recommendation Dataset V5 completed with ${totals.outputRowCount} rows.`,
      );
    } catch (error) {
      const message = errorMessage(error);
      this.status = {
        ...this.status,
        state: 'FAILED',
        completedAt: new Date().toISOString(),
        error: message,
      };
      this.logger.error(`Recommendation Dataset V5 failed: ${message}`);
    }
  }

  private async clearBuild(): Promise<void> {
    await Promise.all([
      rm(this.paths.dataset, { force: true }),
      rm(`${this.paths.dataset}.partial`, { force: true }),
      rm(this.paths.manifest, { force: true }),
      rm(this.paths.audit, { force: true }),
      rm(this.paths.availability, { force: true }),
      rm(this.paths.work, { recursive: true, force: true }),
    ]);
  }

  private idleStatus(): RecommendationDecisionDatasetV5Status {
    return {
      state: 'IDLE',
      phase: 'PREPARING',
      sourceRowCount: 0,
      processedPartitionCount: 0,
      partitionCount: 0,
      outputRowCount: 0,
      rowsWithTimelineCount: 0,
      rowsWithComplete3mOutcomeCount: 0,
      duplicateDecisionIdCount: 0,
      outputDirectory: this.outputDirectory,
      datasetPath: this.paths.dataset,
      datasetAvailable: false,
      manifestAvailable: false,
      auditAvailable: false,
      sourceAvailabilityAvailable: false,
    };
  }
}

async function loadSource(directory: string, options: Options): Promise<{
  path: string;
  datasetVersion: string;
  sha256: string;
  byteLength: number;
}> {
  const path = join(directory, DATASET_FILE);
  const manifest = await requiredJson<Record<string, unknown>>(
    join(directory, 'manifest.json'),
    'Recommendation Dataset V4 manifest',
  );
  const audit = await requiredJson<Record<string, unknown>>(
    join(directory, 'audit.json'),
    'Recommendation Dataset V4 audit',
  );
  if (manifest.auditPassed !== true || audit.passed !== true) {
    throw new Error('Recommendation Dataset V4 source did not pass audit.');
  }
  const expected = requiredSha(record(manifest.artifact).sha256);
  const actual = await hashFile(path);
  if (expected !== actual) {
    throw new Error(`Source artifact hash mismatch: ${actual} versus ${expected}.`);
  }
  if (options.expectedSourceSha256 && options.expectedSourceSha256 !== actual) {
    throw new Error(
      `Source SHA-256 mismatch: expected ${options.expectedSourceSha256}, received ${actual}.`,
    );
  }
  return {
    path,
    datasetVersion: requiredText(manifest.datasetVersion),
    sha256: actual,
    byteLength: (await stat(path)).size,
  };
}

async function partitionSource(
  sourcePath: string,
  paths: Paths,
  partitionCount: number,
  progress: (count: number) => void,
): Promise<number> {
  await rm(paths.sourceParts, { recursive: true, force: true });
  await mkdir(paths.sourceParts, { recursive: true });
  const handles = new Map<number, FileHandle>();
  let count = 0;
  try {
    for await (const value of ndjson(sourcePath)) {
      const row = sourceRow(value, count + 1);
      const index = partitionIndex(
        `${row.matchId}\u0000${row.steamId}\u0000${row.heroId}`,
        partitionCount,
      );
      let handle = handles.get(index);
      if (!handle) {
        handle = await open(sourcePart(paths, index), 'a');
        handles.set(index, handle);
      }
      await handle.write(`${JSON.stringify(row)}\n`);
      count += 1;
      if (count % 50_000 === 0) {
        progress(count);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  } finally {
    await Promise.all([...handles.values()].map((handle) => handle.close()));
  }
  progress(count);
  return count;
}

async function processPartition(input: {
  index: number;
  paths: Paths;
  timelineDirectory: string;
  snapshotStalenessS: number;
  catalog: CatalogData;
}): Promise<PartStats> {
  const sourcePath = sourcePart(input.paths, input.index);
  const outputPath = outputPart(input.paths, input.index);
  if (!(await exists(sourcePath))) {
    await writeFile(outputPath, '', 'utf8');
    return emptyStats(input.index);
  }
  const rows: RecommendationDecisionDatasetV4Row[] = [];
  let invalidRowCount = 0;
  for await (const value of ndjson(sourcePath)) {
    try {
      rows.push(sourceRow(value, rows.length + invalidRowCount + 1));
    } catch {
      invalidRowCount += 1;
    }
  }
  rows.sort(compareRows);
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  const timelineCache = new Map<string, Promise<TimelineData>>();
  const handle = await open(`${outputPath}.partial`, 'w');
  const stats = emptyStats(input.index);
  stats.sourceRowCount = rows.length + invalidRowCount;
  stats.invalidRowCount = invalidRowCount;
  try {
    let start = 0;
    while (start < rows.length) {
      let end = start + 1;
      while (end < rows.length && groupKey(rows[end]) === groupKey(rows[start])) {
        end += 1;
      }
      const group = rows.slice(start, end);
      const timeline = await cachedTimeline(
        timelineCache,
        input.timelineDirectory,
        group[0].matchId,
      );
      let previousActions: string[] = [];
      for (let index = 0; index < group.length; index += 1) {
        const row = group[index];
        const rowPreviousActions = mergeActionHistories(
          previousActions,
          row.previousActionKeys,
        );
        if (seen.has(row.decisionId)) {
          duplicates.add(row.decisionId);
        } else {
          seen.add(row.decisionId);
        }
        const result = enrich({
          row,
          nextRow: group[index + 1],
          previousActions: rowPreviousActions,
          timeline,
          snapshotStalenessS: input.snapshotStalenessS,
          catalog: input.catalog,
        });
        await handle.write(`${JSON.stringify(result.row)}\n`);
        stats.outputRowCount += 1;
        stats.rowsWithTimelineCount += result.hasTimeline ? 1 : 0;
        stats.complete3m += result.complete3m ? 1 : 0;
        stats.complete5m += result.complete5m ? 1 : 0;
        stats.complete10m += result.complete10m ? 1 : 0;
        stats.rowsWithCatalogCount += result.hasCatalog ? 1 : 0;
        previousActions = mergeActionHistories(
          rowPreviousActions,
          row.observedLabel.observedActionKeys,
        );
      }
      start = end;
    }
  } finally {
    await handle.close();
  }
  stats.duplicateDecisionIdCount = duplicates.size;
  await rename(`${outputPath}.partial`, outputPath);
  return stats;
}


function mergeActionHistories(
  accumulated: readonly string[],
  additional: readonly string[],
): string[] {
  const normalizedAdditional = additional.filter(
    (actionKey) => actionKey.length > 0,
  );
  if (normalizedAdditional.length === 0) {
    return [...accumulated];
  }
  const maximumOverlap = Math.min(accumulated.length, normalizedAdditional.length);
  for (let overlap = maximumOverlap; overlap > 0; overlap -= 1) {
    const accumulatedSuffix = accumulated.slice(accumulated.length - overlap);
    const additionalPrefix = normalizedAdditional.slice(0, overlap);
    if (
      accumulatedSuffix.every(
        (actionKey, index) => actionKey === additionalPrefix[index],
      )
    ) {
      return [...accumulated, ...normalizedAdditional.slice(overlap)];
    }
  }
  return [...accumulated, ...normalizedAdditional];
}

function enrich(input: {
  row: RecommendationDecisionDatasetV4Row;
  nextRow?: RecommendationDecisionDatasetV4Row;
  previousActions: readonly string[];
  timeline: TimelineData;
  snapshotStalenessS: number;
  catalog: CatalogData;
}): {
  row: Record<string, unknown>;
  hasTimeline: boolean;
  complete3m: boolean;
  complete5m: boolean;
  complete10m: boolean;
  hasCatalog: boolean;
} {
  const snapshots = playerSnapshots(input.timeline.snapshots, input.row);
  const baseline = atOrBefore(snapshots, input.row.gameTimeS);
  const teamEconomy = teamEconomyFeature(
    input.timeline.snapshots,
    input.row,
    input.row.gameTimeS,
    input.snapshotStalenessS,
  );
  const windows = Object.fromEntries(
    HORIZONS.map((horizon) => [
      horizon.key,
      horizonOutcome(
        input.row.gameTimeS,
        horizon.seconds,
        baseline,
        snapshots,
        input.timeline.objectives,
        liveTeam(input.row.teamId),
        input.snapshotStalenessS,
      ),
    ]),
  ) as Record<string, Record<string, unknown>>;
  const itemFeatures = itemAndBuildFeatures(input.row, input.catalog);
  const action = actionDescriptor(input.row.observedLabel.exactActionKey ?? '');
  return {
    row: {
      schemaVersion: RECOMMENDATION_DECISION_DATASET_V5_SCHEMA_VERSION,
      datasetVersion: RECOMMENDATION_DECISION_DATASET_V5_VERSION,
      decisionId: input.row.decisionId,
      source: {
        datasetVersion: input.row.datasetVersion,
        recommendationModel: input.row.recommendationModel,
        modelVersion: input.row.modelVersion,
        modelSha256: input.row.modelSha256,
        candidateSetPolicy: input.row.candidateSetPolicy,
        traversalKey: input.row.traversalKey,
      },
      identity: {
        matchId: input.row.matchId,
        steamId: input.row.steamId,
        heroId: input.row.heroId,
        teamId: input.row.teamId,
        decisionGameTimeS: input.row.gameTimeS,
        decisionOccurredAt: input.row.decisionOccurredAt,
      },
      stateBeforeAction: {
        heroId: input.row.heroId,
        teamId: input.row.teamId,
        gameTimeS: input.row.gameTimeS,
        timeBucket: input.row.timeBucket,
        inventoryStateKey: input.row.inventoryStateKey,
        itemIds: [...input.row.itemIds],
        alliedHeroIds: [...input.row.alliedHeroIds],
        enemyHeroIds: [...input.row.enemyHeroIds],
        buildArchetypeId: input.row.buildArchetypeId,
        candidateActions: input.row.candidateActions.map((candidate) => ({
          ...candidate,
          matchupSignals: candidate.matchupSignals.map((signal) => ({ ...signal })),
        })),
        playerTimelineSnapshot: snapshotFeature(
          baseline,
          input.row.gameTimeS,
          input.snapshotStalenessS,
        ),
        teamEconomy,
      },
      observedAction: {
        actionKey: input.row.observedLabel.exactActionKey,
        actionType: action.actionType,
        itemId: action.itemId,
        observedAtGameTimeS: input.row.observedLabel.observedAtGameTimeS,
        reconstructionConfidence:
          input.row.observedLabel.reconstructionConfidence,
      },
      trajectory: {
        decisionIndex: input.previousActions.length,
        previousActionCount: input.previousActions.length,
        fullPreviousActionKeys: [...input.previousActions],
        nextObservedActionKey: input.nextRow?.observedLabel.exactActionKey,
        timeToNextObservedActionS: input.nextRow
          ? Math.max(0, input.nextRow.gameTimeS - input.row.gameTimeS)
          : undefined,
        isTerminalObservedDecision: !input.nextRow,
      },
      itemAndBuildFeatures: itemFeatures,
      shortHorizonOutcomes: {
        sourceAvailable: input.timeline.available,
        timelineVersion: input.timeline.available ? MATCH_TIMELINE_VERSION : undefined,
        windows,
      },
      finalOutcome: {
        available: input.row.outcomeLabel.available,
        conflicting: input.row.outcomeLabel.conflicting,
        playerWon: input.row.outcomeLabel.playerWon,
        source: input.row.outcomeLabel.source,
        auxiliaryTargetOnly: true,
      },
      trainingEligibility: {
        exactAction: input.row.trainingEligibility.exactAction,
        finalOutcome: input.row.trainingEligibility.outcome,
        shortHorizon3m: windows['3m'].available === true,
        shortHorizon5m: windows['5m'].available === true,
        shortHorizon10m: windows['10m'].available === true,
      },
    },
    hasTimeline: snapshots.length > 0,
    complete3m: windows['3m'].available === true,
    complete5m: windows['5m'].available === true,
    complete10m: windows['10m'].available === true,
    hasCatalog: itemFeatures.available === true,
  };
}

function horizonOutcome(
  decisionTime: number,
  seconds: number,
  baseline: MatchTimelinePlayerSnapshot | undefined,
  snapshots: readonly MatchTimelinePlayerSnapshot[],
  objectives: readonly MatchTimelineObjectiveEvent[],
  teamId: number | undefined,
  snapshotStalenessS: number,
): Record<string, unknown> {
  const upper = decisionTime + seconds;
  const target = latestInWindow(snapshots, decisionTime, upper);
  const baselineStalenessS = baseline
    ? Math.max(0, decisionTime - baseline.gameTimeS)
    : undefined;
  const targetStalenessS = target
    ? Math.max(0, upper - target.gameTimeS)
    : undefined;
  const baselineFresh =
    baseline !== undefined &&
    baselineStalenessS !== undefined &&
    baselineStalenessS <= snapshotStalenessS;
  const targetFresh =
    target !== undefined &&
    targetStalenessS !== undefined &&
    targetStalenessS <= snapshotStalenessS;
  const events = objectives.filter(
    (event) => event.gameTimeS > decisionTime && event.gameTimeS <= upper,
  );
  if (!baselineFresh || !targetFresh || !baseline || !target) {
    return {
      available: false,
      horizonS: seconds,
      lowerBoundGameTimeS: decisionTime,
      upperBoundGameTimeS: upper,
      baselineAvailable: Boolean(baseline),
      baselineFresh,
      baselineStalenessS,
      targetAvailable: Boolean(target),
      targetFresh,
      targetStalenessS,
      objectiveEventCount: events.length,
      unavailableReason: !baseline
        ? 'MISSING_SNAPSHOT_AT_OR_BEFORE_DECISION'
        : !baselineFresh
          ? 'STALE_SNAPSHOT_AT_DECISION'
          : !target
            ? 'MISSING_SNAPSHOT_IN_HORIZON_WINDOW'
            : 'STALE_SNAPSHOT_AT_HORIZON',
    };
  }
  const ownObjectiveLossCount =
    teamId === undefined
      ? undefined
      : events.filter((event) => event.teamId === teamId).length;
  const enemyObjectiveLossCount =
    teamId === undefined
      ? undefined
      : events.filter(
          (event) => event.teamId !== undefined && event.teamId !== teamId,
        ).length;
  return {
    available: true,
    horizonS: seconds,
    lowerBoundGameTimeS: decisionTime,
    upperBoundGameTimeS: upper,
    baselineSnapshotGameTimeS: baseline.gameTimeS,
    baselineStalenessS,
    targetSnapshotGameTimeS: target.gameTimeS,
    targetStalenessS,
    killsDelta: target.kills - baseline.kills,
    deathsDelta: target.deaths - baseline.deaths,
    assistsDelta: target.assists - baseline.assists,
    netWorthDelta: target.netWorth - baseline.netWorth,
    heroDamageDelta: target.heroDamage - baseline.heroDamage,
    killParticipationDelta:
      target.kills + target.assists - baseline.kills - baseline.assists,
    survived: target.deaths === baseline.deaths,
    objectiveEventCount: events.length,
    ownObjectiveLossCount,
    enemyObjectiveLossCount,
  };
}

function snapshotFeature(
  snapshot: MatchTimelinePlayerSnapshot | undefined,
  decisionTime: number,
  staleAfter: number,
): Record<string, unknown> {
  if (!snapshot) {
    return {
      available: false,
      unavailableReason: 'MISSING_SNAPSHOT_AT_OR_BEFORE_DECISION',
    };
  }
  const stalenessS = Math.max(0, decisionTime - snapshot.gameTimeS);
  return {
    available: true,
    gameTimeS: snapshot.gameTimeS,
    stalenessS,
    fresh: stalenessS <= staleAfter,
    steamId: snapshot.steamId,
    heroId: snapshot.heroId,
    teamId: snapshot.teamId,
    kills: snapshot.kills,
    deaths: snapshot.deaths,
    assists: snapshot.assists,
    netWorth: snapshot.netWorth,
    heroDamage: snapshot.heroDamage,
    health: snapshot.health,
    maxHealth: snapshot.maxHealth,
    level: snapshot.level,
  };
}


function teamEconomyFeature(
  snapshots: readonly MatchTimelinePlayerSnapshot[],
  row: RecommendationDecisionDatasetV4Row,
  decisionTime: number,
  staleAfter: number,
): Record<string, unknown> {
  const ownTeamId = liveTeam(row.teamId);
  if (ownTeamId === undefined) {
    return {
      available: false,
      decisionGameTimeS: decisionTime,
      unavailableReason: 'MISSING_PLAYER_TEAM_ID',
    };
  }

  const latest = latestPlayerSnapshotsAtOrBefore(snapshots, decisionTime);
  const teamSnapshots = latest.filter(
    (snapshot) => snapshot.teamId !== undefined,
  );
  const fresh = teamSnapshots.filter(
    (snapshot) => decisionTime - snapshot.gameTimeS <= staleAfter,
  );
  const own = fresh.filter((snapshot) => snapshot.teamId === ownTeamId);
  const enemy = fresh.filter((snapshot) => snapshot.teamId !== ownTeamId);
  const expectedOwnTeamPlayerCount = new Set(row.alliedHeroIds).size;
  const expectedEnemyTeamPlayerCount = new Set(row.enemyHeroIds).size;

  if (own.length === 0 || enemy.length === 0) {
    return {
      available: false,
      decisionGameTimeS: decisionTime,
      snapshotStalenessS: staleAfter,
      ownTeamId,
      freshPlayerCount: fresh.length,
      stalePlayerCount: teamSnapshots.length - fresh.length,
      ownTeamPlayerCount: own.length,
      enemyTeamPlayerCount: enemy.length,
      expectedOwnTeamPlayerCount,
      expectedEnemyTeamPlayerCount,
      unavailableReason:
        own.length === 0
          ? 'MISSING_OWN_TEAM_SNAPSHOT_AT_DECISION'
          : 'MISSING_ENEMY_TEAM_SNAPSHOT_AT_DECISION',
    };
  }

  const ownSummary = teamEconomySummary(own);
  const enemySummary = teamEconomySummary(enemy);
  const player =
    own.find((snapshot) => snapshot.steamId === row.steamId) ??
    own.find((snapshot) => snapshot.heroId === row.heroId);
  const sortedOwn = [...own].sort(
    (left, right) =>
      right.netWorth - left.netWorth ||
      left.heroId - right.heroId ||
      left.steamId.localeCompare(right.steamId),
  );
  const playerRank = player
    ? sortedOwn.findIndex(
        (snapshot) =>
          snapshot.steamId === player.steamId &&
          snapshot.heroId === player.heroId,
      ) + 1
    : undefined;
  const netWorthDelta = ownSummary.netWorth - enemySummary.netWorth;
  const combinedNetWorth = ownSummary.netWorth + enemySummary.netWorth;

  return {
    available: true,
    decisionGameTimeS: decisionTime,
    snapshotStalenessS: staleAfter,
    ownTeamId,
    enemyTeamIds: [
      ...new Set(
        enemy
          .map((snapshot) => snapshot.teamId)
          .filter((teamId): teamId is number => teamId !== undefined),
      ),
    ].sort((left, right) => left - right),
    freshPlayerCount: fresh.length,
    stalePlayerCount: teamSnapshots.length - fresh.length,
    expectedOwnTeamPlayerCount,
    expectedEnemyTeamPlayerCount,
    completeOwnTeam:
      expectedOwnTeamPlayerCount > 0 &&
      own.length >= expectedOwnTeamPlayerCount,
    completeEnemyTeam:
      expectedEnemyTeamPlayerCount > 0 &&
      enemy.length >= expectedEnemyTeamPlayerCount,
    ownTeam: ownSummary,
    enemyTeam: enemySummary,
    netWorthDelta,
    relativeNetWorthDelta:
      combinedNetWorth > 0 ? netWorthDelta / combinedNetWorth : 0,
    playerNetWorth: player?.netWorth,
    playerNetWorthShare:
      player && ownSummary.netWorth > 0
        ? player.netWorth / ownSummary.netWorth
        : undefined,
    playerNetWorthRankInTeam: playerRank && playerRank > 0 ? playerRank : undefined,
  };
}

function latestPlayerSnapshotsAtOrBefore(
  snapshots: readonly MatchTimelinePlayerSnapshot[],
  decisionTime: number,
): MatchTimelinePlayerSnapshot[] {
  const latest = new Map<string, MatchTimelinePlayerSnapshot>();
  for (const snapshot of snapshots) {
    if (snapshot.gameTimeS > decisionTime) {
      break;
    }
    const key = snapshot.steamId
      ? `STEAM:${snapshot.steamId}`
      : `HERO:${snapshot.teamId ?? 'UNKNOWN'}:${snapshot.heroId}`;
    const existing = latest.get(key);
    if (!existing || compareSnapshots(existing, snapshot) <= 0) {
      latest.set(key, snapshot);
    }
  }
  return [...latest.values()].sort(compareSnapshots);
}

function teamEconomySummary(
  snapshots: readonly MatchTimelinePlayerSnapshot[],
): {
  playerCount: number;
  netWorth: number;
  averageNetWorth: number;
  highestNetWorth: number;
  lowestNetWorth: number;
} {
  const values = snapshots.map((snapshot) => snapshot.netWorth);
  const netWorth = values.reduce((sum, value) => sum + value, 0);
  return {
    playerCount: snapshots.length,
    netWorth,
    averageNetWorth: snapshots.length > 0 ? netWorth / snapshots.length : 0,
    highestNetWorth: values.length > 0 ? Math.max(...values) : 0,
    lowestNetWorth: values.length > 0 ? Math.min(...values) : 0,
  };
}

function itemAndBuildFeatures(
  row: RecommendationDecisionDatasetV4Row,
  catalog: CatalogData,
): Record<string, unknown> {
  if (!catalog.available) {
    return {
      available: false,
      inventoryStateKey: row.inventoryStateKey,
      unavailableReason: 'CATALOG_SNAPSHOT_NOT_CONFIGURED',
    };
  }
  const multiset = parseInventoryStateKey(row.inventoryStateKey);
  const itemIds = multiset
    ? [...multiset.entries()].flatMap(([itemId, count]) =>
        Array.from({ length: count }, () => itemId),
      )
    : [...row.itemIds];
  const inventoryItems = itemIds.map((itemId) => catalogItem(itemId, catalog));
  const slotCounts: Record<string, number> = {};
  for (const item of inventoryItems) {
    const slot = text(item.slotType) ?? 'unknown';
    slotCounts[slot] = (slotCounts[slot] ?? 0) + 1;
  }
  const observed = actionDescriptor(row.observedLabel.exactActionKey ?? '');
  const progress = recipeProgress(itemIds, catalog);
  const spikeCosts = progress
    .filter((entry) => entry.complete !== true)
    .map((entry) => numeric(entry.missingCost))
    .filter((value) => value > 0);
  return {
    available: true,
    catalogVersionId: catalog.catalogVersionId,
    catalogSha256: catalog.sha256,
    inventory: {
      itemCount: itemIds.length,
      totalCost: inventoryItems.reduce(
        (sum, item) => sum + numeric(item.cost),
        0,
      ),
      highestTier: inventoryItems.reduce(
        (highest, item) => Math.max(highest, numeric(item.tier)),
        0,
      ),
      slotCounts,
      items: inventoryItems,
    },
    observedAction: {
      ...observed,
      item: observed.itemId ? catalogItem(observed.itemId, catalog) : undefined,
      interactionKeys: observed.itemId
        ? interactionKeys(row, observed.itemId)
        : [],
    },
    candidates: row.candidateActions.map((candidate) => {
      const action = actionDescriptor(candidate.actionKey);
      return {
        actionKey: candidate.actionKey,
        actionType: action.actionType,
        item: action.itemId ? catalogItem(action.itemId, catalog) : undefined,
        interactionKeys: action.itemId
          ? interactionKeys(row, action.itemId)
          : [],
      };
    }),
    recipeProgress: progress,
    distanceToNextPowerSpikeCost:
      spikeCosts.length > 0 ? Math.min(...spikeCosts) : undefined,
  };
}

function recipeProgress(
  inventory: readonly number[],
  catalog: CatalogData,
): Array<Record<string, unknown>> {
  const owned = new Map<number, number>();
  inventory.forEach((itemId) => owned.set(itemId, (owned.get(itemId) ?? 0) + 1));
  const result: Array<Record<string, unknown>> = [];
  for (const [parentItemId, components] of catalog.recipes) {
    const remaining = new Map(owned);
    let ownedCount = 0;
    let missingCost = 0;
    for (const componentId of components) {
      const count = remaining.get(componentId) ?? 0;
      if (count > 0) {
        ownedCount += 1;
        remaining.set(componentId, count - 1);
      } else {
        missingCost += catalog.items.get(componentId)?.cost ?? 0;
      }
    }
    if (ownedCount > 0 || owned.has(parentItemId)) {
      result.push({
        parentItemId,
        componentItemIds: [...components],
        ownedComponentCount: ownedCount,
        missingComponentCount: components.length - ownedCount,
        missingCost,
        complete: owned.has(parentItemId),
      });
    }
  }
  return result.sort(
    (left, right) =>
      numeric(left.missingCost) - numeric(right.missingCost) ||
      numeric(left.parentItemId) - numeric(right.parentItemId),
  );
}

function interactionKeys(
  row: RecommendationDecisionDatasetV4Row,
  itemId: number,
): string[] {
  return [
    `HERO_ITEM:${row.heroId}:${itemId}`,
    `INVENTORY_ITEM:${row.inventoryStateKey}:${itemId}`,
    ...row.alliedHeroIds.map((heroId) => `ALLY_ITEM:${heroId}:${itemId}`),
    ...row.enemyHeroIds.map((heroId) => `ENEMY_ITEM:${heroId}:${itemId}`),
  ];
}

function playerSnapshots(
  snapshots: readonly MatchTimelinePlayerSnapshot[],
  row: RecommendationDecisionDatasetV4Row,
): MatchTimelinePlayerSnapshot[] {
  const exact = snapshots.filter((snapshot) => snapshot.steamId === row.steamId);
  return (exact.length > 0
    ? exact
    : snapshots.filter((snapshot) => snapshot.heroId === row.heroId)
  ).sort(compareSnapshots);
}

function atOrBefore(
  snapshots: readonly MatchTimelinePlayerSnapshot[],
  time: number,
): MatchTimelinePlayerSnapshot | undefined {
  let result: MatchTimelinePlayerSnapshot | undefined;
  for (const snapshot of snapshots) {
    if (snapshot.gameTimeS > time) {
      break;
    }
    result = snapshot;
  }
  return result;
}

function latestInWindow(
  snapshots: readonly MatchTimelinePlayerSnapshot[],
  lower: number,
  upper: number,
): MatchTimelinePlayerSnapshot | undefined {
  let result: MatchTimelinePlayerSnapshot | undefined;
  for (const snapshot of snapshots) {
    if (snapshot.gameTimeS <= lower) {
      continue;
    }
    if (snapshot.gameTimeS > upper) {
      break;
    }
    result = snapshot;
  }
  return result;
}

async function cachedTimeline(
  cache: Map<string, Promise<TimelineData>>,
  root: string,
  matchId: string,
): Promise<TimelineData> {
  let value = cache.get(matchId);
  if (!value) {
    value = loadTimeline(root, matchId);
    cache.set(matchId, value);
  }
  return value;
}

async function loadTimeline(root: string, matchId: string): Promise<TimelineData> {
  const directory = join(root, matchId);
  const audit = await readJson<Record<string, unknown>>(join(directory, 'audit.json'));
  const manifest = await readJson<Record<string, unknown>>(
    join(directory, 'manifest.json'),
  );
  if (!audit || audit.passed !== true || !manifest) {
    return { available: false, snapshots: [], objectives: [] };
  }
  const snapshots: MatchTimelinePlayerSnapshot[] = [];
  const objectives: MatchTimelineObjectiveEvent[] = [];
  for await (const value of ndjson(
    join(directory, 'player-snapshots.ndjson'),
    true,
  )) {
    if (isRecord(value)) {
      snapshots.push(value as unknown as MatchTimelinePlayerSnapshot);
    }
  }
  for await (const value of ndjson(
    join(directory, 'objective-events.ndjson'),
    true,
  )) {
    if (isRecord(value)) {
      objectives.push(value as unknown as MatchTimelineObjectiveEvent);
    }
  }
  snapshots.sort(compareSnapshots);
  objectives.sort(
    (left, right) =>
      left.gameTimeS - right.gameTimeS ||
      left.objectiveEventId.localeCompare(right.objectiveEventId),
  );
  return { available: true, snapshots, objectives };
}

async function loadCatalog(options: Options): Promise<CatalogData> {
  if (!options.catalogSnapshotPath) {
    return { available: false, items: new Map(), recipes: new Map() };
  }
  const content = await readFile(options.catalogSnapshotPath, 'utf8');
  const sha256 = createHash('sha256').update(content).digest('hex');
  if (options.expectedCatalogSha256 && options.expectedCatalogSha256 !== sha256) {
    throw new Error(
      `Catalog SHA-256 mismatch: expected ${options.expectedCatalogSha256}, received ${sha256}.`,
    );
  }
  const value = JSON.parse(content) as unknown;
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new Error('Catalog snapshot must contain an items array.');
  }
  const items = new Map<number, CatalogItem>();
  for (const entry of value.items) {
    if (!isRecord(entry)) {
      continue;
    }
    const itemId = positiveInteger(entry.itemId ?? entry.item_id);
    if (itemId === undefined) {
      continue;
    }
    items.set(itemId, {
      itemId,
      name: text(entry.name),
      cost: nonNegative(entry.cost) ?? 0,
      tier: nonNegative(entry.tier) ?? 0,
      slotType: text(entry.slotType ?? entry.slot_type) ?? 'unknown',
      itemType: text(entry.itemType ?? entry.item_type),
      isActiveItem:
        typeof entry.isActiveItem === 'boolean'
          ? entry.isActiveItem
          : typeof entry.is_active_item === 'boolean'
            ? entry.is_active_item
            : undefined,
      activationType: text(entry.activationType ?? entry.activation_type),
      tags: Array.isArray(entry.tags)
        ? entry.tags.filter((tag): tag is string => typeof tag === 'string')
        : undefined,
    });
  }
  const recipes = new Map<number, number[]>();
  if (Array.isArray(value.recipes)) {
    for (const entry of value.recipes) {
      if (!isRecord(entry)) {
        continue;
      }
      const parent = positiveInteger(entry.parentItemId ?? entry.parent_item_id);
      const component = positiveInteger(
        entry.componentItemId ?? entry.component_item_id,
      );
      if (parent !== undefined && component !== undefined) {
        const values = recipes.get(parent) ?? [];
        values.push(component);
        recipes.set(parent, values);
      }
    }
  }
  return {
    available: true,
    path: options.catalogSnapshotPath,
    sha256,
    catalogVersionId: positiveInteger(
      value.catalogVersionId ?? value.catalog_version_id,
    ),
    items,
    recipes,
  };
}

function catalogItem(itemId: number, catalog: CatalogData): Record<string, unknown> {
  const item = catalog.items.get(itemId);
  return item ? { ...item, tags: item.tags ? [...item.tags] : undefined } : { itemId, available: false };
}

function sourceAvailability(
  generatedAt: string,
  totals: PartStats,
  catalog: CatalogData,
): Record<string, unknown> {
  return {
    schemaVersion: RECOMMENDATION_DECISION_DATASET_V5_SCHEMA_VERSION,
    datasetVersion: RECOMMENDATION_DECISION_DATASET_V5_VERSION,
    generatedAt,
    fields: {
      purchaseTrajectory: {
        available: true,
        source: 'Recommendation Dataset V4 ordered decision rows',
        coverageCount: totals.sourceRowCount,
      },
      itemCatalogAndRecipes: {
        available: catalog.available,
        source: catalog.path,
        coverageCount: totals.rowsWithCatalogCount,
      },
      shortHorizonKdaAndNetWorth: {
        available: totals.complete3m > 0,
        source: 'match-timeline-events-v1/player-snapshots.ndjson',
        coverage: {
          anyTimeline: totals.rowsWithTimelineCount,
          complete3m: totals.complete3m,
          complete5m: totals.complete5m,
          complete10m: totals.complete10m,
        },
      },
      shortHorizonObjectives: {
        available: totals.rowsWithTimelineCount > 0,
        source: 'match-timeline-events-v1/objective-events.ndjson',
      },
      historicalCompletedMatchShortHorizonBackfill: {
        available: false,
        reason:
          'Completed match metadata exposes final aggregate statistics only. Live timeline or demo replay artifacts are required.',
      },
      finalWinLoss: {
        available: true,
        source: 'Recommendation Dataset V4 outcomeLabel',
      },
    },
  };
}

async function combineParts(paths: Paths, partitionCount: number): Promise<void> {
  const partial = `${paths.dataset}.partial`;
  await rm(partial, { force: true });
  const output = await open(partial, 'w');
  try {
    for (let index = 0; index < partitionCount; index += 1) {
      const path = outputPart(paths, index);
      if (!(await exists(path))) {
        continue;
      }
      for await (const chunk of createReadStream(path)) {
        await output.write(chunk as Buffer);
      }
    }
  } finally {
    await output.close();
  }
  await rm(paths.dataset, { force: true });
  await rename(partial, paths.dataset);
}

async function loadTotals(paths: Paths, partitionCount: number): Promise<PartStats> {
  const total = emptyStats(-1);
  for (let index = 0; index < partitionCount; index += 1) {
    const value = await requiredJson<PartStats>(statsPath(paths, index), 'partition stats');
    total.sourceRowCount += value.sourceRowCount;
    total.outputRowCount += value.outputRowCount;
    total.rowsWithTimelineCount += value.rowsWithTimelineCount;
    total.complete3m += value.complete3m;
    total.complete5m += value.complete5m;
    total.complete10m += value.complete10m;
    total.rowsWithCatalogCount += value.rowsWithCatalogCount;
    total.duplicateDecisionIdCount += value.duplicateDecisionIdCount;
    total.invalidRowCount += value.invalidRowCount;
  }
  return total;
}

function emptyStats(index: number): PartStats {
  return {
    partitionIndex: index,
    sourceRowCount: 0,
    outputRowCount: 0,
    rowsWithTimelineCount: 0,
    complete3m: 0,
    complete5m: 0,
    complete10m: 0,
    rowsWithCatalogCount: 0,
    duplicateDecisionIdCount: 0,
    invalidRowCount: 0,
  };
}

function sourceRow(value: unknown, line: number): RecommendationDecisionDatasetV4Row {
  if (
    !isRecord(value) ||
    value.datasetVersion !== RECOMMENDATION_DECISION_DATASET_V4_VERSION ||
    typeof value.decisionId !== 'string' ||
    typeof value.matchId !== 'string' ||
    typeof value.steamId !== 'string' ||
    !Number.isSafeInteger(Number(value.heroId)) ||
    !Number.isFinite(Number(value.gameTimeS)) ||
    !isRecord(value.observedLabel) ||
    !isRecord(value.outcomeLabel) ||
    !isRecord(value.trainingEligibility) ||
    !Array.isArray(value.candidateActions)
  ) {
    throw new Error(`Invalid Recommendation Dataset V4 row at line ${line}.`);
  }
  return value as unknown as RecommendationDecisionDatasetV4Row;
}

function compareRows(
  left: RecommendationDecisionDatasetV4Row,
  right: RecommendationDecisionDatasetV4Row,
): number {
  return (
    left.matchId.localeCompare(right.matchId) ||
    left.steamId.localeCompare(right.steamId) ||
    left.heroId - right.heroId ||
    left.gameTimeS - right.gameTimeS ||
    left.decisionId.localeCompare(right.decisionId)
  );
}

function compareSnapshots(
  left: MatchTimelinePlayerSnapshot,
  right: MatchTimelinePlayerSnapshot,
): number {
  return (
    left.gameTimeS - right.gameTimeS ||
    left.tick - right.tick ||
    left.snapshotId.localeCompare(right.snapshotId)
  );
}

function groupKey(row: RecommendationDecisionDatasetV4Row): string {
  return `${row.matchId}\u0000${row.steamId}\u0000${row.heroId}`;
}

function actionDescriptor(actionKey: string): {
  actionKey: string;
  actionType: string;
  itemId?: number;
} {
  const [actionType = 'UNKNOWN', rawItemId] = actionKey.split(':', 2);
  return { actionKey, actionType, itemId: positiveInteger(rawItemId) };
}

function liveTeam(teamId: number | undefined): number | undefined {
  return teamId === 0 ? 2 : teamId === 1 ? 3 : teamId;
}

function partitionIndex(value: string, count: number): number {
  return createHash('sha256').update(value).digest().readUInt32BE(0) % count;
}

function createPaths(outputDirectory: string): Paths {
  const work = join(outputDirectory, 'work');
  return {
    dataset: join(outputDirectory, DATASET_FILE),
    manifest: join(outputDirectory, 'manifest.json'),
    audit: join(outputDirectory, 'audit.json'),
    availability: join(outputDirectory, 'source-availability.json'),
    work,
    checkpoint: join(work, 'checkpoint.json'),
    sourceParts: join(work, 'source-parts'),
    outputParts: join(work, 'output-parts'),
    partStats: join(work, 'part-stats'),
  };
}

function sourcePart(paths: Paths, index: number): string {
  return join(paths.sourceParts, `part-${String(index).padStart(4, '0')}.ndjson`);
}

function outputPart(paths: Paths, index: number): string {
  return join(paths.outputParts, `part-${String(index).padStart(4, '0')}.ndjson`);
}

function statsPath(paths: Paths, index: number): string {
  return join(paths.partStats, `part-${String(index).padStart(4, '0')}.json`);
}

async function* ndjson(path: string, optional = false): AsyncGenerator<unknown> {
  if (optional && !(await exists(path))) {
    return;
  }
  const lines = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let line = 0;
  for await (const value of lines) {
    line += 1;
    if (!value.trim()) {
      continue;
    }
    try {
      yield JSON.parse(value) as unknown;
    } catch {
      throw new Error(`Invalid JSON in ${path} at line ${line}.`);
    }
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.partial`;
  await writeFile(partial, `${JSON.stringify(value, undefined, 2)}\n`, 'utf8');
  await rename(partial, path);
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

async function requiredJson<T>(path: string, label: string): Promise<T> {
  const value = await readJson<T>(path);
  if (!value) {
    throw new Error(`${label} is unavailable at ${path}.`);
  }
  return value;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function normalizeOptions(request: RecommendationDecisionDatasetV5StartRequest): Options {
  return {
    expectedSourceSha256: sha(request.expectedSourceSha256, 'expectedSourceSha256'),
    partitionCount: bounded(request.partitionCount, 64, 2, 256, 'partitionCount'),
    snapshotStalenessS: bounded(
      request.snapshotStalenessS,
      120,
      0,
      3_600,
      'snapshotStalenessS',
    ),
    catalogSnapshotPath: request.catalogSnapshotPath?.trim() || undefined,
    expectedCatalogSha256: sha(
      request.expectedCatalogSha256,
      'expectedCatalogSha256',
    ),
    resume: request.resume !== false,
  };
}

function bounded(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function sha(value: string | undefined, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`${name} must be a SHA-256 digest.`);
  }
  return normalized;
}

function requiredSha(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error('Source artifact SHA-256 is unavailable.');
  }
  return value.toLowerCase();
}

function requiredText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Required text value is unavailable.');
  }
  return value;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function nonNegative(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined;
}

function numeric(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
