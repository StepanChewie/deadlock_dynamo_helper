import { Injectable } from '@nestjs/common';
import { CanonicalBuildSequenceService } from './canonical-build-sequence.service';
import { canonicalHeroId, resolveValveHeroIdFromGep } from './hero-id-aliases';
import { InventoryTimelineReplayService } from './inventory-timeline-replay.service';
import { LiveHeroMatchupSourceService } from './live-hero-matchup-source.service';
import { MatchTimelineNormalizationService } from './match-timeline-normalization.service';
import { RecentMatchSnapshot } from './recent-matches-window.service';
import { RecipeAwareTimelineReconciliationService } from './recipe-aware-timeline-reconciliation.service';

export const GRAPH_MATCHUP_MODEL_VERSION = 'GRAPH_EDGE_INTERACTION_ODDS_RATIO_V1';
export const GRAPH_MATCHUP_CONFIDENCE_Z = 1.96;
export const GRAPH_MATCHUP_CONTINUITY_CORRECTION = 0.5;
const GRAPH_MATCHUP_YIELD_INTERVAL = 25;

export interface GraphOutcomeSample {
  matches: number;
  wins: number;
}

export interface GraphMatchupInteractionInput {
  enemyHeroId: number;
  actionAgainst: GraphOutcomeSample;
  otherActionsAgainst: GraphOutcomeSample;
  actionWithoutEnemy: GraphOutcomeSample;
  otherActionsWithoutEnemy: GraphOutcomeSample;
}

export interface GraphMatchupEvidence {
  enemyHeroId: number;
  matchupObservationCount: number;
  actionMatchupObservationCount: number;
  otherActionMatchupObservationCount: number;
  actionWinRateAgainst: number;
  otherActionsWinRateAgainst: number;
  actionWinRateWithoutEnemy: number;
  otherActionsWinRateWithoutEnemy: number;
  interactionLogOddsRatio: number;
  interactionOddsRatio: number;
  standardError: number;
  lower95InteractionLogOddsRatio: number;
  upper95InteractionLogOddsRatio: number;
  lower95InteractionOddsRatio: number;
  upper95InteractionOddsRatio: number;
}

export interface GraphMatchupEvaluation {
  modelVersion: typeof GRAPH_MATCHUP_MODEL_VERSION;
  found: boolean;
  heroId: number;
  stateKey: string;
  actionKey: string;
  stateObservationCount: number;
  actionObservationCount: number;
  enemyHeroIds: number[];
  bestEvidence?: GraphMatchupEvidence;
  evidence: GraphMatchupEvidence[];
}

interface MutableOutcomeSample {
  matches: number;
  wins: number;
}

interface MutableGraphActionStats extends MutableOutcomeSample {
  byEnemyHeroId: Map<number, MutableOutcomeSample>;
}

interface MutableGraphStateStats extends MutableOutcomeSample {
  byEnemyHeroId: Map<number, MutableOutcomeSample>;
  actionsByKey: Map<string, MutableGraphActionStats>;
}

type HeroGraphStateIndex = Map<string, MutableGraphStateStats>;

interface HeroGraphIndexCache {
  index: HeroGraphStateIndex;
  sourceVersionMs: number;
}

@Injectable()
export class HeroBuildMatchupStatisticsService {
  private readonly indexesByHeroId = new Map<number, HeroGraphIndexCache>();
  private readonly refreshPromisesByHeroId = new Map<number, Promise<void>>();

  constructor(
    private readonly liveHeroMatchupSourceService: LiveHeroMatchupSourceService,
    private readonly matchTimelineNormalizationService: MatchTimelineNormalizationService,
    private readonly inventoryTimelineReplayService: InventoryTimelineReplayService,
    private readonly canonicalBuildSequenceService: CanonicalBuildSequenceService,
    private readonly recipeAwareTimelineReconciliationService:
      RecipeAwareTimelineReconciliationService,
  ) {}

  async evaluate(input: {
    heroId: number;
    stateKey: string;
    actionKey: string;
    enemyHeroIds: number[];
  }): Promise<GraphMatchupEvaluation> {
    const heroId = canonicalHeroId(input.heroId);
    await this.ensureReady(heroId);

    const enemyHeroIds = normalizeGepHeroIds(input.enemyHeroIds);
    const enemyValveHeroIds = normalizeValveHeroIds(
      enemyHeroIds.map(resolveValveHeroIdFromGep),
    );
    const gepHeroIdByValveHeroId = new Map<number, number>();
    for (const enemyHeroId of enemyHeroIds) {
      gepHeroIdByValveHeroId.set(resolveValveHeroIdFromGep(enemyHeroId), enemyHeroId);
    }

    const state = this.indexesByHeroId.get(heroId)?.index.get(input.stateKey);
    const action = state?.actionsByKey.get(input.actionKey);

    if (!state || !action) {
      return {
        modelVersion: GRAPH_MATCHUP_MODEL_VERSION,
        found: false,
        heroId,
        stateKey: input.stateKey,
        actionKey: input.actionKey,
        stateObservationCount: state?.matches ?? 0,
        actionObservationCount: action?.matches ?? 0,
        enemyHeroIds,
        evidence: [],
      };
    }

    const otherActionsTotal = subtractSamples(state, action);
    const evidence = enemyValveHeroIds
      .map((enemyValveHeroId) => {
        const stateAgainst = state.byEnemyHeroId.get(enemyValveHeroId) ?? emptySample();
        const actionAgainst = action.byEnemyHeroId.get(enemyValveHeroId) ?? emptySample();
        const otherActionsAgainst = subtractSamples(stateAgainst, actionAgainst);
        const stateWithoutEnemy = subtractSamples(state, stateAgainst);
        const actionWithoutEnemy = subtractSamples(action, actionAgainst);
        const otherActionsWithoutEnemy = subtractSamples(
          otherActionsTotal,
          otherActionsAgainst,
        );

        return calculateGraphMatchupInteraction({
          enemyHeroId: gepHeroIdByValveHeroId.get(enemyValveHeroId) ?? enemyValveHeroId,
          actionAgainst,
          otherActionsAgainst,
          actionWithoutEnemy,
          otherActionsWithoutEnemy,
        });
      })
      .filter((value): value is GraphMatchupEvidence => value !== undefined)
      .sort(compareEvidence);

    return {
      modelVersion: GRAPH_MATCHUP_MODEL_VERSION,
      found: evidence.length > 0,
      heroId,
      stateKey: input.stateKey,
      actionKey: input.actionKey,
      stateObservationCount: state.matches,
      actionObservationCount: action.matches,
      enemyHeroIds,
      bestEvidence: evidence[0],
      evidence,
    };
  }

  private async ensureReady(heroId: number): Promise<void> {
    await this.liveHeroMatchupSourceService.ensureReady(heroId);

    const sourceVersionMs = this.liveHeroMatchupSourceService.getSourceVersionMs(heroId);
    const cached = this.indexesByHeroId.get(heroId);
    if (cached?.sourceVersionMs === sourceVersionMs) {
      return;
    }

    const refreshPromise = this.getOrStartHeroRefresh(heroId, sourceVersionMs);
    if (cached) {
      void refreshPromise.catch(() => undefined);
      return;
    }

    await refreshPromise;
  }

  private getOrStartHeroRefresh(heroId: number, sourceVersionMs: number): Promise<void> {
    const existing = this.refreshPromisesByHeroId.get(heroId);
    if (existing) {
      return existing;
    }

    const refreshPromise = this.rebuildHero(heroId, sourceVersionMs).finally(() => {
      this.refreshPromisesByHeroId.delete(heroId);
    });
    this.refreshPromisesByHeroId.set(heroId, refreshPromise);
    return refreshPromise;
  }

  private async rebuildHero(heroId: number, sourceVersionMs: number): Promise<void> {
    try {
      await this.recipeAwareTimelineReconciliationService.refreshRecipes();
    } catch {
      // The replay pipeline can use the existing recipe cache when refresh is unavailable.
    }

    const nextIndex: HeroGraphStateIndex = new Map();
    let processedMatchCount = 0;
    for (const match of this.liveHeroMatchupSourceService.getMatches(heroId)) {
      this.addMatch(nextIndex, match, heroId);
      processedMatchCount += 1;
      if (processedMatchCount % GRAPH_MATCHUP_YIELD_INTERVAL === 0) {
        await yieldToEventLoop();
      }
    }

    this.indexesByHeroId.set(heroId, {
      index: nextIndex,
      sourceVersionMs,
    });
  }

  private addMatch(
    index: HeroGraphStateIndex,
    match: RecentMatchSnapshot,
    requestedHeroId: number,
  ): void {
    const requestedValveHeroId = resolveValveHeroIdFromGep(requestedHeroId);
    const requestedPlayers = match.players.filter(
      (player) => player.heroId === requestedValveHeroId,
    );
    if (requestedPlayers.length === 0) {
      return;
    }

    const requestedHeroMatch: RecentMatchSnapshot = {
      ...match,
      players: requestedPlayers,
    };
    const timelines = this.matchTimelineNormalizationService.normalizeMatch(
      requestedHeroMatch,
    );
    const replay = this.inventoryTimelineReplayService.replayMatch(timelines);
    const sequences = this.canonicalBuildSequenceService.canonicalizeMatch(replay);
    const playersById = new Map(requestedPlayers.map((player) => [player.id, player]));

    for (const sequence of sequences.players) {
      if (sequence.heroId !== requestedValveHeroId) {
        continue;
      }
      if (sequence.replayDiagnosticCount > 0 || sequence.steps.length === 0) {
        continue;
      }

      const player = playersById.get(sequence.playerId);
      if (!player) {
        continue;
      }

      const enemyHeroIds = normalizeValveHeroIds(
        match.players
          .filter((candidate) => candidate.team !== player.team)
          .map((candidate) => candidate.heroId),
      );

      for (const step of sequence.steps) {
        const state = index.get(step.beforeStateKey) ?? createStateStats();
        incrementSample(state, player.won);
        incrementEnemySamples(state.byEnemyHeroId, enemyHeroIds, player.won);

        const action = state.actionsByKey.get(step.actionKey) ?? createActionStats();
        incrementSample(action, player.won);
        incrementEnemySamples(action.byEnemyHeroId, enemyHeroIds, player.won);

        state.actionsByKey.set(step.actionKey, action);
        index.set(step.beforeStateKey, state);
      }
    }
  }
}

export function calculateGraphMatchupInteraction(
  input: GraphMatchupInteractionInput,
): GraphMatchupEvidence | undefined {
  if (
    input.actionAgainst.matches <= 0 ||
    input.otherActionsAgainst.matches <= 0 ||
    input.actionWithoutEnemy.matches <= 0 ||
    input.otherActionsWithoutEnemy.matches <= 0
  ) {
    return undefined;
  }

  const matchup = calculateLogOddsRatio(
    input.actionAgainst,
    input.otherActionsAgainst,
  );
  const withoutEnemy = calculateLogOddsRatio(
    input.actionWithoutEnemy,
    input.otherActionsWithoutEnemy,
  );
  const interactionLogOddsRatio = matchup.value - withoutEnemy.value;
  const standardError = Math.sqrt(matchup.variance + withoutEnemy.variance);
  const lower95InteractionLogOddsRatio =
    interactionLogOddsRatio - GRAPH_MATCHUP_CONFIDENCE_Z * standardError;
  const upper95InteractionLogOddsRatio =
    interactionLogOddsRatio + GRAPH_MATCHUP_CONFIDENCE_Z * standardError;

  return {
    enemyHeroId: input.enemyHeroId,
    matchupObservationCount:
      input.actionAgainst.matches + input.otherActionsAgainst.matches,
    actionMatchupObservationCount: input.actionAgainst.matches,
    otherActionMatchupObservationCount: input.otherActionsAgainst.matches,
    actionWinRateAgainst: winRate(input.actionAgainst),
    otherActionsWinRateAgainst: winRate(input.otherActionsAgainst),
    actionWinRateWithoutEnemy: winRate(input.actionWithoutEnemy),
    otherActionsWinRateWithoutEnemy: winRate(input.otherActionsWithoutEnemy),
    interactionLogOddsRatio,
    interactionOddsRatio: Math.exp(interactionLogOddsRatio),
    standardError,
    lower95InteractionLogOddsRatio,
    upper95InteractionLogOddsRatio,
    lower95InteractionOddsRatio: Math.exp(lower95InteractionLogOddsRatio),
    upper95InteractionOddsRatio: Math.exp(upper95InteractionLogOddsRatio),
  };
}

function calculateLogOddsRatio(
  action: GraphOutcomeSample,
  otherActions: GraphOutcomeSample,
): { value: number; variance: number } {
  const actionWins = action.wins + GRAPH_MATCHUP_CONTINUITY_CORRECTION;
  const actionLosses =
    action.matches - action.wins + GRAPH_MATCHUP_CONTINUITY_CORRECTION;
  const otherWins = otherActions.wins + GRAPH_MATCHUP_CONTINUITY_CORRECTION;
  const otherLosses =
    otherActions.matches - otherActions.wins + GRAPH_MATCHUP_CONTINUITY_CORRECTION;

  return {
    value: Math.log(
      (actionWins * otherLosses) / (actionLosses * otherWins),
    ),
    variance:
      1 / actionWins +
      1 / actionLosses +
      1 / otherWins +
      1 / otherLosses,
  };
}

function createStateStats(): MutableGraphStateStats {
  return {
    matches: 0,
    wins: 0,
    byEnemyHeroId: new Map(),
    actionsByKey: new Map(),
  };
}

function createActionStats(): MutableGraphActionStats {
  return {
    matches: 0,
    wins: 0,
    byEnemyHeroId: new Map(),
  };
}

function incrementSample(sample: MutableOutcomeSample, won: boolean): void {
  sample.matches += 1;
  if (won) {
    sample.wins += 1;
  }
}

function incrementEnemySamples(
  samplesByEnemyHeroId: Map<number, MutableOutcomeSample>,
  enemyHeroIds: readonly number[],
  won: boolean,
): void {
  for (const enemyHeroId of enemyHeroIds) {
    const sample = samplesByEnemyHeroId.get(enemyHeroId) ?? emptySample();
    incrementSample(sample, won);
    samplesByEnemyHeroId.set(enemyHeroId, sample);
  }
}

function subtractSamples(
  total: GraphOutcomeSample,
  subset: GraphOutcomeSample,
): GraphOutcomeSample {
  return {
    matches: Math.max(0, total.matches - subset.matches),
    wins: Math.max(0, total.wins - subset.wins),
  };
}

function emptySample(): MutableOutcomeSample {
  return { matches: 0, wins: 0 };
}

function normalizeGepHeroIds(heroIds: readonly number[]): number[] {
  return [...new Set(
    heroIds
      .filter((heroId) => Number.isSafeInteger(heroId) && heroId > 0)
      .map(canonicalHeroId),
  )].sort((left, right) => left - right);
}

function normalizeValveHeroIds(heroIds: readonly number[]): number[] {
  return [...new Set(
    heroIds.filter((heroId) => Number.isSafeInteger(heroId) && heroId > 0),
  )].sort((left, right) => left - right);
}

function winRate(sample: GraphOutcomeSample): number {
  return sample.matches > 0 ? sample.wins / sample.matches : 0;
}

function compareEvidence(
  left: GraphMatchupEvidence,
  right: GraphMatchupEvidence,
): number {
  if (
    left.lower95InteractionLogOddsRatio !==
    right.lower95InteractionLogOddsRatio
  ) {
    return (
      right.lower95InteractionLogOddsRatio -
      left.lower95InteractionLogOddsRatio
    );
  }
  if (left.interactionLogOddsRatio !== right.interactionLogOddsRatio) {
    return right.interactionLogOddsRatio - left.interactionLogOddsRatio;
  }
  return right.matchupObservationCount - left.matchupObservationCount;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
