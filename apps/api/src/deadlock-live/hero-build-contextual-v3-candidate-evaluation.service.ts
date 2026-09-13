import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Repository } from 'typeorm';
import { ItemComponent } from './entities/item-component.entity';
import { Item } from './entities/item.entity';

const SCHEMA_VERSION = 1;
const DEFAULT_TRAINING_DIR = '/app/apps/api/storage/contextual-v3-training';
const DEFAULT_OUTPUT_DIR = '/app/apps/api/storage/contextual-v3-candidate-evaluation-v2';
const BUFFER_LIMIT = 1024 * 1024;
const CANDIDATE_POLICY = 'TRAIN_OBSERVED_GLOBAL_BACKOFF_LEGAL_SHORTLIST';
const TOTAL_CACHE = new WeakMap<object, number>();

export interface ContextualV3CandidateEvaluationStartRequest {
  candidateLimit?: number;
}

interface CandidateEvaluationOptions {
  candidateLimit: number;
}

export interface ContextualV3CandidateEvaluationStatus {
  state: 'IDLE' | 'RUNNING' | 'COMPLETE' | 'FAILED';
  phase: 'PREPARING' | 'EVALUATING' | 'FINALIZING' | 'COMPLETE';
  validationRowCount: number;
  processedRowCount: number;
  candidateCoveredDecisionCount: number;
  outputDirectory: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  options?: CandidateEvaluationOptions;
  evaluationAvailable: boolean;
  auditAvailable: boolean;
  manifestAvailable: boolean;
}

interface ArtifactDescriptor {
  fileName: string;
  byteLength: number;
  sha256: string;
  rowCount?: number;
}

interface TrainingManifest {
  schemaVersion: number;
  pipelineVersion: string;
  generatedAt: string;
  source: Record<string, unknown>;
  split: Record<string, unknown>;
  artifacts: {
    validation: ArtifactDescriptor;
    model: ArtifactDescriptor;
  };
  futureFinalTestNotBeforeMatchStartTime: string;
}

type CountRecord = Record<string, number>;
type CountTable = Record<string, CountRecord>;

interface SerializedModel {
  schemaVersion: number;
  modelVersion: string;
  generatedAt: string;
  options?: {
    smoothing?: number;
  };
  weights?: {
    heroPhaseBase?: number;
    archetypeDelta?: number;
    alliedRosterDeltaAverage?: number;
    enemyRosterDeltaAverage?: number;
  };
  counts: {
    hero: CountTable;
    heroPhase: CountTable;
    heroPhaseArchetype: CountTable;
    ally: CountTable;
    enemy: CountTable;
  };
}

interface PreparedValidationRow {
  schemaVersion: number;
  decisionId: string;
  matchId: number;
  matchStartTime: string;
  playerId: number;
  features: {
    heroId: number;
    team: number;
    gameTimeS: number;
    phase: string;
    inventoryBeforeStateKey: string;
    previousActionKeys: string[];
    buildPrefixKey: string;
    alliedHeroIds: number[];
    enemyHeroIds: number[];
    buildArchetypeId: string;
  };
  target: {
    actionType: 'BUY' | 'REBUY' | 'UPGRADE';
    itemId: number;
    actionKey: string;
  };
  outcomeLabel: {
    playerWon: boolean;
  };
}

export interface ContextualV3CandidateCatalog {
  itemIds: ReadonlySet<number>;
  componentsByParent: ReadonlyMap<number, ReadonlySet<number>>;
}

interface Metrics {
  evaluatedDecisionCount: number;
  top1Count: number;
  top3Count: number;
  reciprocalRankSum: number;
}

interface CandidateCoverageDiagnostics {
  unseenInTrainCount: number;
  illegalByCatalogCount: number;
  truncatedByLimitCount: number;
  unexplainedCount: number;
}

interface CandidateSelection {
  actions: string[];
  actualActionObservedInTrain: boolean;
  actualActionLegal: boolean;
  actualActionRankBeforeLimit: number;
}

@Injectable()
export class HeroBuildContextualV3CandidateEvaluationService implements OnModuleInit {
  private readonly logger = new Logger(HeroBuildContextualV3CandidateEvaluationService.name);
  private readonly trainingDir =
    process.env.DEADLOCK_CONTEXTUAL_V3_TRAINING_DIR?.trim() || DEFAULT_TRAINING_DIR;
  private readonly outputDir =
    process.env.DEADLOCK_CONTEXTUAL_V3_CANDIDATE_EVALUATION_DIR?.trim() ||
    DEFAULT_OUTPUT_DIR;
  private readonly trainingManifestPath = join(this.trainingDir, 'manifest.json');
  private readonly paths = {
    candidates: join(this.outputDir, 'candidate-sets.ndjson'),
    evaluation: join(this.outputDir, 'evaluation.json'),
    audit: join(this.outputDir, 'audit.json'),
    manifest: join(this.outputDir, 'manifest.json'),
  };

  private status = this.idleStatus();
  private evaluation?: Record<string, unknown>;
  private audit?: Record<string, unknown>;
  private manifest?: Record<string, unknown>;

  constructor(
    @InjectRepository(Item)
    private readonly itemRepository: Repository<Item>,
    @InjectRepository(ItemComponent)
    private readonly itemComponentRepository: Repository<ItemComponent>,
  ) {}

  async onModuleInit(): Promise<void> {
    await mkdir(this.outputDir, { recursive: true });
    this.evaluation = await readJson(this.paths.evaluation);
    this.audit = await readJson(this.paths.audit);
    this.manifest = await readJson(this.paths.manifest);
    if (this.evaluation && this.audit && this.manifest) {
      const source = asRecord(this.audit.source);
      const candidates = asRecord(this.audit.candidates);
      this.status = {
        ...this.idleStatus(),
        state: 'COMPLETE',
        phase: 'COMPLETE',
        validationRowCount: toNumber(source.validationRowCount),
        processedRowCount: toNumber(source.observedValidationRowCount),
        candidateCoveredDecisionCount: toNumber(candidates.coveredDecisionCount),
        completedAt: String(this.manifest.generatedAt ?? ''),
        evaluationAvailable: true,
        auditAvailable: true,
        manifestAvailable: true,
      };
    }
  }

  getStatus(): ContextualV3CandidateEvaluationStatus {
    return clone(this.status);
  }

  getEvaluation(): Record<string, unknown> | undefined {
    return this.evaluation ? clone(this.evaluation) : undefined;
  }

  getAudit(): Record<string, unknown> | undefined {
    return this.audit ? clone(this.audit) : undefined;
  }

  getManifest(): Record<string, unknown> | undefined {
    return this.manifest ? clone(this.manifest) : undefined;
  }

  async start(
    request: ContextualV3CandidateEvaluationStartRequest = {},
  ): Promise<ContextualV3CandidateEvaluationStatus> {
    if (this.status.state === 'RUNNING') {
      throw new Error('Contextual V3 candidate evaluation is already running.');
    }
    const options = normalizeOptions(request);
    this.status = {
      ...this.idleStatus(),
      state: 'RUNNING',
      startedAt: new Date().toISOString(),
      options,
      evaluationAvailable: this.evaluation !== undefined,
      auditAvailable: this.audit !== undefined,
      manifestAvailable: this.manifest !== undefined,
    };
    void this.run(options);
    return this.getStatus();
  }

  private async run(options: CandidateEvaluationOptions): Promise<void> {
    try {
      const trainingManifest = await requiredJson<TrainingManifest>(this.trainingManifestPath);
      const validationArtifact = trainingManifest.artifacts?.validation;
      const modelArtifact = trainingManifest.artifacts?.model;
      validateArtifactDescriptor(validationArtifact, 'validation');
      validateArtifactDescriptor(modelArtifact, 'model');

      const validationPath = join(this.trainingDir, validationArtifact.fileName);
      const modelPath = join(this.trainingDir, modelArtifact.fileName);
      const [validationSha256, modelSha256, model, catalog] = await Promise.all([
        hashFile(validationPath),
        hashFile(modelPath),
        requiredJson<SerializedModel>(modelPath),
        this.loadCatalog(),
      ]);
      if (validationSha256 !== validationArtifact.sha256) {
        throw new Error('Validation artifact SHA-256 does not match the training manifest.');
      }
      if (modelSha256 !== modelArtifact.sha256) {
        throw new Error('Model artifact SHA-256 does not match the training manifest.');
      }
      validateModel(model);

      await mkdir(this.outputDir, { recursive: true });
      await this.clearOutputs();
      this.evaluation = undefined;
      this.audit = undefined;
      this.manifest = undefined;
      this.status = {
        ...this.status,
        phase: 'EVALUATING',
        validationRowCount: toNumber(validationArtifact.rowCount),
        processedRowCount: 0,
        candidateCoveredDecisionCount: 0,
        evaluationAvailable: false,
        auditAvailable: false,
        manifestAvailable: false,
      };

      const globalCounts = aggregateGlobalCounts(model.counts.hero);
      const smoothing = boundedNumber(model.options?.smoothing, 10, 0.01, 10_000);
      const weights = {
        archetypeDelta: boundedNumber(model.weights?.archetypeDelta, 0.5, 0, 10),
        alliedRosterDeltaAverage: boundedNumber(
          model.weights?.alliedRosterDeltaAverage,
          0.08,
          0,
          10,
        ),
        enemyRosterDeltaAverage: boundedNumber(
          model.weights?.enemyRosterDeltaAverage,
          0.12,
          0,
          10,
        ),
      };
      const baseline = emptyMetrics();
      const contextual = emptyMetrics();
      const coverageDiagnostics: CandidateCoverageDiagnostics = {
        unseenInTrainCount: 0,
        illegalByCatalogCount: 0,
        truncatedByLimitCount: 0,
        unexplainedCount: 0,
      };
      const candidateWriter = await LineWriter.create(`${this.paths.candidates}.partial`);
      let processedRows = 0;
      let coveredRows = 0;

      try {
        await eachValidationRow(validationPath, async (row) => {
          processedRows += 1;
          const selection = createCandidateSelection(
            row,
            model,
            globalCounts,
            catalog,
            options.candidateLimit,
          );
          const covered = selection.actions.includes(row.target.actionKey);
          coveredRows += covered ? 1 : 0;
          if (!covered) {
            if (!selection.actualActionObservedInTrain) {
              coverageDiagnostics.unseenInTrainCount += 1;
            } else if (!selection.actualActionLegal) {
              coverageDiagnostics.illegalByCatalogCount += 1;
            } else if (selection.actualActionRankBeforeLimit >= options.candidateLimit) {
              coverageDiagnostics.truncatedByLimitCount += 1;
            } else {
              coverageDiagnostics.unexplainedCount += 1;
            }
          }

          await candidateWriter.write({
            schemaVersion: SCHEMA_VERSION,
            decisionId: row.decisionId,
            candidateActionKeys: selection.actions,
            actualActionKey: row.target.actionKey,
            actualActionCovered: covered,
            actualActionObservedInTrain: selection.actualActionObservedInTrain,
            actualActionLegal: selection.actualActionLegal,
            actualActionRankBeforeLimit: selection.actualActionRankBeforeLimit,
          });

          updateMetrics(
            baseline,
            rankBaseline(row, selection.actions, model, smoothing),
            row.target.actionKey,
          );
          updateMetrics(
            contextual,
            rankContextual(row, selection.actions, model, smoothing, weights),
            row.target.actionKey,
          );

          if (processedRows % 1_000 === 0) {
            this.status = {
              ...this.status,
              processedRowCount: processedRows,
              candidateCoveredDecisionCount: coveredRows,
            };
          }
          if (processedRows % 10_000 === 0) {
            await tick();
          }
        });
      } finally {
        await candidateWriter.close();
      }

      if (validationArtifact.rowCount !== undefined && processedRows !== validationArtifact.rowCount) {
        throw new Error('Observed validation row count does not match the training manifest.');
      }
      await promote(this.paths.candidates);
      this.status = {
        ...this.status,
        phase: 'FINALIZING',
        processedRowCount: processedRows,
        candidateCoveredDecisionCount: coveredRows,
      };

      const generatedAt = new Date().toISOString();
      const evaluation = buildEvaluation({
        generatedAt,
        model,
        candidateLimit: options.candidateLimit,
        validationRows: processedRows,
        coveredRows,
        coverageDiagnostics,
        baseline,
        contextual,
        finalTestNotBefore: trainingManifest.futureFinalTestNotBeforeMatchStartTime,
      });
      const uncoveredRows = processedRows - coveredRows;
      const classifiedUncoveredRows = Object.values(coverageDiagnostics).reduce(
        (total, value) => total + value,
        0,
      );
      const audit = {
        schemaVersion: SCHEMA_VERSION,
        generatedAt,
        passed:
          processedRows > 0 &&
          processedRows === toNumber(validationArtifact.rowCount) &&
          uncoveredRows === classifiedUncoveredRows &&
          coverageDiagnostics.unexplainedCount === 0,
        source: {
          trainingManifestPath: this.trainingManifestPath,
          trainingPipelineVersion: trainingManifest.pipelineVersion,
          trainingGeneratedAt: trainingManifest.generatedAt,
          validationFileName: validationArtifact.fileName,
          validationExpectedSha256: validationArtifact.sha256,
          validationActualSha256: validationSha256,
          validationRowCount: validationArtifact.rowCount,
          observedValidationRowCount: processedRows,
          modelFileName: modelArtifact.fileName,
          modelExpectedSha256: modelArtifact.sha256,
          modelActualSha256: modelSha256,
          modelVersion: model.modelVersion,
        },
        candidates: {
          policy: CANDIDATE_POLICY,
          candidateLimit: options.candidateLimit,
          coveredDecisionCount: coveredRows,
          coverageRate: divide(coveredRows, processedRows),
          uncoveredDecisionCount: uncoveredRows,
          diagnostics: { ...coverageDiagnostics },
        },
        leakage: {
          candidateInputs: [
            'features.heroId',
            'features.phase',
            'features.inventoryBeforeStateKey',
            'train.counts.heroPhase',
            'train.counts.hero',
            'train.globalActionCounts',
            'itemCatalog',
            'itemRecipes',
          ],
          targetUsedForCandidateConstruction: false,
          targetUsedForCoverageDiagnosticsOnly: true,
        },
        warnings: buildWarnings(evaluation, coverageDiagnostics),
      };

      await Promise.all([
        atomicJson(this.paths.evaluation, evaluation),
        atomicJson(this.paths.audit, audit),
      ]);
      const candidateInfo = await stat(this.paths.candidates);
      const manifest = {
        schemaVersion: SCHEMA_VERSION,
        evaluationVersion: 'CONTEXTUAL_V3_CANDIDATE_EVALUATION_2',
        generatedAt,
        source: {
          trainingManifestSha256: await hashFile(this.trainingManifestPath),
          validationSha256,
          validationRowCount: processedRows,
          modelSha256,
          modelVersion: model.modelVersion,
          sourceDataset: clone(trainingManifest.source),
          split: clone(trainingManifest.split),
        },
        candidatePolicy: {
          name: CANDIDATE_POLICY,
          candidateLimit: options.candidateLimit,
          ordering: ['HERO_PHASE_COUNT', 'HERO_COUNT', 'GLOBAL_TRAIN_COUNT', 'ACTION_KEY'],
          legality: {
            buyAndRebuyMustNotBeHeld: true,
            upgradeRequiresEveryDirectComponent: true,
            sellExcluded: true,
          },
        },
        artifacts: {
          candidates: {
            fileName: this.paths.candidates.split('/').pop(),
            byteLength: candidateInfo.size,
            sha256: await hashFile(this.paths.candidates),
            rowCount: processedRows,
          },
          evaluation: await describeArtifact(this.paths.evaluation),
          audit: await describeArtifact(this.paths.audit),
        },
        evaluationReleaseGatePassed: Boolean(asRecord(evaluation.releaseGate).passed),
        futureFinalTestNotBeforeMatchStartTime:
          trainingManifest.futureFinalTestNotBeforeMatchStartTime,
      };
      await atomicJson(this.paths.manifest, manifest);

      this.evaluation = evaluation;
      this.audit = audit;
      this.manifest = manifest;
      this.status = {
        ...this.status,
        state: 'COMPLETE',
        phase: 'COMPLETE',
        completedAt: generatedAt,
        evaluationAvailable: true,
        auditAvailable: true,
        manifestAvailable: true,
        error: undefined,
      };
      this.logger.log(
        `Contextual V3 candidate evaluation completed with ${coveredRows}/${processedRows} covered decisions.`,
      );
    } catch (error) {
      const message = getErrorMessage(error);
      this.status = {
        ...this.status,
        state: 'FAILED',
        completedAt: new Date().toISOString(),
        error: message,
      };
      this.logger.error(`Contextual V3 candidate evaluation failed: ${message}`);
    }
  }

  private async loadCatalog(): Promise<ContextualV3CandidateCatalog> {
    const [items, components] = await Promise.all([
      this.itemRepository.find(),
      this.itemComponentRepository.find({
        order: { parentItemId: 'ASC', componentOrder: 'ASC' },
      }),
    ]);
    const itemIds = new Set(
      items
        .filter((item) => Number(item.cost) > 0)
        .map((item) => Number(item.itemId))
        .filter((itemId) => Number.isSafeInteger(itemId) && itemId > 0),
    );
    const componentsByParent = new Map<number, Set<number>>();
    for (const component of components) {
      const parentItemId = Number(component.parentItemId);
      const componentItemId = Number(component.componentItemId);
      if (!itemIds.has(parentItemId) || !itemIds.has(componentItemId)) {
        continue;
      }
      const values = componentsByParent.get(parentItemId) ?? new Set<number>();
      values.add(componentItemId);
      componentsByParent.set(parentItemId, values);
    }
    return { itemIds, componentsByParent };
  }

  private async clearOutputs(): Promise<void> {
    await Promise.all(
      Object.values(this.paths).flatMap((path) => [
        rm(path, { force: true }),
        rm(`${path}.partial`, { force: true }),
      ]),
    );
  }

  private idleStatus(): ContextualV3CandidateEvaluationStatus {
    return {
      state: 'IDLE',
      phase: 'PREPARING',
      validationRowCount: 0,
      processedRowCount: 0,
      candidateCoveredDecisionCount: 0,
      outputDirectory: this.outputDir,
      evaluationAvailable: false,
      auditAvailable: false,
      manifestAvailable: false,
    };
  }
}

export function orderContextualV3CandidateActions(
  phaseCounts: Readonly<Record<string, number>> | undefined,
  heroCounts: Readonly<Record<string, number>> | undefined,
  globalCounts: Readonly<Record<string, number>>,
  inventory: ReadonlySet<number>,
  catalog: ContextualV3CandidateCatalog,
): string[] {
  const actionKeys = new Set<string>([
    ...Object.keys(globalCounts),
    ...Object.keys(heroCounts ?? {}),
    ...Object.keys(phaseCounts ?? {}),
  ]);
  return [...actionKeys]
    .filter((actionKey) =>
      isContextualV3CandidateActionLegal(actionKey, inventory, catalog),
    )
    .sort(
      (left, right) =>
        (phaseCounts?.[right] ?? 0) - (phaseCounts?.[left] ?? 0) ||
        (heroCounts?.[right] ?? 0) - (heroCounts?.[left] ?? 0) ||
        (globalCounts[right] ?? 0) - (globalCounts[left] ?? 0) ||
        left.localeCompare(right),
    );
}

export function isContextualV3CandidateActionLegal(
  actionKey: string,
  inventory: ReadonlySet<number>,
  catalog: ContextualV3CandidateCatalog,
): boolean {
  const action = parseAction(actionKey);
  if (!action || !catalog.itemIds.has(action.itemId)) {
    return false;
  }
  if (action.actionType === 'UPGRADE') {
    const components = catalog.componentsByParent.get(action.itemId);
    return Boolean(
      components &&
        components.size > 0 &&
        [...components].every((componentItemId) => inventory.has(componentItemId)),
    );
  }
  return (
    (action.actionType === 'BUY' || action.actionType === 'REBUY') &&
    !inventory.has(action.itemId)
  );
}

export function buildContextualV3CandidateReleaseGate(
  coverageRate: number,
  top1Delta: number,
  top3Delta: number,
): { passed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (coverageRate < 0.98) {
    reasons.push('Candidate coverage is below 98%.');
  }
  if (top1Delta < 0.001) {
    reasons.push('Contextual Top-1 improvement is below 0.10 percentage points.');
  }
  if (top3Delta < -0.0005) {
    reasons.push('Contextual Top-3 regression exceeds 0.05 percentage points.');
  }
  return { passed: reasons.length === 0, reasons };
}

function createCandidateSelection(
  row: PreparedValidationRow,
  model: SerializedModel,
  globalCounts: CountRecord,
  catalog: ContextualV3CandidateCatalog,
  limit: number,
): CandidateSelection {
  const phaseKey = `${row.features.heroId}|${row.features.phase}`;
  const inventory = parseInventoryItemIds(row.features.inventoryBeforeStateKey);
  const ordered = orderContextualV3CandidateActions(
    model.counts.heroPhase[phaseKey],
    model.counts.hero[String(row.features.heroId)],
    globalCounts,
    inventory,
    catalog,
  );
  return {
    actions: ordered.slice(0, limit),
    actualActionObservedInTrain: globalCounts[row.target.actionKey] !== undefined,
    actualActionLegal: isContextualV3CandidateActionLegal(
      row.target.actionKey,
      inventory,
      catalog,
    ),
    actualActionRankBeforeLimit: ordered.indexOf(row.target.actionKey),
  };
}

function rankBaseline(
  row: PreparedValidationRow,
  candidates: readonly string[],
  model: SerializedModel,
  smoothing: number,
): string[] {
  const counts = model.counts.heroPhase[`${row.features.heroId}|${row.features.phase}`];
  return rank(candidates, (action) =>
    logProbability(counts, action, candidates.length, smoothing),
  );
}

function rankContextual(
  row: PreparedValidationRow,
  candidates: readonly string[],
  model: SerializedModel,
  smoothing: number,
  weights: {
    archetypeDelta: number;
    alliedRosterDeltaAverage: number;
    enemyRosterDeltaAverage: number;
  },
): string[] {
  const features = row.features;
  const baseKey = `${features.heroId}|${features.phase}`;
  return rank(candidates, (action) => {
    const base = logProbability(
      model.counts.heroPhase[baseKey],
      action,
      candidates.length,
      smoothing,
    );
    const archetype = logProbability(
      model.counts.heroPhaseArchetype[`${baseKey}|${features.buildArchetypeId}`],
      action,
      candidates.length,
      smoothing,
    );
    const allies = features.alliedHeroIds.map((heroId) =>
      logProbability(
        model.counts.ally[`${baseKey}|${heroId}`],
        action,
        candidates.length,
        smoothing,
      ),
    );
    const enemies = features.enemyHeroIds.map((heroId) =>
      logProbability(
        model.counts.enemy[`${baseKey}|${heroId}`],
        action,
        candidates.length,
        smoothing,
      ),
    );
    return (
      base +
      weights.archetypeDelta * (archetype - base) +
      weights.alliedRosterDeltaAverage * (average(allies) - base) +
      weights.enemyRosterDeltaAverage * (average(enemies) - base)
    );
  });
}

function buildEvaluation(input: {
  generatedAt: string;
  model: SerializedModel;
  candidateLimit: number;
  validationRows: number;
  coveredRows: number;
  coverageDiagnostics: CandidateCoverageDiagnostics;
  baseline: Metrics;
  contextual: Metrics;
  finalTestNotBefore: string;
}): Record<string, unknown> {
  const baseline = finalizeMetrics(input.baseline);
  const contextual = finalizeMetrics(input.contextual);
  const coverageRate = divide(input.coveredRows, input.validationRows);
  const deltas = {
    top1Rate: contextual.top1Rate - baseline.top1Rate,
    top3Rate: contextual.top3Rate - baseline.top3Rate,
    meanReciprocalRank: contextual.meanReciprocalRank - baseline.meanReciprocalRank,
  };
  const releaseGate = buildContextualV3CandidateReleaseGate(
    coverageRate,
    deltas.top1Rate,
    deltas.top3Rate,
  );
  return {
    schemaVersion: SCHEMA_VERSION,
    evaluationVersion: 'CONTEXTUAL_V3_CANDIDATE_EVALUATION_2',
    generatedAt: input.generatedAt,
    split: 'VALIDATION',
    modelVersion: input.model.modelVersion,
    candidateSetPolicy: CANDIDATE_POLICY,
    candidateLimit: input.candidateLimit,
    validationDecisionCount: input.validationRows,
    candidateCoveredDecisionCount: input.coveredRows,
    candidateCoverageRate: coverageRate,
    candidateCoverageDiagnostics: { ...input.coverageDiagnostics },
    baseline,
    contextual,
    deltas,
    releaseGate: {
      minimumCandidateCoverageRate: 0.98,
      minimumTop1Delta: 0.001,
      maximumTop3Regression: 0.0005,
      ...releaseGate,
    },
    finalTest: {
      status: 'NOT_RUN',
      notBeforeMatchStartTime: input.finalTestNotBefore,
      reason: 'Final test matches must be strictly newer than the source dataset window.',
    },
  };
}

function aggregateGlobalCounts(heroTable: CountTable): CountRecord {
  const globalCounts: CountRecord = {};
  for (const counts of Object.values(heroTable)) {
    for (const [actionKey, count] of Object.entries(counts)) {
      globalCounts[actionKey] = (globalCounts[actionKey] ?? 0) + count;
    }
  }
  return globalCounts;
}

function parseInventoryItemIds(stateKey: string): Set<number> {
  if (!stateKey || stateKey === 'EMPTY') {
    return new Set();
  }
  return new Set(
    stateKey
      .split('|')
      .map((value) => Number(value.split('x')[0]))
      .filter((itemId) => Number.isSafeInteger(itemId) && itemId > 0),
  );
}

function parseAction(
  actionKey: string,
): { actionType: 'BUY' | 'REBUY' | 'UPGRADE'; itemId: number } | undefined {
  const [actionType, itemText] = actionKey.split(':');
  const itemId = Number(itemText);
  if (
    !['BUY', 'REBUY', 'UPGRADE'].includes(actionType) ||
    !Number.isSafeInteger(itemId) ||
    itemId <= 0
  ) {
    return undefined;
  }
  return { actionType: actionType as 'BUY' | 'REBUY' | 'UPGRADE', itemId };
}

function rank(candidates: readonly string[], score: (action: string) => number): string[] {
  return [...candidates]
    .map((action) => ({ action, score: score(action) }))
    .sort((left, right) => right.score - left.score || left.action.localeCompare(right.action))
    .map((value) => value.action);
}

function logProbability(
  counts: CountRecord | undefined,
  action: string,
  vocabularySize: number,
  smoothing: number,
): number {
  return Math.log(
    ((counts?.[action] ?? 0) + smoothing) /
      (countTotal(counts) + smoothing * Math.max(1, vocabularySize)),
  );
}

function countTotal(counts: CountRecord | undefined): number {
  if (!counts) {
    return 0;
  }
  const cached = TOTAL_CACHE.get(counts);
  if (cached !== undefined) {
    return cached;
  }
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  TOTAL_CACHE.set(counts, total);
  return total;
}

function emptyMetrics(): Metrics {
  return {
    evaluatedDecisionCount: 0,
    top1Count: 0,
    top3Count: 0,
    reciprocalRankSum: 0,
  };
}

function updateMetrics(metrics: Metrics, ranking: readonly string[], actual: string): void {
  metrics.evaluatedDecisionCount += 1;
  const index = ranking.indexOf(actual);
  metrics.top1Count += index === 0 ? 1 : 0;
  metrics.top3Count += index >= 0 && index < 3 ? 1 : 0;
  metrics.reciprocalRankSum += index >= 0 ? 1 / (index + 1) : 0;
}

function finalizeMetrics(metrics: Metrics): {
  evaluatedDecisionCount: number;
  top1Count: number;
  top3Count: number;
  reciprocalRankSum: number;
  top1Rate: number;
  top3Rate: number;
  meanReciprocalRank: number;
} {
  return {
    ...metrics,
    top1Rate: divide(metrics.top1Count, metrics.evaluatedDecisionCount),
    top3Rate: divide(metrics.top3Count, metrics.evaluatedDecisionCount),
    meanReciprocalRank: divide(metrics.reciprocalRankSum, metrics.evaluatedDecisionCount),
  };
}

async function eachValidationRow(
  path: string,
  consumer: (row: PreparedValidationRow) => Promise<void>,
): Promise<void> {
  const input = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (!line) {
        continue;
      }
      let row: PreparedValidationRow;
      try {
        row = JSON.parse(line) as PreparedValidationRow;
      } catch (error) {
        throw new Error(`Invalid validation NDJSON at line ${lineNumber}: ${String(error)}`);
      }
      if (
        typeof row.decisionId !== 'string' ||
        !Number.isSafeInteger(row.features?.heroId) ||
        typeof row.features?.phase !== 'string' ||
        typeof row.features?.inventoryBeforeStateKey !== 'string' ||
        !Array.isArray(row.features?.alliedHeroIds) ||
        !Array.isArray(row.features?.enemyHeroIds) ||
        typeof row.features?.buildArchetypeId !== 'string' ||
        typeof row.target?.actionKey !== 'string'
      ) {
        throw new Error(`Invalid validation row at line ${lineNumber}.`);
      }
      await consumer(row);
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

function validateArtifactDescriptor(
  artifact: ArtifactDescriptor | undefined,
  name: string,
): asserts artifact is ArtifactDescriptor {
  if (
    !artifact ||
    typeof artifact.fileName !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(artifact.sha256)
  ) {
    throw new Error(`Training manifest has no valid ${name} artifact descriptor.`);
  }
}

function validateModel(model: SerializedModel): void {
  if (
    !model ||
    typeof model.modelVersion !== 'string' ||
    !model.counts ||
    !model.counts.hero ||
    !model.counts.heroPhase ||
    !model.counts.heroPhaseArchetype ||
    !model.counts.ally ||
    !model.counts.enemy
  ) {
    throw new Error('Model artifact has an invalid structure.');
  }
}

function normalizeOptions(
  request: ContextualV3CandidateEvaluationStartRequest,
): CandidateEvaluationOptions {
  return {
    candidateLimit: boundedInteger(request.candidateLimit, 128, 5, 256, 'candidateLimit'),
  };
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  fieldName: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(
      `${fieldName} must be a safe integer from ${minimum} to ${maximum}.`,
    );
  }
  return resolved;
}

function boundedNumber(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  return Number.isFinite(resolved) && resolved >= minimum && resolved <= maximum
    ? resolved
    : fallback;
}

function buildWarnings(
  evaluation: Record<string, unknown>,
  diagnostics: CandidateCoverageDiagnostics,
): string[] {
  const warnings: string[] = [];
  if (!asRecord(evaluation.releaseGate).passed) {
    warnings.push('The candidate validation release gate failed; the model must not be deployed.');
  }
  if (diagnostics.unseenInTrainCount > 0) {
    warnings.push(
      `${diagnostics.unseenInTrainCount} validation actions were never observed in the train split.`,
    );
  }
  if (diagnostics.illegalByCatalogCount > 0) {
    warnings.push(
      `${diagnostics.illegalByCatalogCount} observed actions were rejected by catalog legality checks.`,
    );
  }
  if (diagnostics.truncatedByLimitCount > 0) {
    warnings.push(
      `${diagnostics.truncatedByLimitCount} legal observed actions were truncated by the candidate limit.`,
    );
  }
  return warnings;
}

async function describeArtifact(path: string): Promise<Record<string, unknown>> {
  const info = await stat(path);
  return {
    fileName: path.split('/').pop(),
    byteLength: info.size,
    sha256: await hashFile(path),
  };
}

class LineWriter {
  private buffer = '';

  private constructor(private readonly handle: FileHandle) {}

  static async create(path: string): Promise<LineWriter> {
    return new LineWriter(await open(path, 'w'));
  }

  async write(value: unknown): Promise<void> {
    this.buffer += `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(this.buffer) >= BUFFER_LIMIT) {
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

async function promote(path: string): Promise<void> {
  await rm(path, { force: true });
  await rename(`${path}.partial`, path);
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await writeFile(`${path}.partial`, `${JSON.stringify(value, undefined, 2)}\n`, 'utf8');
  await rm(path, { force: true });
  await rename(`${path}.partial`, path);
}

async function readJson<T = Record<string, unknown>>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if (getCode(error) === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function requiredJson<T>(path: string): Promise<T> {
  const value = await readJson<T>(path);
  if (!value) {
    throw new Error(`Required artifact is missing: ${path}`);
  }
  return value;
}

function average(values: readonly number[]): number {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function divide(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function toNumber(value: unknown): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function getCode(error: unknown): string | undefined {
  return error &&
    typeof error === 'object' &&
    typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
