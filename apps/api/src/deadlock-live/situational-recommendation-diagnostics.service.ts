import { Injectable } from '@nestjs/common';
import {
  ContextualHeroBuildRecommendationAction,
  ContextualHeroBuildRecommendationResponse,
  HeroBuildContextualRecommendationRequest,
} from './contextual-hero-build-recommendation.service';
import { canonicalHeroId } from './hero-id-aliases';
import {
  GraphMatchupEvidence,
  HeroBuildMatchupStatisticsService,
} from './hero-build-matchup-statistics.service';
import {
  HERO_BUILD_MAX_RECOMMENDATION_LIMIT,
  HeroBuildRecommendationService,
  parseInventoryStateKey,
} from './hero-build-recommendation.service';
import {
  HeroBuildPolicyNextAction,
  HeroBuildPolicyState,
  HeroBuildTransitionAggregationService,
} from './hero-build-transition-aggregation.service';
import { RecentMatchesWindowService } from './recent-matches-window.service';

export const SITUATIONAL_DIAGNOSTIC_DEFAULT_LIMIT = 10;
export const SITUATIONAL_DIAGNOSTIC_MAX_LIMIT = 50;
export const SITUATIONAL_DIAGNOSTIC_DEFAULT_MAX_EVALUATED_ACTIONS = 500;
export const SITUATIONAL_DIAGNOSTIC_MAX_EVALUATED_ACTIONS = 50_000;
export const SITUATIONAL_DIAGNOSTIC_DEFAULT_MAX_VALIDATED_STATES = 12;
export const SITUATIONAL_DIAGNOSTIC_MAX_VALIDATED_STATES = 50;

interface RawSituationalCandidate {
  heroId: number;
  enemyHeroId: number;
  stateKey: string;
  itemIds: number[];
  action: HeroBuildPolicyNextAction;
  evidence: GraphMatchupEvidence;
}

interface HeroScanCursor {
  heroId: number;
  enemyHeroIds: number[];
  states: HeroBuildPolicyState[];
  stateIndex: number;
  actionIndex: number;
  currentState?: HeroBuildPolicyState;
  currentItemIds: number[];
  currentActions: HeroBuildPolicyNextAction[];
}

interface HeroScanAction {
  heroId: number;
  enemyHeroIds: number[];
  state: HeroBuildPolicyState;
  itemIds: number[];
  action: HeroBuildPolicyNextAction;
}

export interface SituationalRecommendationDiagnosticExample {
  heroId: number;
  enemyHeroId: number;
  stateKey: string;
  itemIds: number[];
  gameTimeS: number;
  itemId?: number;
  actionKey: string;
  actionType: ContextualHeroBuildRecommendationAction['type'];
  baseRank: number;
  contextualRank: number;
  wasInBaseBuild: boolean;
  wasPromotedByMatchup: boolean;
  wasInsertedByMatchup: boolean;
  isPrimaryRecommendation: boolean;
  wouldTriggerWarning: boolean;
  lower95OddsRatio: number;
  interactionOddsRatio: number;
  matchupObservationCount: number;
  evaluatedCandidateCount: number;
  situationalCandidateCount: number;
  promotedSituationalCandidateCount: number;
  insertedSituationalCandidateCount: number;
  requestBody: HeroBuildContextualRecommendationRequest;
}

export interface SituationalRecommendationDiagnosticResult {
  generatedAt: string;
  sourceMatchCount: number;
  sourceHeroCount: number;
  policyActionOptionCount: number;
  evaluatedActionCount: number;
  evaluatedHeroCount: number;
  scanTruncated: boolean;
  rawPositiveSignalCount: number;
  validatedStateEnemyCount: number;
  validationCandidateCount: number;
  validationTruncated: boolean;
  visibleSituationalExampleCount: number;
  warningExampleCount: number;
  examples: SituationalRecommendationDiagnosticExample[];
}

export interface SituationalRecommendationDiagnosticOptions {
  limit?: number;
  maxEvaluatedActions?: number;
  maxValidatedStates?: number;
}

@Injectable()
export class SituationalRecommendationDiagnosticsService {
  constructor(
    private readonly heroBuildTransitionAggregationService:
      HeroBuildTransitionAggregationService,
    private readonly heroBuildMatchupStatisticsService:
      HeroBuildMatchupStatisticsService,
    private readonly heroBuildRecommendationService: HeroBuildRecommendationService,
    private readonly recentMatchesWindowService: RecentMatchesWindowService,
  ) {}

  async findExamples(
    options: SituationalRecommendationDiagnosticOptions = {},
  ): Promise<SituationalRecommendationDiagnosticResult> {
    const limit = normalizePositiveInteger(
      options.limit,
      SITUATIONAL_DIAGNOSTIC_DEFAULT_LIMIT,
      SITUATIONAL_DIAGNOSTIC_MAX_LIMIT,
    );
    const maxEvaluatedActions = normalizePositiveInteger(
      options.maxEvaluatedActions,
      SITUATIONAL_DIAGNOSTIC_DEFAULT_MAX_EVALUATED_ACTIONS,
      SITUATIONAL_DIAGNOSTIC_MAX_EVALUATED_ACTIONS,
    );
    const maxValidatedStates = normalizePositiveInteger(
      options.maxValidatedStates,
      SITUATIONAL_DIAGNOSTIC_DEFAULT_MAX_VALIDATED_STATES,
      SITUATIONAL_DIAGNOSTIC_MAX_VALIDATED_STATES,
    );

    await this.heroBuildTransitionAggregationService.ensureReady();

    const sourceMatches = this.recentMatchesWindowService.getMatches();
    const heroIds = collectHeroIds(sourceMatches);
    const policyStatus = this.heroBuildTransitionAggregationService.getStatus();
    const rawCandidates: RawSituationalCandidate[] = [];
    const evaluatedHeroIds = new Set<number>();
    let rawPositiveSignalCount = 0;
    let evaluatedActionCount = 0;
    let activeCursors = createHeroScanCursors(
      heroIds,
      this.heroBuildTransitionAggregationService,
    );

    while (
      evaluatedActionCount < maxEvaluatedActions &&
      activeCursors.length > 0
    ) {
      const nextActiveCursors: HeroScanCursor[] = [];

      for (const cursor of activeCursors) {
        if (evaluatedActionCount >= maxEvaluatedActions) {
          break;
        }

        const scanAction = takeNextHeroScanAction(cursor);
        if (!scanAction) {
          continue;
        }
        nextActiveCursors.push(cursor);
        evaluatedActionCount += 1;
        evaluatedHeroIds.add(scanAction.heroId);

        const evaluation = await this.heroBuildMatchupStatisticsService.evaluate({
          heroId: scanAction.heroId,
          stateKey: scanAction.state.stateKey,
          actionKey: scanAction.action.actionKey,
          enemyHeroIds: scanAction.enemyHeroIds,
        });

        for (const evidence of evaluation.evidence) {
          if (evidence.lower95InteractionOddsRatio <= 1) {
            continue;
          }
          rawPositiveSignalCount += 1;
          rawCandidates.push({
            heroId: scanAction.heroId,
            enemyHeroId: evidence.enemyHeroId,
            stateKey: scanAction.state.stateKey,
            itemIds: [...scanAction.itemIds],
            action: scanAction.action,
            evidence,
          });
        }

        trimRawCandidates(rawCandidates, limit, maxValidatedStates);
      }

      activeCursors = nextActiveCursors;
    }

    rawCandidates.sort(compareRawCandidates);
    const allValidationCandidates = deduplicateStateEnemyCandidates(rawCandidates);
    const validationCandidates = allValidationCandidates.slice(0, maxValidatedStates);
    const examples: SituationalRecommendationDiagnosticExample[] = [];
    let validatedStateEnemyCount = 0;
    let warningExampleCount = 0;

    for (const candidate of validationCandidates) {
      validatedStateEnemyCount += 1;
      const requestBody: HeroBuildContextualRecommendationRequest = {
        heroId: candidate.heroId,
        itemIds: [...candidate.itemIds],
        gameTimeS: Math.max(0, Math.round(candidate.action.averageGameTimeS)),
        enemyHeroIds: [candidate.enemyHeroId],
        limit: HERO_BUILD_MAX_RECOMMENDATION_LIMIT,
      };
      const response = await this.heroBuildRecommendationService.recommend(
        requestBody,
      ) as ContextualHeroBuildRecommendationResponse;
      const visibleActions = [response.action, ...response.alternatives];
      const situationalAction = response.action.isSituational
        ? response.action
        : visibleActions.find((action) => action.isSituational);

      if (!situationalAction) {
        continue;
      }

      const example = createDiagnosticExample(
        candidate,
        requestBody,
        response,
        situationalAction,
      );
      examples.push(example);
      if (example.wouldTriggerWarning) {
        warningExampleCount += 1;
      }
      if (warningExampleCount >= limit) {
        break;
      }
    }

    const uniqueExamples = deduplicateExamples(examples).sort(compareExamples);
    const selectedExamples = uniqueExamples.slice(0, limit);

    return {
      generatedAt: new Date().toISOString(),
      sourceMatchCount: sourceMatches.length,
      sourceHeroCount: heroIds.length,
      policyActionOptionCount: policyStatus.actionOptionCount,
      evaluatedActionCount,
      evaluatedHeroCount: evaluatedHeroIds.size,
      scanTruncated: evaluatedActionCount < policyStatus.actionOptionCount,
      rawPositiveSignalCount,
      validatedStateEnemyCount,
      validationCandidateCount: allValidationCandidates.length,
      validationTruncated: validatedStateEnemyCount < allValidationCandidates.length,
      visibleSituationalExampleCount: uniqueExamples.length,
      warningExampleCount: uniqueExamples.filter(
        (example) => example.wouldTriggerWarning,
      ).length,
      examples: selectedExamples,
    };
  }
}

function createHeroScanCursors(
  heroIds: readonly number[],
  aggregationService: Pick<HeroBuildTransitionAggregationService, 'getHeroPolicy'>,
): HeroScanCursor[] {
  const cursors: HeroScanCursor[] = [];

  for (const heroId of heroIds) {
    const policy = aggregationService.getHeroPolicy(heroId);
    if (!policy) {
      continue;
    }

    cursors.push({
      heroId,
      enemyHeroIds: heroIds.filter((enemyHeroId) => enemyHeroId !== heroId),
      states: [...policy.statesByKey.values()].sort(
        (left, right) => right.observationCount - left.observationCount,
      ),
      stateIndex: 0,
      actionIndex: 0,
      currentItemIds: [],
      currentActions: [],
    });
  }

  return cursors;
}

function takeNextHeroScanAction(
  cursor: HeroScanCursor,
): HeroScanAction | undefined {
  while (cursor.actionIndex >= cursor.currentActions.length) {
    const state = cursor.states[cursor.stateIndex];
    if (!state) {
      return undefined;
    }
    cursor.stateIndex += 1;

    const itemIds = expandInventoryStateKey(state.stateKey);
    if (!itemIds) {
      continue;
    }

    const actions = [...state.nextActions].sort(
      (left, right) => right.count - left.count,
    );
    if (actions.length === 0) {
      continue;
    }

    cursor.currentState = state;
    cursor.currentItemIds = itemIds;
    cursor.currentActions = actions;
    cursor.actionIndex = 0;
  }

  const state = cursor.currentState;
  const action = cursor.currentActions[cursor.actionIndex];
  if (!state || !action) {
    return undefined;
  }
  cursor.actionIndex += 1;

  return {
    heroId: cursor.heroId,
    enemyHeroIds: [...cursor.enemyHeroIds],
    state,
    itemIds: [...cursor.currentItemIds],
    action,
  };
}

function collectHeroIds(
  matches: ReturnType<RecentMatchesWindowService['getMatches']>,
): number[] {
  const heroIds = matches.flatMap((match) =>
    match.players
      .map((player) => player.heroId)
      .filter((heroId) => Number.isSafeInteger(heroId) && heroId > 0)
      .map(canonicalHeroId),
  );
  return [...new Set(heroIds)].sort((left, right) => left - right);
}

function expandInventoryStateKey(stateKey: string): number[] | undefined {
  const itemCounts = parseInventoryStateKey(stateKey);
  if (!itemCounts) {
    return undefined;
  }

  const itemIds: number[] = [];
  for (const [itemId, count] of [...itemCounts.entries()].sort(
    ([leftItemId], [rightItemId]) => leftItemId - rightItemId,
  )) {
    for (let index = 0; index < count; index += 1) {
      itemIds.push(itemId);
    }
  }
  return itemIds;
}

function trimRawCandidates(
  candidates: RawSituationalCandidate[],
  requestedLimit: number,
  maxValidatedStates: number,
): void {
  const retainedLimit = Math.min(
    maxValidatedStates * 4,
    Math.max(40, requestedLimit * 10),
  );
  if (candidates.length <= retainedLimit * 2) {
    return;
  }
  candidates.sort(compareRawCandidates);
  candidates.splice(retainedLimit);
}

function deduplicateStateEnemyCandidates(
  candidates: readonly RawSituationalCandidate[],
): RawSituationalCandidate[] {
  const result: RawSituationalCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = `${candidate.heroId}:${candidate.enemyHeroId}:${candidate.stateKey}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

function createDiagnosticExample(
  candidate: RawSituationalCandidate,
  requestBody: HeroBuildContextualRecommendationRequest,
  response: ContextualHeroBuildRecommendationResponse,
  action: ContextualHeroBuildRecommendationAction,
): SituationalRecommendationDiagnosticExample {
  const isPrimaryRecommendation = action.actionKey === response.action.actionKey;
  return {
    heroId: candidate.heroId,
    enemyHeroId: candidate.enemyHeroId,
    stateKey: candidate.stateKey,
    itemIds: [...candidate.itemIds],
    gameTimeS: requestBody.gameTimeS,
    itemId: action.itemId,
    actionKey: action.actionKey,
    actionType: action.type,
    baseRank: action.baseRank,
    contextualRank: action.contextualRank,
    wasInBaseBuild: action.wasInBaseBuild,
    wasPromotedByMatchup: action.wasPromotedByMatchup,
    wasInsertedByMatchup: action.wasInsertedByMatchup,
    isPrimaryRecommendation,
    wouldTriggerWarning:
      isPrimaryRecommendation &&
      action.isSituational &&
      action.wasPromotedByMatchup,
    lower95OddsRatio: action.situationalLower95OddsRatio ?? 1,
    interactionOddsRatio: action.situationalInteractionOddsRatio ?? 1,
    matchupObservationCount: action.matchupObservationCount,
    evaluatedCandidateCount: response.evaluatedCandidateCount,
    situationalCandidateCount: response.situationalCandidateCount,
    promotedSituationalCandidateCount:
      response.promotedSituationalCandidateCount,
    insertedSituationalCandidateCount:
      response.insertedSituationalCandidateCount,
    requestBody: {
      ...requestBody,
      itemIds: [...requestBody.itemIds],
      enemyHeroIds: [...(requestBody.enemyHeroIds ?? [])],
    },
  };
}

function deduplicateExamples(
  examples: readonly SituationalRecommendationDiagnosticExample[],
): SituationalRecommendationDiagnosticExample[] {
  const result: SituationalRecommendationDiagnosticExample[] = [];
  const seen = new Set<string>();
  for (const example of examples) {
    const key = [
      example.heroId,
      example.enemyHeroId,
      example.stateKey,
      example.actionKey,
    ].join(':');
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(example);
  }
  return result;
}

function compareRawCandidates(
  left: RawSituationalCandidate,
  right: RawSituationalCandidate,
): number {
  if (
    left.evidence.lower95InteractionOddsRatio !==
    right.evidence.lower95InteractionOddsRatio
  ) {
    return (
      right.evidence.lower95InteractionOddsRatio -
      left.evidence.lower95InteractionOddsRatio
    );
  }
  return (
    right.evidence.matchupObservationCount -
    left.evidence.matchupObservationCount
  );
}

function compareExamples(
  left: SituationalRecommendationDiagnosticExample,
  right: SituationalRecommendationDiagnosticExample,
): number {
  if (left.wouldTriggerWarning !== right.wouldTriggerWarning) {
    return left.wouldTriggerWarning ? -1 : 1;
  }
  if (left.isPrimaryRecommendation !== right.isPrimaryRecommendation) {
    return left.isPrimaryRecommendation ? -1 : 1;
  }
  if (left.wasInsertedByMatchup !== right.wasInsertedByMatchup) {
    return left.wasInsertedByMatchup ? -1 : 1;
  }
  if (left.wasPromotedByMatchup !== right.wasPromotedByMatchup) {
    return left.wasPromotedByMatchup ? -1 : 1;
  }
  if (left.lower95OddsRatio !== right.lower95OddsRatio) {
    return right.lower95OddsRatio - left.lower95OddsRatio;
  }
  return right.matchupObservationCount - left.matchupObservationCount;
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    return fallback;
  }
  return Math.min(Number(value), maximum);
}
