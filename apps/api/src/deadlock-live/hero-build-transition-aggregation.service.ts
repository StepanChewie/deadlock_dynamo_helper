import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type {
  CanonicalBuildActionType,
  CanonicalPlayerBuildSequence,
} from './canonical-build-sequence.service';
import {
  CanonicalBuildSequenceService,
  EMPTY_INVENTORY_STATE_KEY,
} from './canonical-build-sequence.service';
import { InventoryTimelineReplayService } from './inventory-timeline-replay.service';
import { MatchTimelineNormalizationService } from './match-timeline-normalization.service';
import { RecentMatchesWindowService } from './recent-matches-window.service';
import { RecipeAwareTimelineReconciliationService } from './recipe-aware-timeline-reconciliation.service';

export const HERO_BUILD_POLICY_REFRESH_CHECK_INTERVAL_MS = 60_000;

export interface HeroBuildPolicyAfterState {
  afterStateKey: string;
  count: number;
  probability: number;
}

export interface HeroBuildPolicyNextAction {
  actionType: CanonicalBuildActionType;
  itemId: number;
  actionKey: string;
  count: number;
  probability: number;
  averageGameTimeS: number;
  afterStates: HeroBuildPolicyAfterState[];
}

export interface HeroBuildPolicyState {
  heroId: number;
  stateKey: string;
  observationCount: number;
  nextActionCount: number;
  nextActions: HeroBuildPolicyNextAction[];
}

export interface HeroBuildPolicy {
  heroId: number;
  playerCount: number;
  stateCount: number;
  transitionCount: number;
  statesByKey: ReadonlyMap<string, HeroBuildPolicyState>;
}

export interface HeroBuildPolicyAggregationSnapshot {
  sourcePlayerCount: number;
  includedPlayerCount: number;
  excludedPlayerCount: number;
  heroCount: number;
  stateCount: number;
  transitionCount: number;
  actionOptionCount: number;
  policiesByHeroId: ReadonlyMap<number, HeroBuildPolicy>;
}

export interface HeroBuildTransitionAggregationStatus {
  refreshCheckIntervalMs: number;
  matchCount: number;
  sourcePlayerCount: number;
  includedPlayerCount: number;
  excludedPlayerCount: number;
  heroCount: number;
  stateCount: number;
  transitionCount: number;
  actionOptionCount: number;
  lastRefreshDurationMs: number;
  sourceWindowLastRefreshedAt?: Date;
  lastRefreshedAt?: Date;
  lastError?: string;
}

export interface HeroBuildNextActionsResponse {
  heroId: number;
  stateKey: string;
  found: boolean;
  observationCount: number;
  availableActionCount: number;
  returnedActionCount: number;
  coverageProbability: number;
  nextActions: HeroBuildPolicyNextAction[];
  sourceWindowLastRefreshedAt?: Date;
  lastRefreshedAt?: Date;
}

interface MutableActionAggregate {
  actionType: CanonicalBuildActionType;
  itemId: number;
  actionKey: string;
  count: number;
  totalGameTimeS: number;
  afterStateCounts: Map<string, number>;
}

interface MutableStateAggregate {
  observationCount: number;
  actionsByKey: Map<string, MutableActionAggregate>;
}

interface MutableHeroAggregate {
  playerCount: number;
  transitionCount: number;
  statesByKey: Map<string, MutableStateAggregate>;
}

export class HeroBuildTransitionAccumulator {
  private readonly heroesById = new Map<number, MutableHeroAggregate>();
  private sourcePlayerCount = 0;
  private includedPlayerCount = 0;
  private excludedPlayerCount = 0;

  addPlayer(sequence: CanonicalPlayerBuildSequence): void {
    this.sourcePlayerCount += 1;

    if (
      !Number.isSafeInteger(sequence.heroId) ||
      sequence.heroId <= 0 ||
      sequence.replayDiagnosticCount > 0 ||
      sequence.steps.length === 0
    ) {
      this.excludedPlayerCount += 1;
      return;
    }

    this.includedPlayerCount += 1;
    const hero = this.heroesById.get(sequence.heroId) ?? {
      playerCount: 0,
      transitionCount: 0,
      statesByKey: new Map<string, MutableStateAggregate>(),
    };
    hero.playerCount += 1;

    for (const step of sequence.steps) {
      const state = hero.statesByKey.get(step.beforeStateKey) ?? {
        observationCount: 0,
        actionsByKey: new Map<string, MutableActionAggregate>(),
      };
      state.observationCount += 1;

      const action = state.actionsByKey.get(step.actionKey) ?? {
        actionType: step.actionType,
        itemId: step.itemId,
        actionKey: step.actionKey,
        count: 0,
        totalGameTimeS: 0,
        afterStateCounts: new Map<string, number>(),
      };
      action.count += 1;
      action.totalGameTimeS += step.gameTimeS;
      action.afterStateCounts.set(
        step.afterStateKey,
        (action.afterStateCounts.get(step.afterStateKey) ?? 0) + 1,
      );

      state.actionsByKey.set(step.actionKey, action);
      hero.statesByKey.set(step.beforeStateKey, state);
      hero.transitionCount += 1;
    }

    this.heroesById.set(sequence.heroId, hero);
  }

  build(): HeroBuildPolicyAggregationSnapshot {
    const policiesByHeroId = new Map<number, HeroBuildPolicy>();
    let stateCount = 0;
    let transitionCount = 0;
    let actionOptionCount = 0;

    for (const [heroId, mutableHero] of this.heroesById) {
      const statesByKey = new Map<string, HeroBuildPolicyState>();

      for (const [stateKey, mutableState] of mutableHero.statesByKey) {
        const nextActions = [...mutableState.actionsByKey.values()]
          .map((action): HeroBuildPolicyNextAction => {
            const afterStates = [...action.afterStateCounts.entries()]
              .map(([afterStateKey, count]): HeroBuildPolicyAfterState => ({
                afterStateKey,
                count,
                probability: count / action.count,
              }))
              .sort(compareAfterStates);
            action.afterStateCounts.clear();

            return {
              actionType: action.actionType,
              itemId: action.itemId,
              actionKey: action.actionKey,
              count: action.count,
              probability: action.count / mutableState.observationCount,
              averageGameTimeS: action.totalGameTimeS / action.count,
              afterStates,
            };
          })
          .sort(compareNextActions);

        mutableState.actionsByKey.clear();
        statesByKey.set(stateKey, {
          heroId,
          stateKey,
          observationCount: mutableState.observationCount,
          nextActionCount: nextActions.length,
          nextActions,
        });
        actionOptionCount += nextActions.length;
      }

      mutableHero.statesByKey.clear();
      const policy: HeroBuildPolicy = {
        heroId,
        playerCount: mutableHero.playerCount,
        stateCount: statesByKey.size,
        transitionCount: mutableHero.transitionCount,
        statesByKey,
      };
      policiesByHeroId.set(heroId, policy);
      stateCount += policy.stateCount;
      transitionCount += policy.transitionCount;
    }

    this.heroesById.clear();
    return {
      sourcePlayerCount: this.sourcePlayerCount,
      includedPlayerCount: this.includedPlayerCount,
      excludedPlayerCount: this.excludedPlayerCount,
      heroCount: policiesByHeroId.size,
      stateCount,
      transitionCount,
      actionOptionCount,
      policiesByHeroId,
    };
  }
}

@Injectable()
export class HeroBuildTransitionAggregationService implements OnModuleInit {
  private readonly logger = new Logger(HeroBuildTransitionAggregationService.name);
  private policiesByHeroId = new Map<number, HeroBuildPolicy>();
  private refreshPromise?: Promise<HeroBuildTransitionAggregationStatus>;
  private matchCount = 0;
  private sourcePlayerCount = 0;
  private includedPlayerCount = 0;
  private excludedPlayerCount = 0;
  private stateCount = 0;
  private transitionCount = 0;
  private actionOptionCount = 0;
  private lastRefreshDurationMs = 0;
  private sourceWindowLastRefreshedAt?: Date;
  private lastRefreshedAt?: Date;
  private lastError?: string;

  constructor(
    private readonly recentMatchesWindowService: RecentMatchesWindowService,
    private readonly matchTimelineNormalizationService: MatchTimelineNormalizationService,
    private readonly inventoryTimelineReplayService: InventoryTimelineReplayService,
    private readonly canonicalBuildSequenceService: CanonicalBuildSequenceService,
    private readonly recipeAwareTimelineReconciliationService: RecipeAwareTimelineReconciliationService,
  ) {}

  onModuleInit(): void {
    this.refreshInBackground('initial');
  }

  @Interval(
    'hero-build-transition-policy-refresh-check',
    HERO_BUILD_POLICY_REFRESH_CHECK_INTERVAL_MS,
  )
  refreshOnInterval(): void {
    void this.refreshIfSourceChanged().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to refresh hero build transition policy: ${message}`);
    });
  }

  async ensureReady(_heroId?: number): Promise<void> {
    let sourceStatus = this.recentMatchesWindowService.getStatus();
    if (!sourceStatus.lastRefreshedAt) {
      sourceStatus = await this.recentMatchesWindowService.refresh();
    }

    if (
      !this.lastRefreshedAt ||
      !sameInstant(this.sourceWindowLastRefreshedAt, sourceStatus.lastRefreshedAt)
    ) {
      await this.refresh();
    }
  }

  async refresh(): Promise<HeroBuildTransitionAggregationStatus> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.buildPolicy();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = undefined;
    }
  }

  getStatus(): HeroBuildTransitionAggregationStatus {
    return {
      refreshCheckIntervalMs: HERO_BUILD_POLICY_REFRESH_CHECK_INTERVAL_MS,
      matchCount: this.matchCount,
      sourcePlayerCount: this.sourcePlayerCount,
      includedPlayerCount: this.includedPlayerCount,
      excludedPlayerCount: this.excludedPlayerCount,
      heroCount: this.policiesByHeroId.size,
      stateCount: this.stateCount,
      transitionCount: this.transitionCount,
      actionOptionCount: this.actionOptionCount,
      lastRefreshDurationMs: this.lastRefreshDurationMs,
      sourceWindowLastRefreshedAt: cloneDate(this.sourceWindowLastRefreshedAt),
      lastRefreshedAt: cloneDate(this.lastRefreshedAt),
      lastError: this.lastError,
    };
  }

  getHeroPolicy(heroId: number): HeroBuildPolicy | undefined {
    return this.policiesByHeroId.get(heroId);
  }

  getNextActions(
    heroId: number,
    stateKey: string,
    limit = 10,
    minCount = 1,
  ): HeroBuildNextActionsResponse {
    const state = this.policiesByHeroId.get(heroId)?.statesByKey.get(stateKey);
    if (!state) {
      return {
        heroId,
        stateKey,
        found: false,
        observationCount: 0,
        availableActionCount: 0,
        returnedActionCount: 0,
        coverageProbability: 0,
        nextActions: [],
        sourceWindowLastRefreshedAt: cloneDate(this.sourceWindowLastRefreshedAt),
        lastRefreshedAt: cloneDate(this.lastRefreshedAt),
      };
    }

    const eligibleActions = state.nextActions.filter((action) => action.count >= minCount);
    const nextActions = eligibleActions.slice(0, limit).map(cloneNextAction);

    return {
      heroId,
      stateKey,
      found: true,
      observationCount: state.observationCount,
      availableActionCount: eligibleActions.length,
      returnedActionCount: nextActions.length,
      coverageProbability: nextActions.reduce((total, action) => total + action.probability, 0),
      nextActions,
      sourceWindowLastRefreshedAt: cloneDate(this.sourceWindowLastRefreshedAt),
      lastRefreshedAt: cloneDate(this.lastRefreshedAt),
    };
  }

  private refreshInBackground(trigger: 'initial'): void {
    void this.refresh().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to build hero policy on ${trigger} refresh: ${message}`);
    });
  }

  private async refreshIfSourceChanged(): Promise<void> {
    const sourceStatus = this.recentMatchesWindowService.getStatus();
    if (!sourceStatus.lastRefreshedAt) {
      await this.ensureReady();
      return;
    }

    if (!sameInstant(this.sourceWindowLastRefreshedAt, sourceStatus.lastRefreshedAt)) {
      await this.refresh();
    }
  }

  private async buildPolicy(): Promise<HeroBuildTransitionAggregationStatus> {
    const startedAt = Date.now();

    try {
      let sourceStatus = this.recentMatchesWindowService.getStatus();
      if (!sourceStatus.lastRefreshedAt) {
        sourceStatus = await this.recentMatchesWindowService.refresh();
      }

      try {
        await this.recipeAwareTimelineReconciliationService.refreshRecipes();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Using the existing recipe cache for policy aggregation: ${message}`);
      }

      const matchIds = this.recentMatchesWindowService.getMatchIds();
      const accumulator = new HeroBuildTransitionAccumulator();
      let processedMatchCount = 0;

      for (const matchId of matchIds) {
        const match = this.recentMatchesWindowService.getMatch(matchId);
        if (!match) {
          continue;
        }

        const timelines = this.matchTimelineNormalizationService.normalizeMatch(match);
        const replay = this.inventoryTimelineReplayService.replayMatch(timelines);
        const sequences = this.canonicalBuildSequenceService.canonicalizeMatch(replay);
        for (const player of sequences.players) {
          accumulator.addPlayer(player);
        }
        processedMatchCount += 1;
      }

      const snapshot = accumulator.build();
      this.policiesByHeroId = new Map(snapshot.policiesByHeroId);
      this.matchCount = processedMatchCount;
      this.sourcePlayerCount = snapshot.sourcePlayerCount;
      this.includedPlayerCount = snapshot.includedPlayerCount;
      this.excludedPlayerCount = snapshot.excludedPlayerCount;
      this.stateCount = snapshot.stateCount;
      this.transitionCount = snapshot.transitionCount;
      this.actionOptionCount = snapshot.actionOptionCount;
      this.sourceWindowLastRefreshedAt = cloneDate(sourceStatus.lastRefreshedAt);
      this.lastRefreshedAt = new Date();
      this.lastRefreshDurationMs = Date.now() - startedAt;
      this.lastError = undefined;

      this.logger.log(
        `Built hero build transition policy from ${this.matchCount} matches and ` +
          `${this.includedPlayerCount}/${this.sourcePlayerCount} players: ` +
          `${this.policiesByHeroId.size} heroes, ${this.stateCount} states and ` +
          `${this.transitionCount} transitions in ${this.lastRefreshDurationMs} ms.`,
      );

      return this.getStatus();
    } catch (error) {
      this.lastRefreshDurationMs = Date.now() - startedAt;
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }
}

export function aggregateCanonicalBuildSequences(
  sequences: readonly CanonicalPlayerBuildSequence[],
): HeroBuildPolicyAggregationSnapshot {
  const accumulator = new HeroBuildTransitionAccumulator();
  for (const sequence of sequences) {
    accumulator.addPlayer(sequence);
  }
  return accumulator.build();
}

export function createInventoryStateKeyFromItemIds(itemIds: readonly number[]): string {
  if (itemIds.length === 0) {
    return EMPTY_INVENTORY_STATE_KEY;
  }

  const countByItemId = new Map<number, number>();
  for (const itemId of itemIds) {
    countByItemId.set(itemId, (countByItemId.get(itemId) ?? 0) + 1);
  }

  return [...countByItemId.entries()]
    .sort(([leftItemId], [rightItemId]) => leftItemId - rightItemId)
    .map(([itemId, count]) => `${itemId}x${count}`)
    .join('|');
}

function compareNextActions(
  left: HeroBuildPolicyNextAction,
  right: HeroBuildPolicyNextAction,
): number {
  if (left.count !== right.count) {
    return right.count - left.count;
  }
  return left.actionKey.localeCompare(right.actionKey);
}

function compareAfterStates(
  left: HeroBuildPolicyAfterState,
  right: HeroBuildPolicyAfterState,
): number {
  if (left.count !== right.count) {
    return right.count - left.count;
  }
  return left.afterStateKey.localeCompare(right.afterStateKey);
}

function cloneNextAction(action: HeroBuildPolicyNextAction): HeroBuildPolicyNextAction {
  return {
    ...action,
    afterStates: action.afterStates.map((afterState) => ({ ...afterState })),
  };
}

function sameInstant(left: Date | undefined, right: Date | undefined): boolean {
  if (!left || !right) {
    return left === right;
  }
  return left.getTime() === right.getTime();
}

function cloneDate(value: Date | undefined): Date | undefined {
  return value ? new Date(value) : undefined;
}
