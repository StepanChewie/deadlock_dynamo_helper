import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  FactEvidence,
  InventoryState,
  InventorySlotType,
  RecommendationDecisionState,
  RecommendationItemDefinition,
  RecommendationItemLineageEdge,
  ShopOpportunity,
  buildInventoryInstancesForRecommendation,
  createRecommendationItemGraph,
} from '@deadlock-live-probe/build-domain';
import {
  AdaptiveActionV1,
  AdaptiveBuildPlanChangeV1,
  AdaptivePlannedItemV1,
  AdaptiveRecommendationResultV1,
  AdaptiveRecommendationStrategyV1,
  AdaptiveScoredActionV1,
} from '@deadlock-live-probe/shared';
import { AdaptiveRecommendationDecisionV1Entity } from '../deadlock-live/entities/adaptive-recommendation-decision-v1.entity';
import {
  UNKNOWN_ADAPTIVE_SLOT_RULES_V1,
  AdaptiveInvestmentStateV1,
  AdaptiveSlotStateV1,
  RecommendationEconomyRulesV1,
  deriveAdaptiveInvestmentStateV1,
  deriveAdaptiveSlotStateV1,
  isCanonicalAdaptiveInvestmentStateV1,
  ADAPTIVE_INVESTMENT_TYPES_V1,
  unknownAdaptiveInvestmentStateV1,
} from './adaptive-economy-v1';
import { ADAPTIVE_POLICY_V1_CONFIG } from './statlocker-adaptive.config';
import {
  AdaptiveBuildPlannerResultV1,
  AdaptiveBuildPlannerV1Service,
} from './adaptive-build-planner-v1.service';
import {
  AdaptiveDecisionStateV1,
  AdaptiveEnemyLiveStateV1,
} from './adaptive-decision-state-v1.service';
import { StatlockerEvidenceBundleV1 } from './statlocker-evidence.service';

export interface AdaptiveReplayObservedFactV1<T> {
  value?: T;
  evidence: FactEvidence;
  source: string;
}

export interface AdaptiveReplayStateV1 {
  decisionId: string;
  matchId: string;
  playerSlot: number;
  gameTimeSec: number;
  rulesetId: string;
  heroId: number;
  ownedItemIds: readonly number[];
  spendableSouls: AdaptiveReplayObservedFactV1<number>;
  shopOpportunity: AdaptiveReplayObservedFactV1<ShopOpportunity>;
}

export interface AdaptiveReplayEnemyHeroV1 {
  heroId: number;
  heroName?: string;
}

export interface AdaptiveReplayDecisionV1 {
  state: AdaptiveReplayStateV1;
  itemDefinitions: readonly RecommendationItemDefinition[];
  /** Optional so replay inputs persisted before topology-only lineage support remain readable. */
  lineageEdges?: readonly RecommendationItemLineageEdge[];
  catalogVersionId: string;
  catalogSha256: string;
  rulesetId: string;
  localSteamId: string;
  /** Optional so replay inputs persisted before strategy context remain readable. */
  allyHeroIds?: readonly number[];
  enemyHeroIds: readonly number[];
  /** Optional so replay inputs persisted before live enemy hero names remain readable. */
  enemyHeroes?: readonly AdaptiveReplayEnemyHeroV1[];
  /** Optional so replay inputs persisted before per-enemy live threat state remain readable. */
  enemyLiveStates?: readonly AdaptiveEnemyLiveStateV1[];
  /** Optional so replay inputs persisted before item-context scoring remain readable. */
  allyItemIds?: readonly number[];
  enemyItemIds?: readonly number[];
  ourTeamSouls?: number;
  enemyTeamSouls?: number;
  slots?: AdaptiveSlotStateV1;
  investment?: AdaptiveInvestmentStateV1;
  economyRules?: RecommendationEconomyRulesV1;
  /** Optional so previously persisted replay inputs remain readable. */
  economyRulesEvidence?: 'RECONSTRUCTED' | 'UNKNOWN';
  stateRevision: string;
}

export type AdaptiveReplayPreviousResultV1 = Pick<
  AdaptiveRecommendationResultV1,
  'recommendedBuild' | 'totalScore' | 'nextAction' | 'confidence' | 'strategy'
>;

export interface AdaptiveReplayInputV1 {
  decision: AdaptiveReplayDecisionV1;
  evidence: StatlockerEvidenceBundleV1;
  previousResult?: AdaptiveReplayPreviousResultV1;
  recentPurchasedItemIds: readonly number[];
  recentSoldItemIds: readonly number[];
  configVersion: string;
  scorerVersion: string;
  plannerVersion: string;
  snapshotIds: readonly string[];
}

export interface PersistAdaptiveDecisionV1 {
  decisionId: string;
  matchId: string;
  playerKey: string;
  stateRevision: string;
  replayInput: AdaptiveReplayInputV1;
  result: AdaptiveRecommendationResultV1;
  decidedAt?: Date;
}

export interface AdaptiveReplayOutputV1 {
  gameState: AdaptiveBuildPlannerResultV1['gameState'];
  nextAction: AdaptiveActionV1;
  recommendedBuild: readonly AdaptivePlannedItemV1[];
  changes: readonly AdaptiveBuildPlanChangeV1[];
  rankedImmediateCandidates: readonly AdaptiveScoredActionV1[];
  totalScore: number;
  confidence: number;
  strategy?: AdaptiveRecommendationStrategyV1;
  snapshotIds: readonly string[];
}

export interface AdaptivePreviousContextV1 {
  result: AdaptiveRecommendationResultV1;
  replayInput: AdaptiveReplayInputV1;
  decisionId: string;
  stateRevision: string;
  decidedAt: Date;
}

@Injectable()
export class AdaptiveReplayV1Service {
  constructor(
    @InjectRepository(AdaptiveRecommendationDecisionV1Entity)
    private readonly repository: Repository<AdaptiveRecommendationDecisionV1Entity>,
    private readonly planner: AdaptiveBuildPlannerV1Service,
  ) {}

  run(input: AdaptiveReplayInputV1): AdaptiveReplayOutputV1 {
    this.assertVersions(input);
    const decision = reconstructDecision(input.decision);
    const result = this.planner.plan({
      decision,
      evidence: input.evidence,
      previousResult: input.previousResult,
      recentPurchasedItemIds: input.recentPurchasedItemIds,
      recentSoldItemIds: input.recentSoldItemIds,
    }) as AdaptiveBuildPlannerResultV1 & { strategy?: AdaptiveRecommendationStrategyV1 };
    return {
      gameState: result.gameState,
      nextAction: result.nextAction,
      recommendedBuild: result.recommendedBuild,
      changes: result.changes,
      rankedImmediateCandidates: result.rankedImmediateCandidates,
      totalScore: result.totalScore,
      confidence: result.confidence,
      strategy: result.strategy,
      snapshotIds: [...input.snapshotIds].sort(),
    };
  }

  async persist(input: PersistAdaptiveDecisionV1): Promise<void> {
    validatePersistInput(input);
    const row = this.repository.create({
      decisionId: input.decisionId,
      matchId: input.matchId,
      playerKey: input.playerKey,
      stateRevision: input.stateRevision,
      replayInput: input.replayInput as unknown as Record<string, unknown>,
      result: input.result as unknown as Record<string, unknown>,
      decidedAt: input.decidedAt ?? new Date(),
    });
    await this.repository.save(row);
  }

  async replayDecision(decisionId: string): Promise<AdaptiveReplayOutputV1> {
    const row = await this.repository.findOne({ where: { decisionId } });
    if (!row) throw new Error(`Adaptive decision not found: ${decisionId}`);
    const input = row.replayInput as unknown as AdaptiveReplayInputV1;
    return this.run(input);
  }

  async getPreviousContext(
    matchId: string,
    playerKey: string,
  ): Promise<AdaptivePreviousContextV1 | undefined> {
    const row = await this.repository.findOne({
      where: { matchId, playerKey },
      order: { decidedAt: 'DESC', decisionId: 'DESC' },
    });
    if (!row) return undefined;
    const result = row.result as unknown as AdaptiveRecommendationResultV1;
    if (!result.ready) return undefined;
    return {
      result,
      replayInput: row.replayInput as unknown as AdaptiveReplayInputV1,
      decisionId: row.decisionId,
      stateRevision: row.stateRevision,
      decidedAt: row.decidedAt,
    };
  }

  async getPreviousPlan(
    matchId: string,
    playerKey: string,
  ): Promise<AdaptiveRecommendationResultV1 | undefined> {
    return (await this.getPreviousContext(matchId, playerKey))?.result;
  }

  toReplayInput(
    decision: AdaptiveDecisionStateV1,
    evidence: StatlockerEvidenceBundleV1,
    options: {
      previousResult?: AdaptiveReplayPreviousResultV1;
      recentPurchasedItemIds?: readonly number[];
      recentSoldItemIds?: readonly number[];
    } = {},
  ): AdaptiveReplayInputV1 {
    return {
      decision: serializeDecision(decision),
      evidence: cloneJson(evidence),
      previousResult: options.previousResult ? cloneJson(options.previousResult) : undefined,
      recentPurchasedItemIds: [...(options.recentPurchasedItemIds ?? [])].sort((a, b) => a - b),
      recentSoldItemIds: [...(options.recentSoldItemIds ?? [])].sort((a, b) => a - b),
      configVersion: ADAPTIVE_POLICY_V1_CONFIG.version,
      scorerVersion: 'adaptive-evidence-scorer-v1',
      plannerVersion: 'adaptive-build-planner-v1',
      snapshotIds: [...evidence.snapshotIds].sort(),
    };
  }

  private assertVersions(input: AdaptiveReplayInputV1): void {
    if (input.configVersion !== ADAPTIVE_POLICY_V1_CONFIG.version) {
      throw new Error(`Unsupported adaptive config version: ${input.configVersion}`);
    }
    if (input.scorerVersion !== 'adaptive-evidence-scorer-v1') {
      throw new Error(`Unsupported adaptive scorer version: ${input.scorerVersion}`);
    }
    if (input.plannerVersion !== this.planner.version) {
      throw new Error(`Unsupported adaptive planner version: ${input.plannerVersion}`);
    }
    const sortedSnapshotIds = [...input.snapshotIds].sort();
    if (JSON.stringify(sortedSnapshotIds) !== JSON.stringify(input.snapshotIds)) {
      throw new Error('Adaptive replay snapshot IDs must be sorted');
    }
  }
}

function serializeDecision(decision: AdaptiveDecisionStateV1): AdaptiveReplayDecisionV1 {
  const itemDefinitions = decision.itemGraph.getAllItems().map((item) => ({
    ...item,
    availableRulesetIds: [...item.availableRulesetIds],
    upgradeRecipes: item.upgradeRecipes.map((recipe) => ({
      ...recipe,
      consumedItemIds: [...recipe.consumedItemIds],
    })),
    sellTransition: item.sellTransition
      ? {
          soulsRefund: item.sellTransition.soulsRefund,
          returnedItemIds: [...item.sellTransition.returnedItemIds],
        }
      : undefined,
  }));
  const itemIds = new Set(itemDefinitions.map((item) => item.itemId));
  const lineageEdges: RecommendationItemLineageEdge[] = itemDefinitions
    .flatMap((item) => decision.itemGraph.getDirectComponentIds(item.itemId)
      .filter((componentItemId) => itemIds.has(componentItemId))
      .map((componentItemId) => ({ parentItemId: item.itemId, componentItemId })))
    .sort((a, b) => a.parentItemId - b.parentItemId || a.componentItemId - b.componentItemId);

  return {
    state: {
      decisionId: decision.state.decisionId,
      matchId: decision.state.matchId,
      playerSlot: decision.state.playerSlot,
      gameTimeSec: decision.state.gameTimeSec,
      rulesetId: decision.state.rulesetId,
      heroId: decision.state.heroId,
      ownedItemIds: [...decision.state.inventory.heldByItemId.keys()].sort((a, b) => a - b),
      spendableSouls: { ...decision.state.economy.spendableSouls },
      shopOpportunity: { ...decision.state.economy.shopOpportunity },
    },
    itemDefinitions,
    lineageEdges,
    catalogVersionId: decision.catalogVersionId,
    catalogSha256: decision.catalogSha256,
    rulesetId: decision.rulesetId,
    localSteamId: decision.localSteamId,
    allyHeroIds: [...(decision.allyHeroIds ?? [])].sort((a, b) => a - b),
    enemyHeroIds: [...decision.enemyHeroIds].sort((a, b) => a - b),
    enemyHeroes: normalizeEnemyHeroes(decision.enemyHeroes, decision.enemyHeroIds),
    enemyLiveStates: normalizeEnemyLiveStates(decision.enemyLiveStates),
    allyItemIds: [...(decision.allyItemIds ?? [])].sort((a, b) => a - b),
    enemyItemIds: [...(decision.enemyItemIds ?? [])].sort((a, b) => a - b),
    ourTeamSouls: decision.ourTeamSouls,
    enemyTeamSouls: decision.enemyTeamSouls,
    slots: cloneJson(decision.slots),
    investment: cloneJson(decision.investment),
    economyRules: decision.economyRules ? cloneJson(decision.economyRules) : undefined,
    economyRulesEvidence: decision.economyRulesEvidence,
    stateRevision: decision.stateRevision,
  };
}

function reconstructDecision(input: AdaptiveReplayDecisionV1): AdaptiveDecisionStateV1 {
  const itemGraph = createRecommendationItemGraph(input.itemDefinitions, input.lineageEdges ?? []);
  const ownedItemIds = [...input.state.ownedItemIds].sort((a, b) => a - b);
  const heldByItemId = buildInventoryInstancesForRecommendation(ownedItemIds, itemGraph);
  const inventory: InventoryState = {
    initializedFromSnapshot: true,
    heldByItemId,
    lifecycleCountByItemId: new Map(ownedItemIds.map((itemId) => [itemId, 1])),
    nextInstanceSequence: heldByItemId.size + 1,
  };
  const state: RecommendationDecisionState = {
    decisionId: input.state.decisionId,
    matchId: input.state.matchId,
    playerSlot: input.state.playerSlot,
    gameTimeSec: input.state.gameTimeSec,
    rulesetId: input.state.rulesetId,
    heroId: input.state.heroId,
    inventory,
    economy: {
      spendableSouls: { ...input.state.spendableSouls },
      shopOpportunity: { ...input.state.shopOpportunity },
    },
  };
  const slots = normalizeReplaySlotStateV1(input.slots, ownedItemIds, itemGraph);
  const economyRules = exactReplayEconomyRulesV1(input);
  const investment = normalizeReplayInvestmentStateV1(
    input.investment,
    ownedItemIds,
    itemGraph,
    economyRules,
  );
  const enemyHeroIds = [...new Set(input.enemyHeroIds)].sort((a, b) => a - b);
  return {
    state,
    itemGraph,
    catalogVersionId: input.catalogVersionId,
    catalogSha256: input.catalogSha256,
    rulesetId: input.rulesetId,
    localSteamId: input.localSteamId,
    allyHeroIds: sortedNumbers(input.allyHeroIds ?? []),
    enemyHeroIds,
    enemyHeroes: normalizeEnemyHeroes(input.enemyHeroes, enemyHeroIds),
    enemyLiveStates: normalizeEnemyLiveStates(input.enemyLiveStates),
    allyItemIds: sortedNumbers(input.allyItemIds ?? []),
    enemyItemIds: sortedNumbers(input.enemyItemIds ?? []),
    ourTeamSouls: input.ourTeamSouls,
    enemyTeamSouls: input.enemyTeamSouls,
    slots,
    investment,
    economyRules: economyRules ? cloneJson(economyRules) : undefined,
    economyRulesEvidence: economyRules ? 'RECONSTRUCTED' : 'UNKNOWN',
    stateRevision: input.stateRevision,
  };
}

function normalizeReplaySlotStateV1(
  supplied: unknown,
  ownedItemIds: readonly number[],
  itemGraph: ReturnType<typeof createRecommendationItemGraph>,
): AdaptiveSlotStateV1 {
  if (isCanonicalReplaySlotStateV1(supplied)) return cloneJson(supplied);
  return deriveAdaptiveSlotStateV1(
    ownedItemIds,
    itemGraph,
    UNKNOWN_ADAPTIVE_SLOT_RULES_V1,
    { evidence: 'UNKNOWN' },
  );
}

function isCanonicalReplaySlotStateV1(value: unknown): value is AdaptiveSlotStateV1 {
  if (!isRecord(value) || !isRecord(value.baseSlotsByType) || !isRecord(value.usedSlotsByType) ||
    !isRecord(value.overflowByType) || !isRecord(value.freeBaseSlotsByType)) return false;
  if (!isNonNegativeInteger(value.baseSlots) || !isNonNegativeInteger(value.maxFlexSlots) ||
    !isNonNegativeInteger(value.maxActiveItems) || !isNonNegativeInteger(value.usedSlots) ||
    !isNonNegativeInteger(value.usedFlexSlots) || !isNonNegativeInteger(value.activeItemsUsed)) return false;
  return allSlotTypesValid(value.baseSlotsByType) && allSlotTypesValid(value.usedSlotsByType) &&
    allSlotTypesValid(value.overflowByType) && allSlotTypesValid(value.freeBaseSlotsByType) &&
    (value.evidence === 'OBSERVED' || value.evidence === 'RECONSTRUCTED' || value.evidence === 'UNKNOWN');
}

function normalizeEnemyHeroes(
  supplied: readonly AdaptiveReplayEnemyHeroV1[] | undefined,
  enemyHeroIds: readonly number[],
): readonly AdaptiveReplayEnemyHeroV1[] {
  const allowed = new Set(enemyHeroIds.filter((heroId) => Number.isInteger(heroId)));
  const byHeroId = new Map<number, AdaptiveReplayEnemyHeroV1>();
  for (const entry of supplied ?? []) {
    if (!Number.isInteger(entry?.heroId) || !allowed.has(entry.heroId)) continue;
    const heroName = typeof entry.heroName === 'string' && entry.heroName.trim()
      ? entry.heroName.trim()
      : undefined;
    byHeroId.set(entry.heroId, heroName ? { heroId: entry.heroId, heroName } : { heroId: entry.heroId });
  }
  for (const heroId of [...allowed].sort((a, b) => a - b)) {
    if (!byHeroId.has(heroId)) byHeroId.set(heroId, { heroId });
  }
  return [...byHeroId.values()].sort((a, b) => a.heroId - b.heroId);
}

function normalizeEnemyLiveStates(
  supplied: readonly AdaptiveEnemyLiveStateV1[] | undefined,
): readonly AdaptiveEnemyLiveStateV1[] {
  return [...cloneJson(supplied ?? [])]
    .sort((a, b) => a.heroId - b.heroId || a.steamId.localeCompare(b.steamId));
}

function normalizeReplayInvestmentStateV1(
  supplied: unknown,
  ownedItemIds: readonly number[],
  itemGraph: ReturnType<typeof createRecommendationItemGraph>,
  economyRules: RecommendationEconomyRulesV1 | undefined,
): AdaptiveInvestmentStateV1 {
  if (isCanonicalAdaptiveInvestmentStateV1(supplied)) return cloneJson(supplied);
  if (economyRules) return deriveAdaptiveInvestmentStateV1(ownedItemIds, itemGraph, economyRules);
  return unknownAdaptiveInvestmentStateV1();
}

function exactReplayEconomyRulesV1(input: AdaptiveReplayDecisionV1): RecommendationEconomyRulesV1 | undefined {
  const rules = input.economyRules;
  if (!isRecord(rules) || rules.rulesetId !== input.rulesetId || rules.catalogSha256 !== input.catalogSha256 ||
    !isSlotCountRecord(rules.baseSlotsByType) ||
    !isNonNegativeInteger(rules.maxFlexSlots) ||
    !isNonNegativeInteger(rules.maxActiveItems) ||
    !isRecord(rules.investmentBreakpoints)) return undefined;
  const validBreakpoints = ADAPTIVE_INVESTMENT_TYPES_V1.every((type) => {
    const values = rules.investmentBreakpoints[type];
    return Array.isArray(values) && values.every((value) =>
      typeof value === 'number' && Number.isFinite(value) && value > 0,
    );
  });
  const baseTotal = (['weapon', 'vitality', 'spirit'] as const)
    .reduce((sum, type) => sum + Number(rules.baseSlotsByType[type]), 0);
  const baseAggregateValid = rules.baseSlots === undefined ||
    (isNonNegativeInteger(rules.baseSlots) && baseTotal === rules.baseSlots);
  return validBreakpoints && baseAggregateValid ? rules as unknown as RecommendationEconomyRulesV1 : undefined;
}

function allSlotTypesValid(value: Record<string, unknown>): boolean {
  return (['weapon', 'vitality', 'spirit'] as readonly InventorySlotType[])
    .every((type) => isNonNegativeInteger(value[type]));
}

function sortedNumbers(values: readonly number[]): number[] {
  return [...new Set(values.filter((value) => Number.isInteger(value)))].sort((a, b) => a - b);
}

function isSlotCountRecord(value: unknown): value is Record<'weapon' | 'vitality' | 'spirit', number> {
  if (!isRecord(value)) return false;
  return ['weapon', 'vitality', 'spirit'].every((type) => isNonNegativeInteger(value[type]));
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function validatePersistInput(input: PersistAdaptiveDecisionV1): void {
  if (!input.decisionId || !input.matchId || !input.playerKey || !/^[a-f0-9]{64}$/i.test(input.stateRevision) && !input.stateRevision.startsWith('revision-')) {
    throw new Error('Adaptive persisted decision identity is invalid');
  }
  if (input.result.decisionId !== input.decisionId) {
    throw new Error('Adaptive persisted result decisionId mismatch');
  }
  if (input.result.stateRevision !== input.stateRevision) {
    throw new Error('Adaptive persisted result stateRevision mismatch');
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
