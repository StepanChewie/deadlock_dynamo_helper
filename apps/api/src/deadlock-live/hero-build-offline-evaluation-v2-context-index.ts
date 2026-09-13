import type { CanonicalPlayerBuildSequence } from './canonical-build-sequence.service';
import type {
  HeroBuildContextualV2ActionEvaluation,
  HeroBuildContextualV2EnemyEvidence,
  HeroBuildContextualV2ScopeEvidence,
  HeroBuildNextActionContextIndexSummary,
} from './hero-build-contextual-v2.model';
import {
  getHeroBuildEvaluationPhase,
  HeroBuildEvaluationPhase,
} from './hero-build-offline-evaluation.service';

const CONTINUITY_CORRECTION = 0.5;

interface MutableEnemyActionCounts {
  total: number;
  actionCounts: Map<string, number>;
}

interface MutableActionScope {
  total: number;
  actionCounts: Map<string, number>;
  byEnemyHeroId: Map<number, MutableEnemyActionCounts>;
}

export class HeroBuildOfflineV2ContextIndex {
  private readonly scopes = new Map<string, MutableActionScope>();

  addSequence(
    sequence: CanonicalPlayerBuildSequence,
    enemyValveHeroIds: readonly number[],
  ): void {
    if (
      sequence.replayDiagnosticCount > 0 ||
      sequence.steps.length === 0 ||
      !Number.isSafeInteger(sequence.heroId) ||
      sequence.heroId <= 0
    ) {
      return;
    }
    const normalizedEnemyHeroIds = normalizeHeroIds(enemyValveHeroIds);
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
    enemyValveHeroIds: readonly number[];
  }): HeroBuildContextualV2ActionEvaluation {
    const phase = getHeroBuildEvaluationPhase(input.gameTimeS);
    const enemyHeroIds = normalizeHeroIds(input.enemyValveHeroIds);
    const heroScope = this.scopes.get('H');
    const phaseScope = this.scopes.get(`P|${phase}`);
    const stateScope = this.scopes.get(`S|${phase}|${input.stateKey}`);
    const evidence: HeroBuildContextualV2EnemyEvidence[] = enemyHeroIds.map(
      (enemyHeroId) => ({
        enemyHeroId,
        enemyValveHeroId: enemyHeroId,
        hero: calculateScopeEvidence(
          'HERO',
          heroScope,
          input.actionKey,
          enemyHeroId,
        ),
        phase: calculateScopeEvidence(
          'PHASE',
          phaseScope,
          input.actionKey,
          enemyHeroId,
          phase,
        ),
        state: calculateScopeEvidence(
          'STATE',
          stateScope,
          input.actionKey,
          enemyHeroId,
          phase,
          input.stateKey,
        ),
      }),
    );
    return {
      phase,
      actionKey: input.actionKey,
      enemyHeroIds,
      evidence,
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
    const scope = this.scopes.get(scopeKey) ?? createScope();
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

function createScope(): MutableActionScope {
  return {
    total: 0,
    actionCounts: new Map<string, number>(),
    byEnemyHeroId: new Map<number, MutableEnemyActionCounts>(),
  };
}

function incrementMap(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function normalizeHeroIds(heroIds: readonly number[]): number[] {
  return [
    ...new Set(
      heroIds.filter(
        (heroId) => Number.isSafeInteger(heroId) && heroId > 0,
      ),
    ),
  ].sort((left, right) => left - right);
}
