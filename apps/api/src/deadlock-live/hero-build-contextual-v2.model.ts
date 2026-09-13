import type { CanonicalPlayerBuildSequence } from './canonical-build-sequence.service';
import {
  getHeroBuildEvaluationPhase,
  HeroBuildEvaluationPhase,
} from './hero-build-offline-evaluation.service';
import { resolveValveHeroIdFromGep } from './hero-id-aliases';
import type { HeroBuildRecommendationAction } from './hero-build-recommendation.service';

export const HERO_BUILD_CONTEXTUAL_V2_MODEL_VERSION =
  'NEXT_ACTION_ROSTER_SHRINKAGE_V2' as const;
export const HERO_BUILD_CONTEXTUAL_V2_DEFAULT_CANDIDATE_LIMIT = 5;
export const HERO_BUILD_CONTEXTUAL_V2_DEFAULT_MIN_ACTION_OBSERVATIONS = 50;
export const HERO_BUILD_CONTEXTUAL_V2_DEFAULT_MIN_CONTEXT_OBSERVATIONS = 100;
export const HERO_BUILD_CONTEXTUAL_V2_DEFAULT_SHRINKAGE_STRENGTH = 100;
export const HERO_BUILD_CONTEXTUAL_V2_DEFAULT_LAMBDA = 0.05;
export const HERO_BUILD_CONTEXTUAL_V2_DEFAULT_MAX_LOGIT_BONUS = 0.1;
export const HERO_BUILD_CONTEXTUAL_V2_DEFAULT_MAX_PROMOTION_DISTANCE = 1;

const CONTINUITY_CORRECTION = 0.5;
const MAX_RAW_INTERACTION_LOG_ODDS = 2;

export interface HeroBuildContextualV2Config {
  id: string;
  candidateLimit: number;
  minimumActionObservations: number;
  minimumContextObservations: number;
  shrinkageStrength: number;
  lambda: number;
  maximumLogitBonus: number;
  maximumPromotionDistance: number;
}

export interface HeroBuildContextualV2ScopeEvidence {
  scope: 'HERO' | 'PHASE' | 'STATE';
  phase?: HeroBuildEvaluationPhase;
  stateKey?: string;
  totalAgainst: number;
  actionAgainst: number;
  otherActionsAgainst: number;
  totalWithout: number;
  actionWithout: number;
  otherActionsWithout: number;
  actionObservationCount: number;
  interactionLogOddsRatio: number;
  standardError: number;
  lower95InteractionLogOddsRatio: number;
  upper95InteractionLogOddsRatio: number;
}

export interface HeroBuildContextualV2EnemyEvidence {
  enemyHeroId: number;
  enemyValveHeroId: number;
  hero?: HeroBuildContextualV2ScopeEvidence;
  phase?: HeroBuildContextualV2ScopeEvidence;
  state?: HeroBuildContextualV2ScopeEvidence;
}

export interface HeroBuildContextualV2ActionEvaluation {
  phase: HeroBuildEvaluationPhase;
  actionKey: string;
  enemyHeroIds: number[];
  evidence: HeroBuildContextualV2EnemyEvidence[];
}

export interface HeroBuildContextualV2EnemySignal {
  enemyHeroId: number;
  enemyValveHeroId: number;
  eligible: boolean;
  support: number;
  reliability: number;
  hierarchicalInteractionLogOdds: number;
  heroInteractionLogOdds: number;
  phaseInteractionLogOdds: number;
  stateInteractionLogOdds: number;
}

export type HeroBuildContextualV2Action = HeroBuildRecommendationAction & {
  baseScore: number;
  contextualScore: number;
  baseRank: number;
  contextualRank: number;
  contextualLogitBonus: number;
  rosterInteractionLogOdds: number;
  observedEnemyCount: number;
  eligibleEnemyCount: number;
  wasPromotedByContext: boolean;
  modelVersion: typeof HERO_BUILD_CONTEXTUAL_V2_MODEL_VERSION;
  configId: string;
  enemySignals: HeroBuildContextualV2EnemySignal[];
  contextEvidence: HeroBuildContextualV2EnemyEvidence[];
};

export interface HeroBuildContextualV2RerankResult {
  modelVersion: typeof HERO_BUILD_CONTEXTUAL_V2_MODEL_VERSION;
  config: HeroBuildContextualV2Config;
  evaluatedCandidateCount: number;
  changedTop1: boolean;
  changedTop3: boolean;
  promotedCandidateCount: number;
  actions: HeroBuildContextualV2Action[];
}

interface MutableEnemyActionCounts {
  total: number;
  actionCounts: Map<string, number>;
}

interface MutableActionScope {
  total: number;
  actionCounts: Map<string, number>;
  byEnemyHeroId: Map<number, MutableEnemyActionCounts>;
}

export interface HeroBuildNextActionContextIndexSummary {
  scopeCount: number;
  actionOptionCount: number;
  observationCount: number;
  enemyObservationCount: number;
}

export class HeroBuildNextActionContextIndex {
  private readonly scopes = new Map<string, MutableActionScope>();

  addSequence(
    sequence: CanonicalPlayerBuildSequence,
    enemyHeroIds: readonly number[],
  ): void {
    if (
      sequence.replayDiagnosticCount > 0 ||
      sequence.steps.length === 0 ||
      !Number.isSafeInteger(sequence.heroId) ||
      sequence.heroId <= 0
    ) {
      return;
    }

    const normalizedEnemyHeroIds = normalizeValveHeroIds(enemyHeroIds);
    for (const step of sequence.steps) {
      const phase = getHeroBuildEvaluationPhase(step.gameTimeS);
      this.addObservation('H', step.actionKey, normalizedEnemyHeroIds);
      this.addObservation(`P|${phase}`, step.actionKey, normalizedEnemyHeroIds);
      this.addObservation(
        `S|${phase}|${step.beforeStateKey}`,
        step.actionKey,
        normalizedEnemyHeroIds,
      );
    }
  }

  evaluate(input: {
    stateKey: string;
    actionKey: string;
    gameTimeS: number;
    enemyHeroIds: readonly number[];
  }): HeroBuildContextualV2ActionEvaluation {
    const phase = getHeroBuildEvaluationPhase(input.gameTimeS);
    const enemyPairs = normalizeRequestedEnemyHeroIds(input.enemyHeroIds);
    const heroScope = this.scopes.get('H');
    const phaseScope = this.scopes.get(`P|${phase}`);
    const stateScope = this.scopes.get(`S|${phase}|${input.stateKey}`);

    return {
      phase,
      actionKey: input.actionKey,
      enemyHeroIds: enemyPairs.map((value) => value.requestedHeroId),
      evidence: enemyPairs.map((enemy) => ({
        enemyHeroId: enemy.requestedHeroId,
        enemyValveHeroId: enemy.valveHeroId,
        hero: calculateScopeEvidence(
          'HERO',
          heroScope,
          input.actionKey,
          enemy.valveHeroId,
        ),
        phase: calculateScopeEvidence(
          'PHASE',
          phaseScope,
          input.actionKey,
          enemy.valveHeroId,
          phase,
        ),
        state: calculateScopeEvidence(
          'STATE',
          stateScope,
          input.actionKey,
          enemy.valveHeroId,
          phase,
          input.stateKey,
        ),
      })),
    };
  }

  getSummary(): HeroBuildNextActionContextIndexSummary {
    let actionOptionCount = 0;
    let observationCount = 0;
    let enemyObservationCount = 0;
    for (const scope of this.scopes.values()) {
      actionOptionCount += scope.actionCounts.size;
      observationCount += scope.total;
      for (const enemy of scope.byEnemyHeroId.values()) {
        enemyObservationCount += enemy.total;
      }
    }
    return {
      scopeCount: this.scopes.size,
      actionOptionCount,
      observationCount,
      enemyObservationCount,
    };
  }

  private addObservation(
    scopeKey: string,
    actionKey: string,
    enemyHeroIds: readonly number[],
  ): void {
    const scope = this.scopes.get(scopeKey) ?? createMutableScope();
    scope.total += 1;
    incrementMap(scope.actionCounts, actionKey);
    for (const enemyHeroId of enemyHeroIds) {
      const enemy = scope.byEnemyHeroId.get(enemyHeroId) ?? {
        total: 0,
        actionCounts: new Map<string, number>(),
      };
      enemy.total += 1;
      incrementMap(enemy.actionCounts, actionKey);
      scope.byEnemyHeroId.set(enemyHeroId, enemy);
    }
    this.scopes.set(scopeKey, scope);
  }
}

export function createDefaultHeroBuildContextualV2Config(): HeroBuildContextualV2Config {
  return {
    id: 'v2-default',
    candidateLimit: HERO_BUILD_CONTEXTUAL_V2_DEFAULT_CANDIDATE_LIMIT,
    minimumActionObservations:
      HERO_BUILD_CONTEXTUAL_V2_DEFAULT_MIN_ACTION_OBSERVATIONS,
    minimumContextObservations:
      HERO_BUILD_CONTEXTUAL_V2_DEFAULT_MIN_CONTEXT_OBSERVATIONS,
    shrinkageStrength: HERO_BUILD_CONTEXTUAL_V2_DEFAULT_SHRINKAGE_STRENGTH,
    lambda: HERO_BUILD_CONTEXTUAL_V2_DEFAULT_LAMBDA,
    maximumLogitBonus: HERO_BUILD_CONTEXTUAL_V2_DEFAULT_MAX_LOGIT_BONUS,
    maximumPromotionDistance:
      HERO_BUILD_CONTEXTUAL_V2_DEFAULT_MAX_PROMOTION_DISTANCE,
  };
}

export function createHeroBuildContextualV2ValidationGrid(): HeroBuildContextualV2Config[] {
  const configurations: HeroBuildContextualV2Config[] = [
    {
      ...createDefaultHeroBuildContextualV2Config(),
      id: 'baseline-control',
      lambda: 0,
      maximumLogitBonus: 0,
      maximumPromotionDistance: 0,
    },
  ];
  const lambdas = [0.025, 0.05, 0.1];
  const minimumActionObservations = [25, 50];
  const minimumContextObservations = [100, 250];
  const shrinkageStrengths = [50, 100];

  for (const lambda of lambdas) {
    for (const minimumAction of minimumActionObservations) {
      for (const minimumContext of minimumContextObservations) {
        for (const shrinkageStrength of shrinkageStrengths) {
          configurations.push({
            id: [
              'v2',
              `l${formatConfigNumber(lambda)}`,
              `a${minimumAction}`,
              `c${minimumContext}`,
              `s${shrinkageStrength}`,
            ].join('-'),
            candidateLimit: 5,
            minimumActionObservations: minimumAction,
            minimumContextObservations: minimumContext,
            shrinkageStrength,
            lambda,
            maximumLogitBonus: lambda <= 0.05 ? 0.05 : 0.1,
            maximumPromotionDistance: 1,
          });
        }
      }
    }
  }
  return configurations;
}

export function rerankHeroBuildActionsV2(
  baseActions: readonly HeroBuildRecommendationAction[],
  evaluationsByActionKey: ReadonlyMap<string, HeroBuildContextualV2ActionEvaluation>,
  config: HeroBuildContextualV2Config,
): HeroBuildContextualV2RerankResult {
  const candidates = baseActions
    .filter((action) => action.type !== 'HOLD')
    .slice(0, config.candidateLimit)
    .map((action, index) =>
      contextualizeAction(
        action,
        index + 1,
        evaluationsByActionKey.get(action.actionKey),
        config,
      ),
    );

  const topThree = selectBestConstrainedPermutation(
    candidates.slice(0, 3),
    config.maximumPromotionDistance,
  );
  const remaining = selectBestConstrainedPermutation(
    candidates.slice(3),
    config.maximumPromotionDistance,
  );
  const ranked = [...topThree, ...remaining].map((action, index) => ({
    ...action,
    contextualRank: index + 1,
    wasPromotedByContext: index + 1 < action.baseRank,
  }));
  const baseTop3 = candidates.slice(0, 3).map((action) => action.actionKey);
  const contextualTop3 = ranked.slice(0, 3).map((action) => action.actionKey);

  return {
    modelVersion: HERO_BUILD_CONTEXTUAL_V2_MODEL_VERSION,
    config: { ...config },
    evaluatedCandidateCount: ranked.length,
    changedTop1: candidates[0]?.actionKey !== ranked[0]?.actionKey,
    changedTop3: !sameValues(baseTop3, contextualTop3),
    promotedCandidateCount: ranked.filter((action) => action.wasPromotedByContext)
      .length,
    actions: ranked,
  };
}

function contextualizeAction(
  action: HeroBuildRecommendationAction,
  baseRank: number,
  evaluation: HeroBuildContextualV2ActionEvaluation | undefined,
  config: HeroBuildContextualV2Config,
): HeroBuildContextualV2Action {
  const enemySignals = (evaluation?.evidence ?? []).map((evidence) =>
    buildEnemySignal(evidence, config),
  );
  const eligibleEnemySignals = enemySignals.filter((signal) => signal.eligible);
  const rosterInteractionLogOdds =
    enemySignals.length === 0
      ? 0
      : enemySignals.reduce(
          (sum, signal) =>
            sum + signal.hierarchicalInteractionLogOdds * signal.reliability,
          0,
        ) / enemySignals.length;
  const contextualLogitBonus = clamp(
    config.lambda * rosterInteractionLogOdds,
    -config.maximumLogitBonus,
    config.maximumLogitBonus,
  );
  const contextualScore = applyLogitBonus(action.score, contextualLogitBonus);

  return {
    ...action,
    score: contextualScore,
    baseScore: action.score,
    contextualScore,
    baseRank,
    contextualRank: baseRank,
    contextualLogitBonus,
    rosterInteractionLogOdds,
    observedEnemyCount: enemySignals.length,
    eligibleEnemyCount: eligibleEnemySignals.length,
    wasPromotedByContext: false,
    modelVersion: HERO_BUILD_CONTEXTUAL_V2_MODEL_VERSION,
    configId: config.id,
    enemySignals,
    contextEvidence: evaluation?.evidence ?? [],
  };
}

function buildEnemySignal(
  evidence: HeroBuildContextualV2EnemyEvidence,
  config: HeroBuildContextualV2Config,
): HeroBuildContextualV2EnemySignal {
  const heroEffect = shrinkTowardPrior(evidence.hero, 0, config.shrinkageStrength);
  const phaseEffect = shrinkTowardPrior(
    evidence.phase,
    heroEffect.value,
    config.shrinkageStrength,
  );
  const stateEffect = shrinkTowardPrior(
    evidence.state,
    phaseEffect.value,
    config.shrinkageStrength,
  );
  const eligibleScope = [evidence.state, evidence.phase, evidence.hero].find(
    (scope) =>
      scope !== undefined &&
      scope.actionObservationCount >= config.minimumActionObservations &&
      scope.totalAgainst >= config.minimumContextObservations,
  );
  const supportScope = eligibleScope ?? evidence.state ?? evidence.phase ?? evidence.hero;
  const actionObservationCount = supportScope?.actionObservationCount ?? 0;
  const contextObservationCount = supportScope?.totalAgainst ?? 0;
  const eligible = eligibleScope !== undefined;
  const actionReliability = Math.min(
    1,
    actionObservationCount / Math.max(1, config.minimumActionObservations),
  );
  const contextReliability = Math.min(
    1,
    contextObservationCount / Math.max(1, config.minimumContextObservations),
  );
  const hierarchyReliability = evidence.state
    ? stateEffect.reliability
    : evidence.phase
      ? phaseEffect.reliability
      : heroEffect.reliability;
  const reliability = eligible
    ? Math.min(hierarchyReliability, actionReliability, contextReliability)
    : 0;

  return {
    enemyHeroId: evidence.enemyHeroId,
    enemyValveHeroId: evidence.enemyValveHeroId,
    eligible,
    support: Math.min(actionObservationCount, contextObservationCount),
    reliability,
    hierarchicalInteractionLogOdds: eligible ? stateEffect.value : 0,
    heroInteractionLogOdds: heroEffect.value,
    phaseInteractionLogOdds: phaseEffect.value,
    stateInteractionLogOdds: stateEffect.value,
  };
}

function shrinkTowardPrior(
  evidence: HeroBuildContextualV2ScopeEvidence | undefined,
  prior: number,
  shrinkageStrength: number,
): { value: number; reliability: number } {
  if (!evidence) {
    return { value: prior, reliability: 0 };
  }
  const support = Math.max(
    0,
    Math.min(evidence.actionObservationCount, evidence.totalAgainst),
  );
  const reliability = support / (support + Math.max(1, shrinkageStrength));
  const raw = clamp(
    evidence.interactionLogOddsRatio,
    -MAX_RAW_INTERACTION_LOG_ODDS,
    MAX_RAW_INTERACTION_LOG_ODDS,
  );
  return {
    value: prior + reliability * (raw - prior),
    reliability,
  };
}

function selectBestConstrainedPermutation(
  actions: readonly HeroBuildContextualV2Action[],
  maximumPromotionDistance: number,
): HeroBuildContextualV2Action[] {
  if (actions.length < 2 || maximumPromotionDistance <= 0) {
    return [...actions];
  }
  const permutations = permute(actions);
  const valid = permutations.filter((permutation) =>
    permutation.every(
      (action, index) =>
        action.baseRank - (actions[0].baseRank + index) <=
        maximumPromotionDistance,
    ),
  );
  return (valid.length > 0 ? valid : [[...actions]])
    .sort(compareActionPermutations)[0]
    .map((action) => ({ ...action }));
}

function compareActionPermutations(
  left: readonly HeroBuildContextualV2Action[],
  right: readonly HeroBuildContextualV2Action[],
): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const scoreDifference = right[index].contextualScore - left[index].contextualScore;
    if (scoreDifference !== 0) {
      return scoreDifference;
    }
    const rankDifference = left[index].baseRank - right[index].baseRank;
    if (rankDifference !== 0) {
      return rankDifference;
    }
  }
  return left.length - right.length;
}

function permute<T>(values: readonly T[]): T[][] {
  if (values.length <= 1) {
    return [[...values]];
  }
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += 1) {
    const remaining = values.filter((_, candidateIndex) => candidateIndex !== index);
    for (const suffix of permute(remaining)) {
      result.push([values[index], ...suffix]);
    }
  }
  return result;
}

function calculateScopeEvidence(
  scopeName: HeroBuildContextualV2ScopeEvidence['scope'],
  scope: MutableActionScope | undefined,
  actionKey: string,
  enemyHeroId: number,
  phase?: HeroBuildEvaluationPhase,
  stateKey?: string,
): HeroBuildContextualV2ScopeEvidence | undefined {
  if (!scope) {
    return undefined;
  }
  const against = scope.byEnemyHeroId.get(enemyHeroId);
  if (!against || against.total <= 0 || scope.total <= against.total) {
    return undefined;
  }
  const totalAgainst = against.total;
  const actionAgainst = against.actionCounts.get(actionKey) ?? 0;
  const otherActionsAgainst = totalAgainst - actionAgainst;
  const totalWithout = scope.total - totalAgainst;
  const totalActionCount = scope.actionCounts.get(actionKey) ?? 0;
  const actionWithout = totalActionCount - actionAgainst;
  const otherActionsWithout = totalWithout - actionWithout;
  const againstOdds = calculateLogOdds(actionAgainst, otherActionsAgainst);
  const withoutOdds = calculateLogOdds(actionWithout, otherActionsWithout);
  const interactionLogOddsRatio = againstOdds.value - withoutOdds.value;
  const standardError = Math.sqrt(againstOdds.variance + withoutOdds.variance);

  return {
    scope: scopeName,
    phase,
    stateKey,
    totalAgainst,
    actionAgainst,
    otherActionsAgainst,
    totalWithout,
    actionWithout,
    otherActionsWithout,
    actionObservationCount: actionAgainst + actionWithout,
    interactionLogOddsRatio,
    standardError,
    lower95InteractionLogOddsRatio:
      interactionLogOddsRatio - 1.96 * standardError,
    upper95InteractionLogOddsRatio:
      interactionLogOddsRatio + 1.96 * standardError,
  };
}

function calculateLogOdds(
  actionCount: number,
  otherActionCount: number,
): { value: number; variance: number } {
  const action = actionCount + CONTINUITY_CORRECTION;
  const other = otherActionCount + CONTINUITY_CORRECTION;
  return {
    value: Math.log(action / other),
    variance: 1 / action + 1 / other,
  };
}

function applyLogitBonus(probabilityValue: number, bonus: number): number {
  const probability = clamp(probabilityValue, 1e-9, 1 - 1e-9);
  if (bonus === 0) {
    return probabilityValue;
  }
  const logit = Math.log(probability / (1 - probability));
  return logistic(logit + bonus);
}

function logistic(value: number): number {
  if (value >= 0) {
    const exponential = Math.exp(-value);
    return 1 / (1 + exponential);
  }
  const exponential = Math.exp(value);
  return exponential / (1 + exponential);
}

function createMutableScope(): MutableActionScope {
  return {
    total: 0,
    actionCounts: new Map<string, number>(),
    byEnemyHeroId: new Map<number, MutableEnemyActionCounts>(),
  };
}

function incrementMap(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function normalizeValveHeroIds(heroIds: readonly number[]): number[] {
  return [...new Set(
    heroIds.filter((heroId) => Number.isSafeInteger(heroId) && heroId > 0),
  )].sort((left, right) => left - right);
}

function normalizeRequestedEnemyHeroIds(
  heroIds: readonly number[],
): { requestedHeroId: number; valveHeroId: number }[] {
  const seenValveHeroIds = new Set<number>();
  const result: { requestedHeroId: number; valveHeroId: number }[] = [];
  for (const requestedHeroId of [...new Set(heroIds)].sort((left, right) => left - right)) {
    if (!Number.isSafeInteger(requestedHeroId) || requestedHeroId <= 0) {
      continue;
    }
    const valveHeroId = resolveValveHeroIdFromGep(requestedHeroId);
    if (seenValveHeroIds.has(valveHeroId)) {
      continue;
    }
    seenValveHeroIds.add(valveHeroId);
    result.push({ requestedHeroId, valveHeroId });
  }
  return result;
}

function formatConfigNumber(value: number): string {
  return String(value).replace('.', 'p');
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(minimum, Math.min(maximum, value));
}
