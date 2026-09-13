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
import type {
  HeroBuildDecisionActionType,
  HeroBuildDecisionDatasetV3Audit,
  HeroBuildDecisionDatasetV3Manifest,
  HeroBuildDecisionDatasetV3Row,
} from './hero-build-decision-dataset-v3.service';

export const CONTEXTUAL_V3_EXPECTED_SOURCE_SHA256 =
  'be4522139021cc5d7c449b0845cba8fbbd7fe781cd2eff5e30099924782770f7';

const SCHEMA_VERSION = 1;
const DEFAULT_SOURCE_DIR = '/app/apps/api/storage/build-decision-dataset-v3';
const DEFAULT_OUTPUT_DIR = '/app/apps/api/storage/contextual-v3-training';
const BUFFER_LIMIT = 1024 * 1024;
const SIGNATURE_ACTION_COUNT = 4;
const TOTAL_CACHE = new WeakMap<object, number>();

export interface ContextualV3TrainingStartRequest {
  trainFraction?: number;
  maxArchetypesPerHero?: number;
  minArchetypePlayers?: number;
  candidateLimit?: number;
  smoothing?: number;
  expectedSourceSha256?: string;
}

interface TrainingOptions {
  trainFraction: number;
  maxArchetypesPerHero: number;
  minArchetypePlayers: number;
  candidateLimit: number;
  smoothing: number;
  expectedSourceSha256: string;
}

export interface ContextualV3TrainingStatus {
  state: 'IDLE' | 'RUNNING' | 'COMPLETE' | 'FAILED';
  phase:
    | 'PREPARING'
    | 'SPLITTING'
    | 'FITTING_ARCHETYPES'
    | 'TRAINING'
    | 'EVALUATING'
    | 'FINALIZING'
    | 'COMPLETE';
  currentPass: number;
  totalPasses: number;
  sourceRowCount: number;
  processedRowCount: number;
  trainRowCount: number;
  validationRowCount: number;
  sourceMatchCount: number;
  trainMatchCount: number;
  validationMatchCount: number;
  outputDirectory: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  options?: TrainingOptions;
  manifestAvailable: boolean;
  auditAvailable: boolean;
  evaluationAvailable: boolean;
  modelAvailable: boolean;
}

interface MatchDescriptor {
  matchId: number;
  startTime: string;
}

export interface ChronologicalSplit {
  train: MatchDescriptor[];
  validation: MatchDescriptor[];
}

export interface ContextualV3ArchetypeDefinition {
  id: string;
  heroId: number;
  rank: number;
  signature: string;
  actionKeys: string[];
  playerCount: number;
}

interface PreparedRow {
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
    actionType: HeroBuildDecisionActionType;
    itemId: number;
    actionKey: string;
  };
  outcomeLabel: { playerWon: boolean };
}

type CountMap = Map<string, number>;
type CountTable = Map<string, CountMap>;

interface Model {
  hero: CountTable;
  heroPhase: CountTable;
  heroPhaseArchetype: CountTable;
  ally: CountTable;
  enemy: CountTable;
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

@Injectable()
export class HeroBuildContextualV3TrainingService implements OnModuleInit {
  private readonly logger = new Logger(HeroBuildContextualV3TrainingService.name);
  private readonly sourceDir =
    process.env.DEADLOCK_CONTEXTUAL_V3_SOURCE_DIR?.trim() || DEFAULT_SOURCE_DIR;
  private readonly outputDir =
    process.env.DEADLOCK_CONTEXTUAL_V3_TRAINING_DIR?.trim() || DEFAULT_OUTPUT_DIR;
  private readonly defaultExpectedSha =
    process.env.DEADLOCK_CONTEXTUAL_V3_EXPECTED_SOURCE_SHA256?.trim() ||
    CONTEXTUAL_V3_EXPECTED_SOURCE_SHA256;
  private readonly sourceDataset = join(this.sourceDir, 'dataset.ndjson');
  private readonly sourceManifest = join(this.sourceDir, 'manifest.json');
  private readonly sourceAudit = join(this.sourceDir, 'audit.json');
  private readonly paths = {
    train: join(this.outputDir, 'train.ndjson'),
    validation: join(this.outputDir, 'validation.ndjson'),
    candidates: join(this.outputDir, 'candidate-sets.ndjson'),
    archetypes: join(this.outputDir, 'archetypes.json'),
    model: join(this.outputDir, 'model.json'),
    evaluation: join(this.outputDir, 'evaluation.json'),
    audit: join(this.outputDir, 'audit.json'),
    manifest: join(this.outputDir, 'manifest.json'),
  };

  private status = this.idleStatus();
  private manifest?: Record<string, unknown>;
  private audit?: Record<string, unknown>;
  private evaluation?: Record<string, unknown>;
  private archetypes?: Record<string, unknown>;

  constructor(
    @InjectRepository(Item)
    private readonly itemRepository: Repository<Item>,
    @InjectRepository(ItemComponent)
    private readonly itemComponentRepository: Repository<ItemComponent>,
  ) {}

  async onModuleInit(): Promise<void> {
    await mkdir(this.outputDir, { recursive: true });
    this.manifest = await readJson(this.paths.manifest);
    this.audit = await readJson(this.paths.audit);
    this.evaluation = await readJson(this.paths.evaluation);
    this.archetypes = await readJson(this.paths.archetypes);
    if (this.manifest && this.audit && this.evaluation) {
      const split = asRecord(this.audit.split);
      const source = asRecord(this.audit.source);
      this.status = {
        ...this.idleStatus(),
        state: 'COMPLETE',
        phase: 'COMPLETE',
        sourceRowCount: toNumber(source.sourceRowCount),
        processedRowCount: toNumber(source.observedRowCount),
        sourceMatchCount: toNumber(source.sourceMatchCount),
        trainRowCount: toNumber(split.trainRowCount),
        validationRowCount: toNumber(split.validationRowCount),
        trainMatchCount: toNumber(split.trainMatchCount),
        validationMatchCount: toNumber(split.validationMatchCount),
        completedAt: String(this.manifest.generatedAt ?? ''),
        manifestAvailable: true,
        auditAvailable: true,
        evaluationAvailable: true,
        modelAvailable: true,
      };
    }
  }

  getStatus(): ContextualV3TrainingStatus {
    return clone(this.status);
  }

  getManifest(): Record<string, unknown> | undefined {
    return this.manifest ? clone(this.manifest) : undefined;
  }

  getAudit(): Record<string, unknown> | undefined {
    return this.audit ? clone(this.audit) : undefined;
  }

  getEvaluation(): Record<string, unknown> | undefined {
    return this.evaluation ? clone(this.evaluation) : undefined;
  }

  getArchetypes(): Record<string, unknown> | undefined {
    return this.archetypes ? clone(this.archetypes) : undefined;
  }

  async start(
    request: ContextualV3TrainingStartRequest = {},
  ): Promise<ContextualV3TrainingStatus> {
    if (this.status.state === 'RUNNING') {
      throw new Error('Contextual V3 training pipeline is already running.');
    }
    const options = normalizeOptions(request, this.defaultExpectedSha);
    this.status = {
      ...this.idleStatus(),
      state: 'RUNNING',
      startedAt: new Date().toISOString(),
      options,
      manifestAvailable: this.manifest !== undefined,
      auditAvailable: this.audit !== undefined,
      evaluationAvailable: this.evaluation !== undefined,
      modelAvailable: this.manifest !== undefined,
    };
    void this.run(options);
    return this.getStatus();
  }

  private async run(options: TrainingOptions): Promise<void> {
    try {
      const sourceManifest = await requiredJson<HeroBuildDecisionDatasetV3Manifest>(
        this.sourceManifest,
      );
      const sourceAudit = await requiredJson<HeroBuildDecisionDatasetV3Audit>(
        this.sourceAudit,
      );
      if (!sourceManifest.auditPassed || !sourceAudit.passed) {
        throw new Error('The source decision dataset did not pass its audit.');
      }
      const actualSha = await hashFile(this.sourceDataset);
      if (actualSha !== options.expectedSourceSha256) {
        throw new Error(
          `Source SHA-256 mismatch: expected ${options.expectedSourceSha256}, received ${actualSha}.`,
        );
      }
      if (sourceManifest.artifact.sha256 !== actualSha) {
        throw new Error('Source manifest SHA-256 does not match dataset.ndjson.');
      }

      await mkdir(this.outputDir, { recursive: true });
      await this.clearOutputs();
      this.manifest = undefined;
      this.audit = undefined;
      this.evaluation = undefined;
      this.archetypes = undefined;
      this.status = {
        ...this.status,
        manifestAvailable: false,
        auditAvailable: false,
        evaluationAvailable: false,
        modelAvailable: false,
      };

      this.status = {
        ...this.status,
        phase: 'SPLITTING',
        currentPass: 1,
        sourceRowCount: sourceManifest.artifact.rowCount,
        sourceMatchCount: sourceManifest.source.selectedMatchCount,
      };
      const matches = new Map<number, MatchDescriptor>();
      let observedRows = 0;
      await eachRow(this.sourceDataset, async (row) => {
        observedRows += 1;
        const existing = matches.get(row.matchId);
        if (existing && existing.startTime !== row.matchStartTime) {
          throw new Error(`Conflicting start time for match ${row.matchId}.`);
        }
        matches.set(row.matchId, {
          matchId: row.matchId,
          startTime: row.matchStartTime,
        });
        if (observedRows % 10_000 === 0) {
          this.status = { ...this.status, processedRowCount: observedRows };
          await tick();
        }
      });
      if (observedRows !== sourceManifest.artifact.rowCount) {
        throw new Error('Source row count does not match the manifest.');
      }
      const split = selectChronologicalSplit([...matches.values()], options.trainFraction);
      const trainIds = new Set(split.train.map((value) => value.matchId));
      const validationIds = new Set(split.validation.map((value) => value.matchId));
      this.status = {
        ...this.status,
        processedRowCount: observedRows,
        trainMatchCount: trainIds.size,
        validationMatchCount: validationIds.size,
      };

      this.status = {
        ...this.status,
        phase: 'FITTING_ARCHETYPES',
        currentPass: 2,
        processedRowCount: 0,
      };
      const signatureCounts = await collectSignatures(
        this.sourceDataset,
        trainIds,
        (count) => {
          this.status = { ...this.status, processedRowCount: count };
        },
      );
      const archetypes = buildArchetypes(signatureCounts, options);
      await atomicJson(this.paths.archetypes, archetypes);

      this.status = {
        ...this.status,
        phase: 'TRAINING',
        currentPass: 3,
        processedRowCount: 0,
      };
      const catalog = await this.loadCatalog();
      const model = createModel();
      const trainWriter = await LineWriter.create(`${this.paths.train}.partial`);
      const validationWriter = await LineWriter.create(`${this.paths.validation}.partial`);
      const candidateWriter = await LineWriter.create(`${this.paths.candidates}.partial`);
      const baseline = emptyMetrics();
      const contextual = emptyMetrics();
      let trainRows = 0;
      let validationRows = 0;
      let coveredRows = 0;
      let passRows = 0;

      try {
        await eachRow(this.sourceDataset, async (row) => {
          passRows += 1;
          const archetypeId = assignArchetype(
            row.heroId,
            row.previousActionKeys,
            archetypes.definitionsByHero,
          );
          const prepared = prepare(row, archetypeId);
          if (trainIds.has(row.matchId)) {
            trainRows += 1;
            updateModel(model, prepared);
            await trainWriter.write(prepared);
          } else if (validationIds.has(row.matchId)) {
            validationRows += 1;
            this.status = { ...this.status, phase: 'EVALUATING' };
            await validationWriter.write(prepared);
            const candidates = candidateShortlist(
              prepared,
              model,
              catalog,
              options.candidateLimit,
            );
            const covered = candidates.includes(prepared.target.actionKey);
            coveredRows += covered ? 1 : 0;
            await candidateWriter.write({
              schemaVersion: SCHEMA_VERSION,
              decisionId: prepared.decisionId,
              candidateActionKeys: candidates,
              actualActionKey: prepared.target.actionKey,
              actualActionCovered: covered,
            });
            updateMetrics(
              baseline,
              rankBaseline(prepared, candidates, model, options.smoothing),
              prepared.target.actionKey,
            );
            updateMetrics(
              contextual,
              rankContextual(prepared, candidates, model, options.smoothing),
              prepared.target.actionKey,
            );
          } else {
            throw new Error(`Match ${row.matchId} was not assigned to a split.`);
          }
          if (passRows % 1_000 === 0) {
            this.status = {
              ...this.status,
              processedRowCount: passRows,
              trainRowCount: trainRows,
              validationRowCount: validationRows,
            };
          }
          if (passRows % 10_000 === 0) {
            await tick();
          }
        });
      } finally {
        await Promise.all([
          trainWriter.close(),
          validationWriter.close(),
          candidateWriter.close(),
        ]);
      }
      this.status = {
        ...this.status,
        processedRowCount: passRows,
        trainRowCount: trainRows,
        validationRowCount: validationRows,
      };
      await Promise.all([
        promote(this.paths.train),
        promote(this.paths.validation),
        promote(this.paths.candidates),
      ]);

      const generatedAt = new Date().toISOString();
      const evaluation = buildEvaluation(
        baseline,
        contextual,
        validationRows,
        coveredRows,
        options,
        sourceManifest.source.selectedWindowEndTime,
        generatedAt,
      );
      const serializedModel = {
        schemaVersion: SCHEMA_VERSION,
        modelVersion: 'CONTEXTUAL_V3_HIERARCHICAL_COUNT_RANKER_1',
        generatedAt,
        featureCutoff: 'DECISION_TIME',
        candidateSetPolicy: 'TRAIN_OBSERVED_LEGAL_SHORTLIST',
        options,
        weights: {
          heroPhaseBase: 1,
          archetypeDelta: 0.5,
          alliedRosterDeltaAverage: 0.08,
          enemyRosterDeltaAverage: 0.12,
        },
        archetypes,
        counts: serializeModel(model),
      };
      await Promise.all([
        atomicJson(this.paths.model, serializedModel),
        atomicJson(this.paths.evaluation, evaluation),
      ]);

      this.status = { ...this.status, phase: 'FINALIZING' };
      const featureFields = Object.keys(prepare(probeRow(), 'UNKNOWN').features);
      const forbidden = [
        'inventoryAfterStateKey',
        'actualActionType',
        'actualItemId',
        'actualActionKey',
        'outcomeLabel',
        'kills',
        'deaths',
        'assists',
        'netWorth',
      ];
      const forbiddenPresent = featureFields.filter((field) => forbidden.includes(field));
      const overlap = [...trainIds].filter((id) => validationIds.has(id)).length;
      const warnings: string[] = [];
      if (toNumber(evaluation.candidateCoverageRate) < 0.98) {
        warnings.push('Validation candidate coverage is below 98%.');
      }
      const releaseGate = asRecord(evaluation.releaseGate);
      if (!releaseGate.passed) {
        warnings.push('The validation release gate failed; the model must not be deployed.');
      }
      const audit = {
        schemaVersion: SCHEMA_VERSION,
        generatedAt,
        passed:
          observedRows === sourceManifest.artifact.rowCount &&
          trainRows + validationRows === observedRows &&
          overlap === 0 &&
          forbiddenPresent.length === 0,
        source: {
          expectedSha256: options.expectedSourceSha256,
          actualSha256: actualSha,
          sourceAuditPassed: sourceAudit.passed,
          sourceRowCount: sourceManifest.artifact.rowCount,
          observedRowCount: observedRows,
          sourceMatchCount: matches.size,
        },
        split: {
          strategy: 'CHRONOLOGICAL_MATCH_LEVEL',
          trainFraction: options.trainFraction,
          trainMatchCount: trainIds.size,
          validationMatchCount: validationIds.size,
          overlappingMatchCount: overlap,
          trainRowCount: trainRows,
          validationRowCount: validationRows,
        },
        leakage: {
          featureFields,
          forbiddenFieldsPresent: forbiddenPresent,
          targetFields: ['target.actionType', 'target.itemId', 'target.actionKey'],
          outcomeFields: ['outcomeLabel.playerWon'],
        },
        archetypes: {
          fitSplit: 'TRAIN',
          heroCount: Object.keys(archetypes.definitionsByHero).length,
          definitionCount: Object.values(archetypes.definitionsByHero).reduce(
            (sum, values) => sum + values.length,
            0,
          ),
        },
        candidates: {
          policy: 'TRAIN_OBSERVED_LEGAL_SHORTLIST',
          validationDecisionCount: validationRows,
          coveredDecisionCount: coveredRows,
          coverageRate: toNumber(evaluation.candidateCoverageRate),
        },
        warnings,
      };
      const manifest = await buildManifest(
        sourceManifest,
        split,
        options,
        evaluation,
        generatedAt,
        this.paths,
        { trainRows, validationRows },
      );
      await Promise.all([
        atomicJson(this.paths.audit, audit),
        atomicJson(this.paths.manifest, manifest),
      ]);
      this.audit = audit;
      this.manifest = manifest;
      this.evaluation = evaluation;
      this.archetypes = archetypes;
      this.status = {
        ...this.status,
        state: 'COMPLETE',
        phase: 'COMPLETE',
        completedAt: generatedAt,
        manifestAvailable: true,
        auditAvailable: true,
        evaluationAvailable: true,
        modelAvailable: true,
        error: undefined,
      };
      this.logger.log(
        `Contextual V3 training completed: ${trainRows} train rows, ` +
          `${validationRows} validation rows, release gate ` +
          `${releaseGate.passed ? 'PASS' : 'FAIL'}.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.status = {
        ...this.status,
        state: 'FAILED',
        completedAt: new Date().toISOString(),
        error: message,
      };
      this.logger.error(`Contextual V3 training failed: ${message}`);
    }
  }

  private async loadCatalog(): Promise<ContextualV3CandidateCatalog> {
    const [items, components] = await Promise.all([
      this.itemRepository.find(),
      this.itemComponentRepository.find(),
    ]);
    const itemIds = new Set(
      items
        .filter((item) => Number(item.cost) > 0)
        .map((item) => Number(item.itemId))
        .filter((id) => Number.isSafeInteger(id) && id > 0),
    );
    const componentsByParent = new Map<number, Set<number>>();
    for (const component of components) {
      const parent = Number(component.parentItemId);
      const child = Number(component.componentItemId);
      if (!itemIds.has(parent) || !itemIds.has(child)) {
        continue;
      }
      const values = componentsByParent.get(parent) ?? new Set<number>();
      values.add(child);
      componentsByParent.set(parent, values);
    }
    return { itemIds, componentsByParent };
  }

  private async clearOutputs(): Promise<void> {
    const files = Object.values(this.paths);
    await Promise.all(
      files.flatMap((path) => [
        rm(path, { force: true }),
        rm(`${path}.partial`, { force: true }),
      ]),
    );
  }

  private idleStatus(): ContextualV3TrainingStatus {
    return {
      state: 'IDLE',
      phase: 'PREPARING',
      currentPass: 0,
      totalPasses: 3,
      sourceRowCount: 0,
      processedRowCount: 0,
      trainRowCount: 0,
      validationRowCount: 0,
      sourceMatchCount: 0,
      trainMatchCount: 0,
      validationMatchCount: 0,
      outputDirectory: this.outputDir,
      manifestAvailable: false,
      auditAvailable: false,
      evaluationAvailable: false,
      modelAvailable: false,
    };
  }
}

export function selectChronologicalSplit(
  descriptors: readonly MatchDescriptor[],
  trainFraction: number,
): ChronologicalSplit {
  if (descriptors.length < 2) {
    throw new Error('At least two matches are required for a split.');
  }
  if (!Number.isFinite(trainFraction) || trainFraction <= 0 || trainFraction >= 1) {
    throw new Error('trainFraction must be greater than zero and less than one.');
  }
  const sorted = [...descriptors].sort(
    (a, b) =>
      new Date(a.startTime).getTime() - new Date(b.startTime).getTime() ||
      a.matchId - b.matchId,
  );
  const count = Math.min(
    sorted.length - 1,
    Math.max(1, Math.floor(sorted.length * trainFraction)),
  );
  return { train: sorted.slice(0, count), validation: sorted.slice(count) };
}

export function deriveArchetypeSignature(actionKeys: readonly string[]): string {
  const values = actionKeys.slice(0, SIGNATURE_ACTION_COUNT);
  return values.length > 0 ? values.join('>') : 'EMPTY';
}

export function assignArchetype(
  heroId: number,
  previousActionKeys: readonly string[],
  definitionsByHero: Record<string, ContextualV3ArchetypeDefinition[]>,
): string {
  const definitions = definitionsByHero[String(heroId)] ?? [];
  if (definitions.length === 0 || previousActionKeys.length === 0) {
    return 'UNKNOWN';
  }
  const prefix = previousActionKeys.slice(0, SIGNATURE_ACTION_COUNT).join('>');
  return (
    definitions.find(
      (definition) =>
        definition.signature === prefix ||
        definition.signature.startsWith(`${prefix}>`),
    )?.id ?? 'OTHER'
  );
}

export function parseInventoryItemIds(stateKey: string): Set<number> {
  if (!stateKey || stateKey === 'EMPTY') {
    return new Set();
  }
  return new Set(
    stateKey
      .split('|')
      .map((value) => Number(value.split('x')[0]))
      .filter((id) => Number.isSafeInteger(id) && id > 0),
  );
}

async function collectSignatures(
  path: string,
  trainIds: ReadonlySet<number>,
  progress: (count: number) => void,
): Promise<Map<number, Map<string, number>>> {
  const result = new Map<number, Map<string, number>>();
  let playerKey = '';
  let heroId = 0;
  let actions: string[] = [];
  let rows = 0;
  const flush = (): void => {
    if (!playerKey || actions.length === 0) {
      return;
    }
    const signature = deriveArchetypeSignature(actions);
    const counts = result.get(heroId) ?? new Map<string, number>();
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
    result.set(heroId, counts);
  };
  await eachRow(path, async (row) => {
    rows += 1;
    if (trainIds.has(row.matchId)) {
      const nextKey = `${row.matchId}:${row.playerId}`;
      if (nextKey !== playerKey) {
        flush();
        playerKey = nextKey;
        heroId = row.heroId;
        actions = [];
      }
      if (actions.length < SIGNATURE_ACTION_COUNT) {
        actions.push(row.actualActionKey);
      }
    }
    if (rows % 10_000 === 0) {
      progress(rows);
      await tick();
    }
  });
  flush();
  progress(rows);
  return result;
}

function buildArchetypes(
  source: Map<number, Map<string, number>>,
  options: TrainingOptions,
): {
  schemaVersion: number;
  generatedAt: string;
  fitSplit: 'TRAIN';
  signatureActionCount: number;
  definitionsByHero: Record<string, ContextualV3ArchetypeDefinition[]>;
} {
  const definitionsByHero: Record<string, ContextualV3ArchetypeDefinition[]> = {};
  for (const [heroId, counts] of [...source].sort(([a], [b]) => a - b)) {
    definitionsByHero[String(heroId)] = [...counts]
      .filter(([, count]) => count >= options.minArchetypePlayers)
      .sort(([aKey, aCount], [bKey, bCount]) => bCount - aCount || aKey.localeCompare(bKey))
      .slice(0, options.maxArchetypesPerHero)
      .map(([signature, playerCount], index) => ({
        id: `H${heroId}-A${index + 1}`,
        heroId,
        rank: index + 1,
        signature,
        actionKeys: signature.split('>'),
        playerCount,
      }));
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    fitSplit: 'TRAIN',
    signatureActionCount: SIGNATURE_ACTION_COUNT,
    definitionsByHero,
  };
}

function prepare(row: HeroBuildDecisionDatasetV3Row, archetypeId: string): PreparedRow {
  return {
    schemaVersion: SCHEMA_VERSION,
    decisionId: row.decisionId,
    matchId: row.matchId,
    matchStartTime: row.matchStartTime,
    playerId: row.playerId,
    features: {
      heroId: row.heroId,
      team: row.team,
      gameTimeS: row.gameTimeS,
      phase: row.phase,
      inventoryBeforeStateKey: row.inventoryBeforeStateKey,
      previousActionKeys: [...row.previousActionKeys],
      buildPrefixKey: row.buildPrefixKey,
      alliedHeroIds: [...row.alliedHeroIds],
      enemyHeroIds: [...row.enemyHeroIds],
      buildArchetypeId: archetypeId,
    },
    target: {
      actionType: row.actualActionType,
      itemId: row.actualItemId,
      actionKey: row.actualActionKey,
    },
    outcomeLabel: { playerWon: row.outcomeLabel.playerWon },
  };
}

function createModel(): Model {
  return {
    hero: new Map(),
    heroPhase: new Map(),
    heroPhaseArchetype: new Map(),
    ally: new Map(),
    enemy: new Map(),
  };
}

function updateModel(model: Model, row: PreparedRow): void {
  const f = row.features;
  const action = row.target.actionKey;
  increment(model.hero, String(f.heroId), action);
  increment(model.heroPhase, `${f.heroId}|${f.phase}`, action);
  increment(
    model.heroPhaseArchetype,
    `${f.heroId}|${f.phase}|${f.buildArchetypeId}`,
    action,
  );
  for (const ally of f.alliedHeroIds) {
    increment(model.ally, `${f.heroId}|${f.phase}|${ally}`, action);
  }
  for (const enemy of f.enemyHeroIds) {
    increment(model.enemy, `${f.heroId}|${f.phase}|${enemy}`, action);
  }
}

function candidateShortlist(
  row: PreparedRow,
  model: Model,
  catalog: ContextualV3CandidateCatalog,
  limit: number,
): string[] {
  const phaseKey = `${row.features.heroId}|${row.features.phase}`;
  const counts = mergeCounts(
    model.heroPhase.get(phaseKey),
    model.hero.get(String(row.features.heroId)),
  );
  const inventory = parseInventoryItemIds(row.features.inventoryBeforeStateKey);
  return [...counts]
    .filter(([action]) => isLegalCandidateAction(action, inventory, catalog))
    .sort(([aKey, aCount], [bKey, bCount]) => bCount - aCount || aKey.localeCompare(bKey))
    .slice(0, limit)
    .map(([action]) => action);
}

export function isLegalCandidateAction(
  actionKey: string,
  inventory: ReadonlySet<number>,
  catalog: ContextualV3CandidateCatalog,
): boolean {
  const parsed = parseAction(actionKey);
  if (!parsed || !catalog.itemIds.has(parsed.itemId)) {
    return false;
  }
  if (parsed.actionType === 'UPGRADE') {
    const components = catalog.componentsByParent.get(parsed.itemId);
    return Boolean(
      components &&
        components.size > 0 &&
        [...components].every((id) => inventory.has(id)),
    );
  }
  return (
    (parsed.actionType === 'BUY' || parsed.actionType === 'REBUY') &&
    !inventory.has(parsed.itemId)
  );
}

function rankBaseline(
  row: PreparedRow,
  candidates: readonly string[],
  model: Model,
  smoothing: number,
): string[] {
  const counts = model.heroPhase.get(`${row.features.heroId}|${row.features.phase}`);
  return rank(candidates, (action) => logProbability(counts, action, candidates.length, smoothing));
}

function rankContextual(
  row: PreparedRow,
  candidates: readonly string[],
  model: Model,
  smoothing: number,
): string[] {
  const f = row.features;
  const baseKey = `${f.heroId}|${f.phase}`;
  return rank(candidates, (action) => {
    const base = logProbability(model.heroPhase.get(baseKey), action, candidates.length, smoothing);
    const archetype = logProbability(
      model.heroPhaseArchetype.get(`${baseKey}|${f.buildArchetypeId}`),
      action,
      candidates.length,
      smoothing,
    );
    const allies = f.alliedHeroIds.map((id) =>
      logProbability(model.ally.get(`${baseKey}|${id}`), action, candidates.length, smoothing),
    );
    const enemies = f.enemyHeroIds.map((id) =>
      logProbability(model.enemy.get(`${baseKey}|${id}`), action, candidates.length, smoothing),
    );
    return base + 0.5 * (archetype - base) + 0.08 * (average(allies) - base) +
      0.12 * (average(enemies) - base);
  });
}

function rank(candidates: readonly string[], score: (action: string) => number): string[] {
  return [...candidates]
    .map((action) => ({ action, score: score(action) }))
    .sort((a, b) => b.score - a.score || a.action.localeCompare(b.action))
    .map((value) => value.action);
}

function updateMetrics(metrics: Metrics, ranking: readonly string[], actual: string): void {
  metrics.evaluatedDecisionCount += 1;
  const index = ranking.indexOf(actual);
  metrics.top1Count += index === 0 ? 1 : 0;
  metrics.top3Count += index >= 0 && index < 3 ? 1 : 0;
  metrics.reciprocalRankSum += index >= 0 ? 1 / (index + 1) : 0;
}

function buildEvaluation(
  baselineRaw: Metrics,
  contextualRaw: Metrics,
  validationRows: number,
  coveredRows: number,
  options: TrainingOptions,
  finalTestNotBefore: string,
  generatedAt: string,
): Record<string, unknown> {
  const baseline = finalizeMetrics(baselineRaw);
  const contextual = finalizeMetrics(contextualRaw);
  const coverage = divide(coveredRows, validationRows);
  const deltas = {
    top1Rate: contextual.top1Rate - baseline.top1Rate,
    top3Rate: contextual.top3Rate - baseline.top3Rate,
    meanReciprocalRank: contextual.meanReciprocalRank - baseline.meanReciprocalRank,
  };
  const reasons: string[] = [];
  if (coverage < 0.98) reasons.push('Candidate coverage is below 98%.');
  if (deltas.top1Rate < 0.001) {
    reasons.push('Contextual Top-1 improvement is below 0.10 percentage points.');
  }
  if (deltas.top3Rate < -0.0005) {
    reasons.push('Contextual Top-3 regression exceeds 0.05 percentage points.');
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    split: 'VALIDATION',
    candidateSetPolicy: 'TRAIN_OBSERVED_LEGAL_SHORTLIST',
    candidateLimit: options.candidateLimit,
    validationDecisionCount: validationRows,
    candidateCoveredDecisionCount: coveredRows,
    candidateCoverageRate: coverage,
    baseline,
    contextual,
    deltas,
    releaseGate: {
      minimumCandidateCoverageRate: 0.98,
      minimumTop1Delta: 0.001,
      maximumTop3Regression: 0.0005,
      passed: reasons.length === 0,
      reasons,
    },
    finalTest: {
      status: 'NOT_RUN',
      notBeforeMatchStartTime: finalTestNotBefore,
      reason:
        'Final test matches must be strictly newer than the source dataset window.',
    },
  };
}

async function buildManifest(
  source: HeroBuildDecisionDatasetV3Manifest,
  split: ChronologicalSplit,
  options: TrainingOptions,
  evaluation: Record<string, unknown>,
  generatedAt: string,
  paths: Record<string, string>,
  rows: { trainRows: number; validationRows: number },
): Promise<Record<string, unknown>> {
  const artifacts: Record<string, unknown> = {};
  const rowCounts: Record<string, number | undefined> = {
    train: rows.trainRows,
    validation: rows.validationRows,
    candidates: rows.validationRows,
  };
  for (const [name, path] of Object.entries(paths)) {
    if (name === 'audit' || name === 'manifest') continue;
    const info = await stat(path);
    artifacts[name] = {
      fileName: path.split('/').pop(),
      byteLength: info.size,
      sha256: await hashFile(path),
      rowCount: rowCounts[name],
    };
  }
  const featureFields = Object.keys(prepare(probeRow(), 'UNKNOWN').features);
  return {
    schemaVersion: SCHEMA_VERSION,
    pipelineVersion: 'CONTEXTUAL_V3_TRAINING_PIPELINE_1',
    generatedAt,
    source: {
      datasetVersion: source.datasetVersion,
      datasetSha256: source.artifact.sha256,
      descriptorSha256: source.source.descriptorSha256,
      selectedMatchCount: source.source.selectedMatchCount,
      selectedWindowStartTime: source.source.selectedWindowStartTime,
      selectedWindowEndTime: source.source.selectedWindowEndTime,
    },
    split: {
      strategy: 'CHRONOLOGICAL_MATCH_LEVEL',
      trainFraction: options.trainFraction,
      trainMatchCount: split.train.length,
      validationMatchCount: split.validation.length,
      trainWindowStartTime: split.train[0].startTime,
      trainWindowEndTime: split.train[split.train.length - 1].startTime,
      validationWindowStartTime: split.validation[0].startTime,
      validationWindowEndTime: split.validation[split.validation.length - 1].startTime,
    },
    featureContract: {
      featureCutoff: 'DECISION_TIME',
      features: featureFields,
      targetFields: ['target.actionType', 'target.itemId', 'target.actionKey'],
      outcomeFields: ['outcomeLabel.playerWon'],
      excludedPostDecisionFields: [
        'inventoryAfterStateKey',
        'actualActionType',
        'actualItemId',
        'actualActionKey',
        'kills',
        'deaths',
        'assists',
        'netWorth',
      ],
    },
    artifacts,
    evaluationReleaseGatePassed: Boolean(asRecord(evaluation.releaseGate).passed),
    futureFinalTestNotBeforeMatchStartTime: source.source.selectedWindowEndTime,
  };
}

function serializeModel(model: Model): Record<string, unknown> {
  return {
    hero: serializeTable(model.hero),
    heroPhase: serializeTable(model.heroPhase),
    heroPhaseArchetype: serializeTable(model.heroPhaseArchetype),
    ally: serializeTable(model.ally),
    enemy: serializeTable(model.enemy),
  };
}

function serializeTable(table: CountTable): Record<string, Record<string, number>> {
  return Object.fromEntries(
    [...table]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, counts]) => [
        key,
        Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b))),
      ]),
  );
}

function emptyMetrics(): Metrics {
  return {
    evaluatedDecisionCount: 0,
    top1Count: 0,
    top3Count: 0,
    reciprocalRankSum: 0,
  };
}

function finalizeMetrics(metrics: Metrics): Record<string, number> {
  return {
    ...metrics,
    top1Rate: divide(metrics.top1Count, metrics.evaluatedDecisionCount),
    top3Rate: divide(metrics.top3Count, metrics.evaluatedDecisionCount),
    meanReciprocalRank: divide(metrics.reciprocalRankSum, metrics.evaluatedDecisionCount),
  };
}

async function eachRow(
  path: string,
  consumer: (row: HeroBuildDecisionDatasetV3Row) => Promise<void>,
): Promise<void> {
  const input = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (!line) continue;
      let row: HeroBuildDecisionDatasetV3Row;
      try {
        row = JSON.parse(line) as HeroBuildDecisionDatasetV3Row;
      } catch (error) {
        throw new Error(`Invalid NDJSON at line ${lineNumber}: ${String(error)}`);
      }
      if (
        !Number.isSafeInteger(row.matchId) ||
        !Number.isSafeInteger(row.playerId) ||
        !Number.isSafeInteger(row.heroId) ||
        !Number.isFinite(new Date(row.matchStartTime).getTime()) ||
        typeof row.actualActionKey !== 'string' ||
        !Array.isArray(row.previousActionKeys)
      ) {
        throw new Error(`Invalid source row at line ${lineNumber}.`);
      }
      await consumer(row);
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

function increment(table: CountTable, key: string, action: string): void {
  const counts = table.get(key) ?? new Map<string, number>();
  counts.set(action, (counts.get(action) ?? 0) + 1);
  table.set(key, counts);
}

function mergeCounts(primary?: CountMap, secondary?: CountMap): CountMap {
  const result = new Map<string, number>();
  for (const [key, count] of secondary ?? []) result.set(key, count);
  for (const [key, count] of primary ?? []) {
    result.set(key, (result.get(key) ?? 0) + count * 2);
  }
  return result;
}

function logProbability(
  counts: CountMap | undefined,
  action: string,
  vocabularySize: number,
  smoothing: number,
): number {
  return Math.log(
    ((counts?.get(action) ?? 0) + smoothing) /
      (countTotal(counts) + smoothing * Math.max(1, vocabularySize)),
  );
}

function countTotal(counts: CountMap | undefined): number {
  if (!counts) return 0;
  const cached = TOTAL_CACHE.get(counts);
  if (cached !== undefined) return cached;
  const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
  TOTAL_CACHE.set(counts, total);
  return total;
}

function parseAction(
  actionKey: string,
): { actionType: HeroBuildDecisionActionType; itemId: number } | undefined {
  const [actionType, itemText] = actionKey.split(':');
  const itemId = Number(itemText);
  if (
    !['BUY', 'REBUY', 'UPGRADE', 'SELL'].includes(actionType) ||
    !Number.isSafeInteger(itemId) ||
    itemId <= 0
  ) {
    return undefined;
  }
  return { actionType: actionType as HeroBuildDecisionActionType, itemId };
}

function normalizeOptions(
  request: ContextualV3TrainingStartRequest,
  defaultSha: string,
): TrainingOptions {
  const expectedSourceSha256 = request.expectedSourceSha256?.trim() || defaultSha;
  if (!/^[a-f0-9]{64}$/i.test(expectedSourceSha256)) {
    throw new Error('expectedSourceSha256 must be a hexadecimal SHA-256.');
  }
  return {
    trainFraction: boundedNumber(request.trainFraction, 0.85, 0.5, 0.95, 'trainFraction'),
    maxArchetypesPerHero: boundedInteger(
      request.maxArchetypesPerHero,
      8,
      1,
      32,
      'maxArchetypesPerHero',
    ),
    minArchetypePlayers: boundedInteger(
      request.minArchetypePlayers,
      100,
      1,
      100_000,
      'minArchetypePlayers',
    ),
    candidateLimit: boundedInteger(request.candidateLimit, 64, 5, 256, 'candidateLimit'),
    smoothing: boundedNumber(request.smoothing, 10, 0.01, 10_000, 'smoothing'),
    expectedSourceSha256: expectedSourceSha256.toLowerCase(),
  };
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) {
    throw new Error(`${name} must be a safe integer from ${min} to ${max}.`);
  }
  return result;
}

function boundedNumber(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result < min || result > max) {
    throw new Error(`${name} must be a number from ${min} to ${max}.`);
  }
  return result;
}

class LineWriter {
  private buffer = '';

  private constructor(private readonly handle: FileHandle) {}

  static async create(path: string): Promise<LineWriter> {
    return new LineWriter(await open(path, 'w'));
  }

  async write(value: unknown): Promise<void> {
    this.buffer += `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(this.buffer) >= BUFFER_LIMIT) await this.flush();
  }

  async close(): Promise<void> {
    await this.flush();
    await this.handle.close();
  }

  private async flush(): Promise<void> {
    if (!this.buffer) return;
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
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await writeFile(`${path}.partial`, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rm(path, { force: true });
  await rename(`${path}.partial`, path);
}

async function readJson<T = Record<string, unknown>>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if (getCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

async function requiredJson<T>(path: string): Promise<T> {
  const value = await readJson<T>(path);
  if (!value) throw new Error(`Required artifact is missing: ${path}`);
  return value;
}

function probeRow(): HeroBuildDecisionDatasetV3Row {
  return {
    schemaVersion: 1,
    decisionId: 'probe',
    matchId: 1,
    matchStartTime: new Date(0).toISOString(),
    playerId: 1,
    heroId: 1,
    team: 0,
    gameTimeS: 0,
    phase: 'EARLY',
    inventoryBeforeStateKey: 'EMPTY',
    inventoryAfterStateKey: '1x1',
    previousActionKeys: [],
    buildPrefixKey: 'EMPTY',
    alliedHeroIds: [2, 3, 4, 5, 6],
    enemyHeroIds: [7, 8, 9, 10, 11, 12],
    actualActionType: 'BUY',
    actualItemId: 1,
    actualActionKey: 'BUY:1',
    outcomeLabel: { playerWon: true },
  };
}

function average(values: readonly number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function divide(a: number, b: number): number {
  return b > 0 ? a / b : 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function toNumber(value: unknown): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function getCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? ((error as { code: string }).code)
    : undefined;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
