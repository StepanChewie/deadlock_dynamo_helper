import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Repository } from 'typeorm';
import { ItemComponent } from './entities/item-component.entity';
import { Item } from './entities/item.entity';
import type { HeroBuildContextualRecommendationRequest } from './contextual-hero-build-recommendation.service';
import { canonicalHeroId } from './hero-id-aliases';
import {
  ContextualV3CandidateCatalog,
  orderContextualV3CandidateActions,
} from './hero-build-contextual-v3-candidate-evaluation.service';
import {
  HeroBuildRecommendationAction,
  HeroBuildRecommendationMatchupSignal,
  HeroBuildRecommendationResponse,
} from './hero-build-recommendation.service';
import { createInventoryStateKeyFromItemIds } from './hero-build-transition-aggregation.service';

const DEFAULT_TRAINING_DIR = '/app/apps/api/storage/contextual-v3-training';
const DEFAULT_CANDIDATE_EVALUATION_DIR =
  '/app/apps/api/storage/contextual-v3-candidate-evaluation-v2';
const DEFAULT_FINAL_TEST_DIR = '/app/apps/api/storage/contextual-v3-final-test';
const EXPECTED_MODEL_VERSION = 'CONTEXTUAL_V3_HIERARCHICAL_COUNT_RANKER_1';
const EXPECTED_CANDIDATE_POLICY =
  'TRAIN_OBSERVED_GLOBAL_BACKOFF_LEGAL_SHORTLIST';
const EXPECTED_CANDIDATE_LIMIT = 128;
const DEFAULT_EXPECTED_MODEL_SHA256 =
  '88e3400e7bc88f0af7a6752fc4b7ea9b83af9a8a6424dff707b151e6459f10d3';
const DEFAULT_SMOOTHING = 10;
const DEFAULT_ARCHETYPE_WEIGHT = 0.5;
const DEFAULT_ALLY_WEIGHT = 0.08;
const DEFAULT_ENEMY_WEIGHT = 0.12;
const MAX_PUBLIC_RECOMMENDATIONS = 20;
const MAX_MATCHUP_SIGNALS_PER_ACTION = 2;
const MIN_MATCHUP_SIGNAL_OBSERVATIONS = 30;
const MIN_MATCHUP_SIGNAL_LIFT_PERCENT = 0.5;
const TOTAL_CACHE = new WeakMap<object, number>();

export type ContextualV3LiveState = 'READY' | 'UNAVAILABLE';

export interface ContextualV3LiveStatus {
  state: ContextualV3LiveState;
  modelVersion?: string;
  modelExpectedSha256: string;
  modelActualSha256?: string;
  candidatePolicy: string;
  candidateLimit: number;
  validationGatePassed: boolean;
  validationAuditPassed: boolean;
  finalTestGatePassed: boolean;
  finalTestAuditPassed: boolean;
  catalogVerified: boolean;
  loadedAt?: string;
  error?: string;
}

export type ContextualV3LiveRecommendationResponse = HeroBuildRecommendationResponse & {
  recommendationModel: 'CONTEXTUAL_V3';
  modelVersion: string;
  modelSha256: string;
  candidateSetPolicy: string;
  candidateLimit: number;
  buildArchetypeId: string;
  contextualFeatures: {
    phase: ContextualV3Phase;
    alliedHeroIds: number[];
    enemyHeroIds: number[];
    previousActionCount: number;
    archetypeApplied: boolean;
  };
};

type CountRecord = Record<string, number>;
type CountTable = Record<string, CountRecord>;
type ContextualV3Phase = 'EARLY' | 'MID' | 'LATE';

interface ContextualV3ArchetypeDefinition {
  id: string;
  heroId: number;
  signature: string;
}

interface SerializedModel {
  schemaVersion: number;
  modelVersion: string;
  generatedAt: string;
  options?: {
    smoothing?: number;
  };
  weights?: {
    archetypeDelta?: number;
    alliedRosterDeltaAverage?: number;
    enemyRosterDeltaAverage?: number;
  };
  archetypes: {
    fitSplit: string;
    definitionsByHero: Record<string, ContextualV3ArchetypeDefinition[]>;
  };
  counts: {
    hero: CountTable;
    heroPhase: CountTable;
    heroPhaseArchetype: CountTable;
    ally: CountTable;
    enemy: CountTable;
  };
}

interface ArtifactDescriptor {
  sha256: string;
}

interface TrainingManifest {
  pipelineVersion: string;
  artifacts: {
    model: ArtifactDescriptor;
  };
}

interface CandidateEvaluationManifest {
  evaluationVersion: string;
  source: {
    modelSha256: string;
    modelVersion: string;
  };
  candidatePolicy: {
    name: string;
    candidateLimit: number;
  };
  evaluationReleaseGatePassed: boolean;
}

interface CandidateEvaluation {
  releaseGate: {
    passed: boolean;
  };
}

interface CandidateAudit {
  passed: boolean;
}

interface FinalTestManifest {
  evaluationVersion: string;
  source: {
    modelSha256: string;
    modelVersion: string;
    catalogSha256: string;
  };
  candidatePolicy: {
    name: string;
    candidateLimit: number;
  };
  auditPassed: boolean;
  finalTestReleaseGatePassed: boolean;
  productionDecision: {
    status: string;
  };
}

interface FinalTestEvaluation {
  releaseGate: {
    passed: boolean;
  };
  productionDecision: {
    status: string;
  };
}

interface FinalTestAudit {
  passed: boolean;
}

interface LoadedContextualV3 {
  model: SerializedModel;
  modelSha256: string;
  globalCounts: CountRecord;
  catalog: ContextualV3CandidateCatalog;
}

interface ParsedAction {
  sourceActionType: 'BUY' | 'REBUY' | 'UPGRADE';
  publicActionType: 'BUY' | 'UPGRADE';
  itemId: number;
  sourceActionKey: string;
  publicActionKey: string;
}

interface RawScoredAction {
  parsed: ParsedAction;
  score: number;
  matchupSignals: HeroBuildRecommendationMatchupSignal[];
}

interface ScoredAction extends RawScoredAction {
  probability: number;
}

export interface ContextualV3EnemyMatchupEvidence {
  heroId: number;
  logProbability: number;
  observationCount: number;
}

@Injectable()
export class HeroBuildContextualV3LiveService implements OnModuleInit {
  private readonly logger = new Logger(HeroBuildContextualV3LiveService.name);
  private readonly trainingDir =
    process.env.DEADLOCK_CONTEXTUAL_V3_TRAINING_DIR?.trim() || DEFAULT_TRAINING_DIR;
  private readonly candidateEvaluationDir =
    process.env.DEADLOCK_CONTEXTUAL_V3_CANDIDATE_EVALUATION_DIR?.trim() ||
    DEFAULT_CANDIDATE_EVALUATION_DIR;
  private readonly finalTestDir =
    process.env.DEADLOCK_CONTEXTUAL_V3_FINAL_TEST_DIR?.trim() ||
    DEFAULT_FINAL_TEST_DIR;
  private readonly expectedModelSha256 =
    process.env.DEADLOCK_CONTEXTUAL_V3_PRODUCTION_EXPECTED_MODEL_SHA256?.trim() ||
    DEFAULT_EXPECTED_MODEL_SHA256;

  private loaded?: LoadedContextualV3;
  private status: ContextualV3LiveStatus = this.createUnavailableStatus();

  constructor(
    @InjectRepository(Item)
    private readonly itemRepository: Repository<Item>,
    @InjectRepository(ItemComponent)
    private readonly itemComponentRepository: Repository<ItemComponent>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.reload();
  }

  getStatus(): ContextualV3LiveStatus {
    return clone(this.status);
  }

  async reload(): Promise<ContextualV3LiveStatus> {
    try {
      const loaded = await this.loadAndVerify();
      this.loaded = loaded;
      this.status = {
        state: 'READY',
        modelVersion: loaded.model.modelVersion,
        modelExpectedSha256: this.expectedModelSha256,
        modelActualSha256: loaded.modelSha256,
        candidatePolicy: EXPECTED_CANDIDATE_POLICY,
        candidateLimit: EXPECTED_CANDIDATE_LIMIT,
        validationGatePassed: true,
        validationAuditPassed: true,
        finalTestGatePassed: true,
        finalTestAuditPassed: true,
        catalogVerified: true,
        loadedAt: new Date().toISOString(),
      };
      this.logger.log(
        `Contextual V3 live model loaded: ${loaded.model.modelVersion}, ` +
          `sha256 ${loaded.modelSha256}.`,
      );
    } catch (error) {
      const message = getErrorMessage(error);
      this.loaded = undefined;
      this.status = {
        ...this.createUnavailableStatus(),
        error: message,
      };
      this.logger.error(`Contextual V3 live model is unavailable: ${message}`);
    }
    return this.getStatus();
  }

  recommend(
    request: HeroBuildContextualRecommendationRequest,
    baseline?: HeroBuildRecommendationResponse,
  ): ContextualV3LiveRecommendationResponse {
    const loaded = this.loaded;
    if (!loaded || this.status.state !== 'READY') {
      throw new Error(this.status.error || 'Contextual V3 live model is not ready.');
    }

    const heroId = request.heroId;
    const phase = getContextualV3Phase(request.gameTimeS);
    const inventoryStateKey = createInventoryStateKeyFromItemIds(request.itemIds);
    const inventory = parseInventoryItemIds(inventoryStateKey);
    const alliedHeroIds = normalizeContextualV3RosterHeroIds(
      request.alliedHeroIds ?? [],
    );
    const enemyHeroIds = normalizeContextualV3RosterHeroIds(
      request.enemyHeroIds ?? [],
    );
    const previousActionKeys = normalizeActionKeys(request.previousActionKeys ?? []);
    const archetypeId = assignLiveArchetype(
      heroId,
      previousActionKeys,
      loaded.model.archetypes.definitionsByHero,
    );
    const phaseKey = `${heroId}|${phase}`;
    const orderedCandidates = orderContextualV3CandidateActions(
      loaded.model.counts.heroPhase[phaseKey],
      loaded.model.counts.hero[String(heroId)],
      loaded.globalCounts,
      inventory,
      loaded.catalog,
    ).slice(0, EXPECTED_CANDIDATE_LIMIT);

    if (orderedCandidates.length === 0) {
      throw new Error('Contextual V3 produced no legal live candidates.');
    }

    const scored = scoreCandidates({
      candidates: orderedCandidates,
      model: loaded.model,
      heroId,
      phase,
      archetypeId,
      alliedHeroIds,
      enemyHeroIds,
    });
    const actions = buildRecommendationActions(
      scored,
      request,
      inventoryStateKey,
      loaded.model,
      loaded.catalog,
    ).slice(0, normalizePublicLimit(request.limit));

    if (actions.length === 0) {
      throw new Error('Contextual V3 produced no presentable live actions.');
    }

    const action = actions[0];
    const mode = baseline
      ? baseline.mode === 'NO_MATCH'
        ? 'BACKOFF'
        : baseline.mode
      : 'BACKOFF';

    return {
      ...(baseline ?? {}),
      mode,
      heroId: request.heroId,
      requestedStateKey: inventoryStateKey,
      gameTimeS: request.gameTimeS,
      matchedStateKey: inventoryStateKey,
      stateDistance: 0,
      missingItemCount: 0,
      extraItemCount: 0,
      matchedBySubset: true,
      observationCount: action.matchedStateObservationCount,
      candidateStateCount: orderedCandidates.length,
      action,
      alternatives: actions.slice(1),
      backoffReason:
        baseline?.mode === 'NO_MATCH'
          ? 'DIRECTIONAL_FALLBACK'
          : baseline?.backoffReason,
      noMatchReason: undefined,
      recommendationModel: 'CONTEXTUAL_V3',
      modelVersion: loaded.model.modelVersion,
      modelSha256: loaded.modelSha256,
      candidateSetPolicy: EXPECTED_CANDIDATE_POLICY,
      candidateLimit: EXPECTED_CANDIDATE_LIMIT,
      buildArchetypeId: archetypeId,
      contextualFeatures: {
        phase,
        alliedHeroIds,
        enemyHeroIds,
        previousActionCount: previousActionKeys.length,
        archetypeApplied: previousActionKeys.length > 0,
      },
    };
  }

  private async loadAndVerify(): Promise<LoadedContextualV3> {
    const modelPath = join(this.trainingDir, 'model.json');
    const [
      trainingManifest,
      candidateManifest,
      candidateEvaluation,
      candidateAudit,
      finalManifest,
      finalEvaluation,
      finalAudit,
      modelRaw,
      modelSha256,
      catalog,
    ] = await Promise.all([
      requiredJson<TrainingManifest>(join(this.trainingDir, 'manifest.json')),
      requiredJson<CandidateEvaluationManifest>(
        join(this.candidateEvaluationDir, 'manifest.json'),
      ),
      requiredJson<CandidateEvaluation>(
        join(this.candidateEvaluationDir, 'evaluation.json'),
      ),
      requiredJson<CandidateAudit>(join(this.candidateEvaluationDir, 'audit.json')),
      requiredJson<FinalTestManifest>(join(this.finalTestDir, 'manifest.json')),
      requiredJson<FinalTestEvaluation>(join(this.finalTestDir, 'evaluation.json')),
      requiredJson<FinalTestAudit>(join(this.finalTestDir, 'audit.json')),
      readFile(modelPath, 'utf8'),
      hashFile(modelPath),
      this.loadCatalog(),
    ]);

    const model = JSON.parse(modelRaw) as SerializedModel;
    validateModel(model);
    assertEqual(modelSha256, this.expectedModelSha256, 'Configured model SHA-256');
    assertEqual(
      modelSha256,
      trainingManifest.artifacts.model.sha256,
      'Training manifest model SHA-256',
    );
    assertEqual(
      modelSha256,
      candidateManifest.source.modelSha256,
      'Candidate-evaluation model SHA-256',
    );
    assertEqual(
      modelSha256,
      finalManifest.source.modelSha256,
      'Final-test model SHA-256',
    );
    assertEqual(
      candidateManifest.source.modelVersion,
      EXPECTED_MODEL_VERSION,
      'Candidate-evaluation model version',
    );
    assertEqual(
      finalManifest.source.modelVersion,
      EXPECTED_MODEL_VERSION,
      'Final-test model version',
    );
    assertEqual(
      candidateManifest.candidatePolicy.name,
      EXPECTED_CANDIDATE_POLICY,
      'Candidate-evaluation policy',
    );
    assertEqual(
      candidateManifest.candidatePolicy.candidateLimit,
      EXPECTED_CANDIDATE_LIMIT,
      'Candidate-evaluation limit',
    );
    assertEqual(
      finalManifest.candidatePolicy.name,
      EXPECTED_CANDIDATE_POLICY,
      'Final-test candidate policy',
    );
    assertEqual(
      finalManifest.candidatePolicy.candidateLimit,
      EXPECTED_CANDIDATE_LIMIT,
      'Final-test candidate limit',
    );

    if (
      !candidateManifest.evaluationReleaseGatePassed ||
      !candidateEvaluation.releaseGate.passed
    ) {
      throw new Error('Contextual V3 validation release gate did not pass.');
    }
    if (!candidateAudit.passed) {
      throw new Error('Contextual V3 validation audit did not pass.');
    }
    if (
      !finalManifest.finalTestReleaseGatePassed ||
      !finalEvaluation.releaseGate.passed
    ) {
      throw new Error('Contextual V3 final-test release gate did not pass.');
    }
    if (!finalManifest.auditPassed || !finalAudit.passed) {
      throw new Error('Contextual V3 final-test audit did not pass.');
    }
    if (
      finalManifest.productionDecision.status !== 'ELIGIBLE_FOR_SHADOW_MODE' ||
      finalEvaluation.productionDecision.status !== 'ELIGIBLE_FOR_SHADOW_MODE'
    ) {
      throw new Error('Contextual V3 final-test production decision is not eligible.');
    }

    const catalogSha256 = hashCatalog(catalog);
    assertEqual(
      catalogSha256,
      finalManifest.source.catalogSha256,
      'Live catalog SHA-256',
    );

    return {
      model,
      modelSha256,
      globalCounts: aggregateGlobalCounts(model.counts.hero),
      catalog,
    };
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

  private createUnavailableStatus(): ContextualV3LiveStatus {
    return {
      state: 'UNAVAILABLE',
      modelExpectedSha256: this.expectedModelSha256,
      candidatePolicy: EXPECTED_CANDIDATE_POLICY,
      candidateLimit: EXPECTED_CANDIDATE_LIMIT,
      validationGatePassed: false,
      validationAuditPassed: false,
      finalTestGatePassed: false,
      finalTestAuditPassed: false,
      catalogVerified: false,
    };
  }
}

export function getContextualV3Phase(gameTimeS: number): ContextualV3Phase {
  if (gameTimeS < 10 * 60) {
    return 'EARLY';
  }
  if (gameTimeS < 20 * 60) {
    return 'MID';
  }
  return 'LATE';
}

export function assignLiveArchetype(
  heroId: number,
  previousActionKeys: readonly string[],
  definitionsByHero: Record<string, ContextualV3ArchetypeDefinition[]>,
): string {
  if (previousActionKeys.length === 0) {
    return 'UNKNOWN';
  }
  const prefix = previousActionKeys.slice(0, 4).join('>');
  const definition = (definitionsByHero[String(heroId)] ?? []).find(
    (value) =>
      value.signature === prefix || value.signature.startsWith(`${prefix}>`),
  );
  return definition?.id ?? 'OTHER';
}

export function createContextualV3MatchupSignals(input: {
  baseLogProbability: number;
  enemyWeight: number;
  evidence: readonly ContextualV3EnemyMatchupEvidence[];
}): HeroBuildRecommendationMatchupSignal[] {
  if (
    input.evidence.length === 0 ||
    !Number.isFinite(input.baseLogProbability) ||
    !Number.isFinite(input.enemyWeight)
  ) {
    return [];
  }

  const divisor = input.evidence.length;
  return input.evidence
    .map((value) => {
      const isolatedScoreContribution =
        input.enemyWeight *
        (value.logProbability - input.baseLogProbability);
      const scoreContribution = isolatedScoreContribution / divisor;
      const contextualPurchaseLiftPercent =
        (Math.exp(isolatedScoreContribution) - 1) * 100;
      return {
        heroId: value.heroId,
        direction:
          isolatedScoreContribution >= 0
            ? 'POSITIVE' as const
            : 'NEGATIVE' as const,
        scoreContribution,
        contextualPurchaseLiftPercent,
        observationCount: value.observationCount,
      };
    })
    .filter(
      (value) =>
        value.direction === 'POSITIVE' &&
        value.observationCount >= MIN_MATCHUP_SIGNAL_OBSERVATIONS &&
        value.contextualPurchaseLiftPercent >= MIN_MATCHUP_SIGNAL_LIFT_PERCENT,
    )
    .sort(
      (left, right) =>
        right.scoreContribution - left.scoreContribution ||
        right.observationCount - left.observationCount ||
        left.heroId - right.heroId,
    )
    .slice(0, MAX_MATCHUP_SIGNALS_PER_ACTION);
}

function scoreCandidates(input: {
  candidates: readonly string[];
  model: SerializedModel;
  heroId: number;
  phase: ContextualV3Phase;
  archetypeId: string;
  alliedHeroIds: readonly number[];
  enemyHeroIds: readonly number[];
}): ScoredAction[] {
  const smoothing = finiteOr(input.model.options?.smoothing, DEFAULT_SMOOTHING);
  const weights = {
    archetype: finiteOr(
      input.model.weights?.archetypeDelta,
      DEFAULT_ARCHETYPE_WEIGHT,
    ),
    allies: finiteOr(
      input.model.weights?.alliedRosterDeltaAverage,
      DEFAULT_ALLY_WEIGHT,
    ),
    enemies: finiteOr(
      input.model.weights?.enemyRosterDeltaAverage,
      DEFAULT_ENEMY_WEIGHT,
    ),
  };
  const baseKey = `${input.heroId}|${input.phase}`;
  const raw = input.candidates
    .map((sourceActionKey) => {
      const parsed = parseAction(sourceActionKey);
      if (!parsed) {
        return undefined;
      }
      const base = logProbability(
        input.model.counts.heroPhase[baseKey],
        sourceActionKey,
        input.candidates.length,
        smoothing,
      );
      const archetypeDelta =
        logProbability(
          input.model.counts.heroPhaseArchetype[
            `${baseKey}|${input.archetypeId}`
          ],
          sourceActionKey,
          input.candidates.length,
          smoothing,
        ) - base;
      const allyDelta = input.alliedHeroIds.length > 0
        ? average(
            input.alliedHeroIds.map((heroId) =>
              logProbability(
                input.model.counts.ally[`${baseKey}|${heroId}`],
                sourceActionKey,
                input.candidates.length,
                smoothing,
              ),
            ),
          ) - base
        : 0;
      const enemyEvidence = input.enemyHeroIds.map((heroId) => {
        const counts = input.model.counts.enemy[`${baseKey}|${heroId}`];
        return {
          heroId,
          logProbability: logProbability(
            counts,
            sourceActionKey,
            input.candidates.length,
            smoothing,
          ),
          observationCount: counts?.[sourceActionKey] ?? 0,
        };
      });
      const enemyDelta = enemyEvidence.length > 0
        ? average(enemyEvidence.map((value) => value.logProbability)) - base
        : 0;
      return {
        parsed,
        score:
          base +
          weights.archetype * archetypeDelta +
          weights.allies * allyDelta +
          weights.enemies * enemyDelta,
        matchupSignals: createContextualV3MatchupSignals({
          baseLogProbability: base,
          enemyWeight: weights.enemies,
          evidence: enemyEvidence,
        }),
      };
    })
    .filter((value): value is RawScoredAction => value !== undefined);

  const bestByPublicAction = new Map<string, RawScoredAction>();
  for (const value of raw) {
    const existing = bestByPublicAction.get(value.parsed.publicActionKey);
    if (!existing || value.score > existing.score) {
      bestByPublicAction.set(value.parsed.publicActionKey, value);
    }
  }
  const ranked = [...bestByPublicAction.values()].sort(
    (left, right) =>
      right.score - left.score ||
      left.parsed.publicActionKey.localeCompare(right.parsed.publicActionKey),
  );
  const maximum = Math.max(...ranked.map((value) => value.score));
  const exponentials = ranked.map((value) => Math.exp(value.score - maximum));
  const total = exponentials.reduce((sum, value) => sum + value, 0);
  return ranked.map((value, index) => ({
    ...value,
    probability: total > 0 ? exponentials[index] / total : 0,
  }));
}

function buildRecommendationActions(
  scored: readonly ScoredAction[],
  request: HeroBuildContextualRecommendationRequest,
  inventoryStateKey: string,
  model: SerializedModel,
  catalog: ContextualV3CandidateCatalog,
): HeroBuildRecommendationAction[] {
  const currentCounts = createItemCounts(request.itemIds);
  const phase = getContextualV3Phase(request.gameTimeS);
  const phaseCounts = model.counts.heroPhase[`${request.heroId}|${phase}`];
  const heroCounts = model.counts.hero[String(request.heroId)];
  const phaseTotal = countTotal(phaseCounts);
  const heroTotal = countTotal(heroCounts);

  return scored.map(({ parsed, probability, matchupSignals }) => {
    const predictedCounts = new Map(currentCounts);
    if (parsed.publicActionType === 'UPGRADE') {
      for (const componentItemId of catalog.componentsByParent.get(parsed.itemId) ?? []) {
        decrementItemCount(predictedCounts, componentItemId);
      }
    }
    incrementItemCount(predictedCounts, parsed.itemId);
    const historicalCount =
      phaseCounts?.[parsed.sourceActionKey] ??
      heroCounts?.[parsed.sourceActionKey] ??
      0;
    const denominator = phaseCounts?.[parsed.sourceActionKey] !== undefined
      ? phaseTotal
      : heroTotal;
    const currentOwnedCount = currentCounts.get(parsed.itemId) ?? 0;

    return {
      type: parsed.publicActionType,
      sourceActionType: parsed.sourceActionType,
      itemId: parsed.itemId,
      actionKey: parsed.publicActionKey,
      historicalCount,
      historicalProbability: denominator > 0 ? historicalCount / denominator : 0,
      averageGameTimeS: request.gameTimeS,
      matchedStateKey: inventoryStateKey,
      matchedStateObservationCount: Math.max(phaseTotal, heroTotal),
      stateDistance: 0,
      missingItemCount: 0,
      extraItemCount: 0,
      matchedBySubset: true,
      currentOwnedCount:
        parsed.publicActionType === 'BUY' ? currentOwnedCount : undefined,
      observedOwnedCountLimit:
        parsed.publicActionType === 'BUY' ? currentOwnedCount + 1 : undefined,
      matchupSignals,
      predictedStateKey: createStateKeyFromCounts(predictedCounts),
      score: probability,
      confidence: probability,
    };
  });
}

function parseAction(actionKey: string): ParsedAction | undefined {
  const match = /^(BUY|REBUY|UPGRADE):([1-9][0-9]*)$/.exec(actionKey);
  if (!match) {
    return undefined;
  }
  const sourceActionType = match[1] as ParsedAction['sourceActionType'];
  const itemId = Number(match[2]);
  if (!Number.isSafeInteger(itemId) || itemId <= 0) {
    return undefined;
  }
  const publicActionType = sourceActionType === 'UPGRADE' ? 'UPGRADE' : 'BUY';
  return {
    sourceActionType,
    publicActionType,
    itemId,
    sourceActionKey: actionKey,
    publicActionKey: `${publicActionType}:${itemId}`,
  };
}

function parseInventoryItemIds(stateKey: string): Set<number> {
  if (!stateKey || stateKey === 'EMPTY') {
    return new Set();
  }
  return new Set(
    stateKey
      .split('|')
      .map((token) => Number(token.split('x')[0]))
      .filter((itemId) => Number.isSafeInteger(itemId) && itemId > 0),
  );
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

function logProbability(
  counts: CountRecord | undefined,
  actionKey: string,
  vocabularySize: number,
  smoothing: number,
): number {
  return Math.log(
    ((counts?.[actionKey] ?? 0) + smoothing) /
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

function hashCatalog(catalog: ContextualV3CandidateCatalog): string {
  const lines = [
    ...[...catalog.itemIds]
      .sort((left, right) => left - right)
      .map((itemId) => `ITEM:${itemId}`),
    ...[...catalog.componentsByParent]
      .sort(([left], [right]) => left - right)
      .flatMap(([parentItemId, componentItemIds]) =>
        [...componentItemIds]
          .sort((left, right) => left - right)
          .map(
            (componentItemId) =>
              `RECIPE:${parentItemId}:${componentItemId}`,
          ),
      ),
  ];
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function requiredJson<T>(path: string): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    throw new Error(`Required Contextual V3 artifact is invalid or missing: ${path}. ${getErrorMessage(error)}`);
  }
}

function validateModel(model: SerializedModel): void {
  if (model.modelVersion !== EXPECTED_MODEL_VERSION) {
    throw new Error(
      `Unexpected Contextual V3 model version: ${String(model.modelVersion)}.`,
    );
  }
  if (model.archetypes?.fitSplit !== 'TRAIN') {
    throw new Error('Contextual V3 archetypes were not fitted on TRAIN.');
  }
  if (!model.counts?.hero || !model.counts.heroPhase) {
    throw new Error('Contextual V3 model count tables are missing.');
  }
}

function assertEqual(
  actual: string | number,
  expected: string | number,
  label: string,
): void {
  if (actual !== expected) {
    throw new Error(`${label} mismatch: expected ${expected}, got ${actual}.`);
  }
}

export function normalizeContextualV3RosterHeroIds(
  values: readonly number[],
): number[] {
  return [
    ...new Set(
      values
        .filter((value) => Number.isSafeInteger(value) && value > 0)
        .map((value) => canonicalHeroId(value)),
    ),
  ].sort((left, right) => left - right);
}

function normalizeActionKeys(values: readonly string[]): string[] {
  return values
    .map((value) => value.trim())
    .filter((value) => /^(BUY|REBUY|UPGRADE|SELL):[1-9][0-9]*$/.test(value));
}

function normalizePublicLimit(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    return 5;
  }
  return Math.min(Number(value), MAX_PUBLIC_RECOMMENDATIONS);
}

function createItemCounts(itemIds: readonly number[]): Map<number, number> {
  const result = new Map<number, number>();
  for (const itemId of itemIds) {
    incrementItemCount(result, itemId);
  }
  return result;
}

function incrementItemCount(itemCounts: Map<number, number>, itemId: number): void {
  itemCounts.set(itemId, (itemCounts.get(itemId) ?? 0) + 1);
}

function decrementItemCount(itemCounts: Map<number, number>, itemId: number): void {
  const count = itemCounts.get(itemId) ?? 0;
  if (count <= 1) {
    itemCounts.delete(itemId);
  } else {
    itemCounts.set(itemId, count - 1);
  }
}

function createStateKeyFromCounts(itemCounts: ReadonlyMap<number, number>): string {
  const value = [...itemCounts]
    .filter(([, count]) => count > 0)
    .sort(([left], [right]) => left - right)
    .map(([itemId, count]) => `${itemId}x${count}`)
    .join('|');
  return value || 'EMPTY';
}

function average(values: readonly number[]): number {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function finiteOr(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
