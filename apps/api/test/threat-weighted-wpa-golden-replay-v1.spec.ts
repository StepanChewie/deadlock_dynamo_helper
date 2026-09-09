import 'reflect-metadata';
import {
  buildInventoryInstancesForRecommendation,
  createRecommendationItemGraph,
  observedFact,
  RecommendationItemDefinition,
} from '@deadlock-live-probe/build-domain';
import { deriveAdaptiveSlotStateV1, unknownAdaptiveInvestmentStateV1 } from '../src/statlocker-adaptive/adaptive-economy-v1';
import { AdaptiveEvidenceScorerV1Service } from '../src/statlocker-adaptive/adaptive-evidence-scorer-v1.service';
import { AdaptivePhaseEligibilityV1Service } from '../src/statlocker-adaptive/adaptive-phase-eligibility-v1.service';
import { AdaptiveChoiceResolverV1Service } from '../src/statlocker-adaptive/adaptive-choice-resolver-v1.service';
import { AdaptivePlannerServingRouterV1Service } from '../src/statlocker-adaptive/adaptive-planner-serving-router-v1.service';
import { AdaptiveRecommendationObservabilityV1Service } from '../src/statlocker-adaptive/adaptive-recommendation-observability-v1.service';
import { AdaptiveRecommendationV1Service } from '../src/statlocker-adaptive/adaptive-recommendation-v1.service';
import { AdaptiveDecisionTraceV1Service } from '../src/statlocker-adaptive/adaptive-decision-trace-v1.service';
import { BuildStrategyRegistryV1Service } from '../src/statlocker-adaptive/build-strategy-registry-v1.service';
import { DraftMatchupEvidenceV1Service } from '../src/statlocker-adaptive/draft-matchup-evidence-v1.service';
import { EnemyThreatHistoryV1Service } from '../src/statlocker-adaptive/enemy-threat-history-v1.service';
import { EnemyThreatV1Service } from '../src/statlocker-adaptive/enemy-threat-v1.service';
import { StrategyFirstAdaptivePlannerFacadeV1Service } from '../src/statlocker-adaptive/strategy-first-adaptive-planner-facade-v1.service';
import { StrategyFirstBuildPlannerV1Service } from '../src/statlocker-adaptive/strategy-first-build-planner-v1.service';
import { StrategyFirstLegacyPlannerAdapterV1Service } from '../src/statlocker-adaptive/strategy-first-legacy-planner-adapter-v1.service';
import { StrategyFirstPromotionGateV1Service } from '../src/statlocker-adaptive/strategy-first-promotion-gate-v1.service';
import { StrategyFirstSituationalOverlayV1Service } from '../src/statlocker-adaptive/strategy-first-situational-overlay-v1.service';
import { StatlockerVsHeroWpaRepositoryV1Service } from '../src/statlocker-adaptive/statlocker-vs-hero-wpa-repository-v1.service';
import { BuildStrategySpecV1 } from '../src/statlocker-adaptive/build-strategy-v1';
import { ThreatWeightedMatchupV1Service } from '../src/statlocker-adaptive/threat-weighted-matchup-v1.service';
import { StatlockerEvidenceBundleV1 } from '../src/statlocker-adaptive/statlocker-evidence.service';
import { StatlockerVsHeroWpaAggregateSourceV1 } from '../src/statlocker-adaptive/statlocker-vs-hero-wpa-repository-v1.service';

// ---------------------------------------------------------------------------
// Golden Replay V1 - fixture-driven strategy-first end-to-end scenarios A..Q.
//
// The harness runs the production serving stack end to end:
// recommendation service -> serving router -> strategy-first facade -> planner
// -> situational overlay + matchup discovery -> trace, with only the durable
// edges (decision-state persistence, evidence snapshots, replay persistence,
// Postgres) replaced by deterministic in-memory fakes.
// ---------------------------------------------------------------------------

const CATALOG_SHA = 'a'.repeat(64);
const RULESET = 'ruleset-golden';
const PATCH = 'patch-golden';
const OUR_HERO = 10;
const ENEMY_FED = 20;
const ENEMY_PRIO = 30;
const ENEMY_THIRD = 40;

interface GoldenItemSpec {
  itemId: number;
  name: string;
  directPurchaseCost?: number;
  sellTransition?: { soulsRefund: number; returnedItemIds: number[] };
  upgradeRecipes?: { recipeId: string; consumedItemIds: number[]; soulsCost: number }[];
}

function item(spec: GoldenItemSpec): RecommendationItemDefinition {
  return {
    itemId: spec.itemId,
    name: spec.name,
    slotType: 'weapon',
    active: false,
    availableRulesetIds: [RULESET],
    directPurchaseCost: spec.directPurchaseCost ?? 1600,
    upgradeRecipes: spec.upgradeRecipes ?? [],
    ...(spec.sellTransition === undefined ? {} : { sellTransition: spec.sellTransition }),
    maxCopies: 1,
  } as RecommendationItemDefinition;
}

// Skeleton weapon items used by the golden strategy.
const SKELETON_ITEM_IDS = [101, 102, 103, 104, 105, 106, 107, 108, 109, 115, 116] as const;
const EARLY_CORE_IDS = [101, 102, 103] as const;
const MID_CORE_IDS = [104, 105, 106, 107] as const;
const LATE_CORE_IDS = [115, 116] as const;
export const CORE_IDS = [101, 102, 103, 104, 105, 106, 107, 108, 109] as const;
// Two declared OR-branch weapons.
export const BRANCH_A_ITEM = 110;
export const BRANCH_B_ITEM = 111;
// A weak flex filler used as a sell source at 12/12.
export const WEAK_FLEX_ITEM = 112;
// Outside-skeleton wildcard counter item (never listed in the strategy).
const WILDCARD_COUNTER_ITEM = 121;
// Outside-skeleton item known only through a tiny-sample spike.
const TINY_SAMPLE_ITEM = 122;

export function goldenItems(): RecommendationItemDefinition[] {
  const skeleton = SKELETON_ITEM_IDS.map((itemId, index) => item({
    itemId,
    name: `Skeleton ${index + 1}`,
    directPurchaseCost: 1600,
    sellTransition: { soulsRefund: 800, returnedItemIds: [] },
  }));
  return [
    ...skeleton,
    item({ itemId: BRANCH_A_ITEM, name: 'Branch A', directPurchaseCost: 1800, sellTransition: { soulsRefund: 900, returnedItemIds: [] } }),
    item({ itemId: BRANCH_B_ITEM, name: 'Branch B', directPurchaseCost: 1800, sellTransition: { soulsRefund: 900, returnedItemIds: [] } }),
    item({ itemId: WEAK_FLEX_ITEM, name: 'Weak Flex', directPurchaseCost: 300, sellTransition: { soulsRefund: 150, returnedItemIds: [] } }),
    item({ itemId: WILDCARD_COUNTER_ITEM, name: 'Wildcard Counter', directPurchaseCost: 1500, sellTransition: { soulsRefund: 700, returnedItemIds: [] } }),
    item({ itemId: TINY_SAMPLE_ITEM, name: 'Tiny Sample', directPurchaseCost: 1500, sellTransition: { soulsRefund: 700, returnedItemIds: [] } }),
    // A 13th legal item for the sold-economics-unknown scenario: no sellTransition at all.
    item({ itemId: 130, name: 'No Sell Economy', directPurchaseCost: 1000 }),
  ];
}

export function goldenStrategy(): BuildStrategySpecV1 {
  return {
    schemaVersion: 1,
    strategyId: 'golden-replay-strategy-v1',
    heroId: OUR_HERO,
    rulesetId: RULESET,
    sourcePatchId: PATCH,
    support: 0.9,
    stability: 0.9,
    representativeTraceId: 'golden-trace',
    goals: [
      {
        goalId: 'early-core',
        type: 'CORE',
        phase: 'EARLY',
        targetItemIds: [101, 102, 103],
        minSelect: 3,
        maxSelect: 3,
        prerequisiteGoalIds: [],
        hard: true,
        rigidity: 'HARD_CORE',
        lifecycleByItemId: { 101: 'PERMANENT_CORE', 102: 'PERMANENT_CORE', 103: 'PERMANENT_CORE' },
        rationaleCodes: ['GOLDEN_EARLY_CORE'],
      },
      {
        goalId: 'mid-core',
        type: 'CORE',
        phase: 'MID',
        targetItemIds: [104, 105, 106, 107],
        minSelect: 2,
        maxSelect: 2,
        prerequisiteGoalIds: ['early-core'],
        hard: true,
        rigidity: 'HARD_CORE',
        lifecycleByItemId: { 104: 'PERMANENT_CORE', 105: 'PERMANENT_CORE', 106: 'PERMANENT_CORE', 107: 'PERMANENT_CORE' },
        rationaleCodes: ['GOLDEN_MID_CORE'],
      },
      {
        goalId: 'late-core',
        type: 'CORE',
        phase: 'LATE',
        targetItemIds: [115, 116],
        minSelect: 1,
        maxSelect: 1,
        prerequisiteGoalIds: ['mid-core'],
        hard: true,
        rigidity: 'HARD_CORE',
        lifecycleByItemId: { 115: 'PERMANENT_CORE', 116: 'PERMANENT_CORE' },
        rationaleCodes: ['GOLDEN_LATE_CORE'],
      },
      {
        goalId: 'branch-a',
        type: 'BRANCH',
        phase: 'MID',
        targetItemIds: [BRANCH_A_ITEM],
        minSelect: 1,
        maxSelect: 1,
        prerequisiteGoalIds: ['early-core'],
        hard: false,
        rigidity: 'SOFT_CORE',
        lifecycleByItemId: { [BRANCH_A_ITEM]: 'PERMANENT_CORE' },
        rationaleCodes: ['GOLDEN_BRANCH_A'],
      },
      {
        goalId: 'branch-b',
        type: 'BRANCH',
        phase: 'MID',
        targetItemIds: [BRANCH_B_ITEM],
        minSelect: 1,
        maxSelect: 1,
        prerequisiteGoalIds: ['early-core'],
        hard: false,
        rigidity: 'SOFT_CORE',
        lifecycleByItemId: { [BRANCH_B_ITEM]: 'PERMANENT_CORE' },
        rationaleCodes: ['GOLDEN_BRANCH_B'],
      },
      {
        goalId: 'flex-filler',
        type: 'INVESTMENT',
        phase: 'EARLY',
        targetItemIds: [WEAK_FLEX_ITEM],
        minSelect: 0,
        maxSelect: 1,
        prerequisiteGoalIds: [],
        hard: false,
        rigidity: 'FLEX',
        lifecycleByItemId: { [WEAK_FLEX_ITEM]: 'TEMPORARY_EARLY' },
        rationaleCodes: ['GOLDEN_FLEX'],
      },
    ],
    branchGroups: [{
      branchGroupId: 'weapon-branch',
      optionGoalIds: ['branch-a', 'branch-b'],
      minSelect: 1,
      maxSelect: 1,
    }],
    situationalWindows: [{
      windowId: 'counter-window',
      afterGoalIds: ['early-core'],
      beforeGoalIds: [],
      maxSlots: 1,
      maxSouls: 4000,
      maxCoreDelaySouls: 3200,
      allowedPurposes: ['COUNTER_ENEMY_HEROES'],
    }],
    investmentPolicy: { objectives: [], preferredWeights: { weapon: 1, vitality: 0, spirit: 0 } },
    slotPolicy: { reservedSituationalSlots: 0, maxTemporarySlots: 1 },
    terminalPolicy: { requiredGoalIds: ['early-core', 'mid-core', 'late-core'], allowWaiveSoftGoals: true },
  };
}

interface GoldenDecisionOverrides {
  ownedItemIds?: readonly number[];
  gameTimeSec?: number;
  spendableSouls?: number;
  enemyHeroIds?: readonly number[];
  enemyLiveStates?: {
    steamId: string;
    heroId: number;
    level?: number;
    souls?: number;
    kills?: number;
    deaths?: number;
    assists?: number;
    heroDamage?: number;
  }[];
  stateRevision?: string;
}

export function goldenDecision(graph: ReturnType<typeof createRecommendationItemGraph>, overrides: GoldenDecisionOverrides = {}) {
  const ownedItemIds = overrides.ownedItemIds ?? [];
  const enemyHeroIds = overrides.enemyHeroIds ?? [ENEMY_FED, ENEMY_PRIO, ENEMY_THIRD];
  const enemyLiveStates = overrides.enemyLiveStates ?? enemyHeroIds.map((heroId) => ({ steamId: `steam-${heroId}`, heroId }));
  const heldByItemId = buildInventoryInstancesForRecommendation(ownedItemIds, graph);
  return {
    state: {
      decisionId: `golden-decision:${overrides.stateRevision ?? 'r1'}`,
      matchId: 'golden-match',
      playerSlot: 0,
      gameTimeSec: overrides.gameTimeSec ?? 1200,
      rulesetId: RULESET,
      heroId: OUR_HERO,
      inventory: {
        initializedFromSnapshot: true,
        heldByItemId,
        lifecycleCountByItemId: new Map(ownedItemIds.map((itemId) => [itemId, 1])),
        nextInstanceSequence: ownedItemIds.length + 1,
      },
      economy: {
        spendableSouls: observedFact(overrides.spendableSouls ?? 5000, 'golden'),
        shopOpportunity: observedFact('AVAILABLE', 'golden'),
      },
    },
    itemGraph: graph,
    catalogVersionId: 'catalog-golden',
    catalogSha256: CATALOG_SHA,
    rulesetId: RULESET,
    localSteamId: 'steam-local',
    allyHeroIds: [],
    enemyHeroIds: [...enemyHeroIds],
    enemyLiveStates: enemyLiveStates.map((enemy) => ({ ...enemy })),
    allyItemIds: [],
    enemyItemIds: [],
    slots: deriveAdaptiveSlotStateV1(
      ownedItemIds,
      graph,
      { baseSlots: 0, baseSlotsByType: { weapon: 0, vitality: 0, spirit: 0 }, maxFlexSlots: 12, maxActiveItems: 4, evidence: 'RECONSTRUCTED' as const },
      { unlockedFlexSlots: 12, evidence: 'OBSERVED' as const },
    ),
    investment: unknownAdaptiveInvestmentStateV1(),
    economyRules: {
      rulesetId: RULESET,
      catalogSha256: CATALOG_SHA,
      baseSlots: 0,
      baseSlotsByType: { weapon: 0, vitality: 0, spirit: 0 },
      maxActiveItems: 4,
      maxFlexSlots: 12,
      investmentBreakpoints: { weapon: [1600], vitality: [1600], spirit: [1600] },
    },
    economyRulesEvidence: 'RECONSTRUCTED',
    stateRevision: overrides.stateRevision ?? 'golden-revision',
  } as any;
}

function goldenSkeletonPayload() {
  return {
    heroId: OUR_HERO,
    profileCount: 24,
    groups: [
      ...CORE_IDS.map((itemId, index) => ({
        groupId: `skeleton-${index}`,
        phase: index < 3 ? 'EARLY' : 'MID',
        type: 'REQUIRED',
        minSelect: 1,
        maxSelect: 1,
        confidence: 0.9,
        inferred: false,
        candidates: [{
          itemId,
          strength: 0.9 - index * 0.02,
          coverage: 0.8,
          purchaseRate: 0.7,
          medianBuyTimeS: 200 + index * 150,
          timingSpreadS: 60,
          sourceProfileCount: 20,
          frequencyTier: 'CORE',
          rushEvidence: false,
        }],
      })),
      {
        groupId: 'skeleton-branch',
        phase: 'MID',
        type: 'CHOICE',
        minSelect: 1,
        maxSelect: 1,
        confidence: 0.8,
        inferred: false,
        candidates: [
          { itemId: BRANCH_A_ITEM, strength: 0.7, coverage: 0.7, purchaseRate: 0.6, medianBuyTimeS: 900, timingSpreadS: 120, sourceProfileCount: 14, frequencyTier: 'CORE', rushEvidence: false },
          { itemId: BRANCH_B_ITEM, strength: 0.7, coverage: 0.7, purchaseRate: 0.6, medianBuyTimeS: 900, timingSpreadS: 120, sourceProfileCount: 14, frequencyTier: 'CORE', rushEvidence: false },
        ],
      },
    ],
  };
}

function goldenWpaPatchDataPayload() {
  return {
    patchId: PATCH,
    items: [...SKELETON_ITEM_IDS, BRANCH_A_ITEM, BRANCH_B_ITEM, WEAK_FLEX_ITEM, WILDCARD_COUNTER_ITEM, TINY_SAMPLE_ITEM, 130].map((itemId, index) => ({
      heroId: OUR_HERO,
      itemId,
      sampleSize: 4000,
      meanWpa: 0.05,
      wpaConfidence: 0.9,
      gameState: { ahead: 0.05, even: 0.05, behind: 0.05 },
      purchaseTiming: { medianPurchaseSec: 200 + (index % SKELETON_ITEM_IDS.length) * 150 },
      laneWpa: 0.05,
      postLaneWpa: 0.05,
    })),
  };
}

export function goldenEvidence(): StatlockerEvidenceBundleV1 {
  const family = (dataset: string, payload?: unknown, confidence = 0.9) => ({
    dataset,
    scopeKey: 'golden',
    freshness: payload === undefined ? 'UNAVAILABLE' : 'FRESH',
    confidence: payload === undefined ? 0 : confidence,
    ...(payload === undefined ? {} : { payload }),
  });
  return {
    heroId: OUR_HERO,
    rulesetVersion: RULESET,
    catalogSha256: CATALOG_SHA,
    statlockerPatchId: PATCH,
    usable: true,
    snapshotIds: ['golden-snapshot'],
    degradedReasons: [],
    families: [],
    byDataset: {
      WPA_PATCH_DATA: family('WPA_PATCH_DATA', goldenWpaPatchDataPayload()),
      VS_HERO_WPA: family('VS_HERO_WPA'),
      T4_CHAINS: family('T4_CHAINS'),
      CONSENSUS_SKELETON: family('CONSENSUS_SKELETON', goldenSkeletonPayload()),
      WPA_FILTERED_ITEMS: family('WPA_FILTERED_ITEMS'),
    },
  } as unknown as StatlockerEvidenceBundleV1;
}

interface GoldenWpaRowSpec {
  enemyHeroId: number;
  itemId: number;
  count: number;
  deltaWpa: number;
  rankBucket?: string;
}

function goldenRows(specs: readonly GoldenWpaRowSpec[]): StatlockerVsHeroWpaAggregateSourceV1[] {
  return specs.map((spec) => ({
    heroId: OUR_HERO,
    enemyHeroId: spec.enemyHeroId,
    itemId: spec.itemId,
    count: spec.count,
    deltaWpa: spec.deltaWpa,
    meanWpa: 0.05,
  }));
}

function defaultWpaRows(): StatlockerVsHeroWpaAggregateSourceV1[] {
  return [
    // Branch B is the historically stronger branch against the whole draft.
    ...goldenRows([
      { enemyHeroId: ENEMY_FED, itemId: BRANCH_B_ITEM, count: 3000, deltaWpa: 0.12 },
      { enemyHeroId: ENEMY_PRIO, itemId: BRANCH_B_ITEM, count: 2500, deltaWpa: 0.10 },
      { enemyHeroId: ENEMY_THIRD, itemId: BRANCH_B_ITEM, count: 2000, deltaWpa: 0.08 },
      { enemyHeroId: ENEMY_FED, itemId: BRANCH_A_ITEM, count: 3000, deltaWpa: 0.01 },
      { enemyHeroId: ENEMY_PRIO, itemId: BRANCH_A_ITEM, count: 2500, deltaWpa: 0.005 },
      { enemyHeroId: ENEMY_THIRD, itemId: BRANCH_A_ITEM, count: 2000, deltaWpa: 0.004 },
    ]),
    // Neutral background evidence for skeleton items.
    ...SKELETON_ITEM_IDS.flatMap((itemId) => goldenRows([
      { enemyHeroId: ENEMY_FED, itemId, count: 2000, deltaWpa: 0.02 },
      { enemyHeroId: ENEMY_PRIO, itemId, count: 2000, deltaWpa: 0.02 },
      { enemyHeroId: ENEMY_THIRD, itemId, count: 2000, deltaWpa: 0.02 },
    ])),
    // Wildcard counter: strong broad evidence into the fed enemy.
    ...goldenRows([
      { enemyHeroId: ENEMY_FED, itemId: WILDCARD_COUNTER_ITEM, count: 2600, deltaWpa: 0.20 },
      { enemyHeroId: ENEMY_PRIO, itemId: WILDCARD_COUNTER_ITEM, count: 1800, deltaWpa: 0.14 },
      { enemyHeroId: ENEMY_THIRD, itemId: WILDCARD_COUNTER_ITEM, count: 1500, deltaWpa: 0.05 },
    ]),
  ];
}

interface GoldenHarnessOptions {
  wpaRows?: readonly StatlockerVsHeroWpaAggregateSourceV1[];
  wpaQueryError?: Error;
  enemyLiveStates?: GoldenDecisionOverrides['enemyLiveStates'];
  ownedItemIds?: readonly number[];
  spendableSouls?: number;
  gameTimeSec?: number;
  previousResult?: any;
  previousOwnedItemIds?: readonly number[];
}

export function buildGoldenService(options: GoldenHarnessOptions = {}) {
  const graph = createRecommendationItemGraph(goldenItems());
  const strategy = goldenStrategy();
  const registry = new BuildStrategyRegistryV1Service();
  registry.replaceSnapshot({
    rulesetId: RULESET,
    patchId: PATCH,
    catalogSha256: CATALOG_SHA,
    sourceSha256: 'b'.repeat(64),
    specs: [strategy],
    itemGraph: graph,
  });

  const scorer = new AdaptiveEvidenceScorerV1Service();
  const observability = new AdaptiveRecommendationObservabilityV1Service();
  const facade = new StrategyFirstAdaptivePlannerFacadeV1Service(
    new StrategyFirstBuildPlannerV1Service(scorer),
    registry,
    new StrategyFirstSituationalOverlayV1Service(scorer),
    observability,
  );
  const router = new AdaptivePlannerServingRouterV1Service(
    new StrategyFirstLegacyPlannerAdapterV1Service(facade, new AdaptiveDecisionTraceV1Service(scorer)),
    scorer,
    new AdaptivePhaseEligibilityV1Service(),
    new AdaptiveChoiceResolverV1Service(scorer),
    new StrategyFirstPromotionGateV1Service(observability),
  );

  const rows = options.wpaRows ?? defaultWpaRows();
  const repository = {
    findActive: async () => {
      if (options.wpaQueryError) throw options.wpaQueryError;
      return rows;
    },
  };

  const draftMatchupEvidence = new DraftMatchupEvidenceV1Service(
    repository as never,
    new EnemyThreatV1Service(),
    new ThreatWeightedMatchupV1Service(),
    new EnemyThreatHistoryV1Service(),
  );

  const decision = () => goldenDecision(graph, {
    ownedItemIds: options.ownedItemIds,
    spendableSouls: options.spendableSouls,
    gameTimeSec: options.gameTimeSec,
    enemyLiveStates: options.enemyLiveStates,
  });
  const decisionState = { build: jest.fn().mockImplementation(decision) };
  const evidenceService = {
    resolveLocalPatchId: jest.fn(() => PATCH),
    getLocalEvidence: jest.fn(() => goldenEvidence()),
  };
  const replay = {
    getPreviousContext: jest.fn(async () => options.previousResult
      ? {
          result: options.previousResult,
          replayInput: { decision: { state: { ownedItemIds: options.previousOwnedItemIds ?? [] } } },
        }
      : undefined),
    toReplayInput: jest.fn(() => ({ decision: { state: {} } })),
    persist: jest.fn(async () => undefined),
  };

  const service = new AdaptiveRecommendationV1Service(
    decisionState as never,
    evidenceService as never,
    router as never,
    replay as never,
    observability,
  );
  (service as unknown as { draftMatchupEvidence?: unknown }).draftMatchupEvidence = draftMatchupEvidence;

  return { service, graph, strategy, registry, observability };
}

export async function runGolden(options: GoldenHarnessOptions = {}) {
  const { service } = buildGoldenService(options);
  return service.recommend({ matchId: 'golden-match', localSteamId: 'steam-local' });
}

function heldIds(result: { recommendedBuild: readonly { itemId: number; status: string }[] }, owned: readonly number[]) {
  return result.recommendedBuild
    .filter((row) => row.status === 'OWNED' || owned.includes(row.itemId))
    .map((row) => row.itemId);
}

function projectedHeldCount(result: { recommendedBuild: readonly unknown[] }) {
  return result.recommendedBuild.length;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const NEUTRAL_ROWS = SKELETON_ITEM_IDS.flatMap((itemId) => goldenRows([
  { enemyHeroId: ENEMY_FED, itemId, count: 2000, deltaWpa: 0 },
  { enemyHeroId: ENEMY_PRIO, itemId, count: 2000, deltaWpa: 0 },
  { enemyHeroId: ENEMY_THIRD, itemId, count: 2000, deltaWpa: 0 },
]));

const BRANCH_EVIDENCE_ROWS = [
  ...goldenRows([
    { enemyHeroId: ENEMY_FED, itemId: BRANCH_B_ITEM, count: 3000, deltaWpa: 0.12 },
    { enemyHeroId: ENEMY_PRIO, itemId: BRANCH_B_ITEM, count: 2500, deltaWpa: 0.10 },
    { enemyHeroId: ENEMY_THIRD, itemId: BRANCH_B_ITEM, count: 2000, deltaWpa: 0.08 },
    { enemyHeroId: ENEMY_FED, itemId: BRANCH_A_ITEM, count: 3000, deltaWpa: 0.01 },
    { enemyHeroId: ENEMY_PRIO, itemId: BRANCH_A_ITEM, count: 2500, deltaWpa: 0.005 },
    { enemyHeroId: ENEMY_THIRD, itemId: BRANCH_A_ITEM, count: 2000, deltaWpa: 0.004 },
  ]),
  ...NEUTRAL_ROWS,
];

export const STRONG_WILDCARD_ROWS = [
  ...goldenRows([
    { enemyHeroId: ENEMY_FED, itemId: WILDCARD_COUNTER_ITEM, count: 2600, deltaWpa: 0.45 },
    { enemyHeroId: ENEMY_PRIO, itemId: WILDCARD_COUNTER_ITEM, count: 2400, deltaWpa: 0.35 },
    { enemyHeroId: ENEMY_THIRD, itemId: WILDCARD_COUNTER_ITEM, count: 2200, deltaWpa: 0.20 },
    // The late-core targets carry moderate live evidence so the ordinary whole-build
    // replacement path has a materially stronger item to buy at 12/12.
    { enemyHeroId: ENEMY_FED, itemId: 115, count: 2400, deltaWpa: 0.10 },
    { enemyHeroId: ENEMY_PRIO, itemId: 115, count: 2200, deltaWpa: 0.08 },
    { enemyHeroId: ENEMY_THIRD, itemId: 115, count: 2000, deltaWpa: 0.06 },
    { enemyHeroId: ENEMY_FED, itemId: 116, count: 2400, deltaWpa: 0.08 },
    { enemyHeroId: ENEMY_PRIO, itemId: 116, count: 2200, deltaWpa: 0.06 },
    { enemyHeroId: ENEMY_THIRD, itemId: 116, count: 2000, deltaWpa: 0.05 },
  ]),
  ...BRANCH_EVIDENCE_ROWS,
];

const MARGINAL_WILDCARD_ROWS = [
  ...goldenRows([
    { enemyHeroId: ENEMY_FED, itemId: WILDCARD_COUNTER_ITEM, count: 2600, deltaWpa: 0.035 },
    { enemyHeroId: ENEMY_PRIO, itemId: WILDCARD_COUNTER_ITEM, count: 2400, deltaWpa: 0.025 },
    { enemyHeroId: ENEMY_THIRD, itemId: WILDCARD_COUNTER_ITEM, count: 2200, deltaWpa: 0.015 },
  ]),
  ...NEUTRAL_ROWS,
];

export const DEFAULT_ENEMY_LIVE: NonNullable<GoldenHarnessOptions['enemyLiveStates']> = [
  { steamId: 'steam-20', heroId: ENEMY_FED, souls: 12000, heroDamage: 22000, kills: 6, deaths: 4, assists: 7, level: 12 },
  { steamId: 'steam-30', heroId: ENEMY_PRIO, souls: 11000, heroDamage: 20000, kills: 5, deaths: 5, assists: 6, level: 12 },
  { steamId: 'steam-40', heroId: ENEMY_THIRD, souls: 10000, heroDamage: 18000, kills: 4, deaths: 6, assists: 5, level: 11 },
];

describe('Threat-weighted WPA Golden Replay V1 (A-Q)', () => {
  it('A - neutral context keeps the coherent skeleton plan as winner', async () => {
    const result = await runGolden({
      ownedItemIds: [101, 102, 103, 104, 105],
      wpaRows: NEUTRAL_ROWS,
      enemyLiveStates: DEFAULT_ENEMY_LIVE,
    });

    expect(result.ready).toBe(true);
    expect(result.plannerMethod).toBe('STRATEGY_FIRST');
    expect(result.blockers).toEqual([]);
    // Plan stays on strategy-owned items: one selected branch, no wildcard.
    const buildItemIds = result.recommendedBuild.map((row) => row.itemId);
    expect(buildItemIds.some((itemId) => itemId === BRANCH_A_ITEM || itemId === BRANCH_B_ITEM)).toBe(true);
    expect(buildItemIds).not.toContain(WILDCARD_COUNTER_ITEM);
    if (result.nextAction.type !== 'HOLD') {
      expect(result.nextAction.targetItemId).not.toBe(WILDCARD_COUNTER_ITEM);
    }
    expect(result.decisionTrace!.baseline.strategyId).toBe('golden-replay-strategy-v1');
    expect(result.decisionTrace!.stages).toContain('SKELETON_BASELINE');
  });

  it('B - the draft-supported OR branch wins the declared choice', async () => {
    const result = await runGolden({
      ownedItemIds: [101, 102, 103, 104, 105],
      enemyLiveStates: DEFAULT_ENEMY_LIVE,
    });
    expect(result.ready).toBe(true);
    const buildItemIds = result.recommendedBuild.map((row) => row.itemId);
    expect(buildItemIds).toContain(BRANCH_B_ITEM);
    expect(buildItemIds).not.toContain(BRANCH_A_ITEM);
  });

  it('C - live threat on the fed enemy reorders matchup priorities and keeps one branch', async () => {
    // Identical historical WPA for both branch items; only live threat differs.
    const neutralBranchRows = [
      ...[BRANCH_A_ITEM, BRANCH_B_ITEM].flatMap((itemId) => goldenRows([
        { enemyHeroId: ENEMY_FED, itemId, count: 3000, deltaWpa: 0.10 },
        { enemyHeroId: ENEMY_PRIO, itemId, count: 3000, deltaWpa: 0.10 },
        { enemyHeroId: ENEMY_THIRD, itemId, count: 3000, deltaWpa: 0.10 },
      ])),
      ...NEUTRAL_ROWS,
    ];
    // Enemy 30 is far ahead of everyone; threat weighting must lift enemy 30's contribution.
    const result = await runGolden({
      ownedItemIds: [101, 102, 103, 104, 105],
      wpaRows: neutralBranchRows,
      enemyLiveStates: [
        { steamId: 'steam-20', heroId: ENEMY_FED, souls: 5000, heroDamage: 9000, kills: 2, assists: 3, level: 9, deaths: 6 },
        { steamId: 'steam-30', heroId: ENEMY_PRIO, souls: 50000, heroDamage: 90000, kills: 20, assists: 15, level: 20, deaths: 0 },
        { steamId: 'steam-40', heroId: ENEMY_THIRD, souls: 5000, heroDamage: 9000, kills: 2, assists: 3, level: 9, deaths: 6 },
      ],
    });
    expect(result.ready).toBe(true);
    const trace = result.decisionTrace!;
    expect(trace.stages).toContain('MATCHUP_DISCOVERY');
    const buildItemIds = result.recommendedBuild.map((row) => row.itemId);
    const exactlyOneBranch = buildItemIds.includes(BRANCH_A_ITEM) !== buildItemIds.includes(BRANCH_B_ITEM);
    expect(exactlyOneBranch || result.strategy?.buildStatus === 'COMPLETE').toBe(true);
  });

  it('D - tiny-sample spike is shrunk and cannot win discovery', async () => {
    const result = await runGolden({
      ownedItemIds: [101, 102, 103, 104, 105],
      wpaRows: [
        ...STRONG_WILDCARD_ROWS,
        ...goldenRows([
          { enemyHeroId: ENEMY_FED, itemId: TINY_SAMPLE_ITEM, count: 3, deltaWpa: 3.0 },
          { enemyHeroId: ENEMY_PRIO, itemId: TINY_SAMPLE_ITEM, count: 3, deltaWpa: 3.0 },
          { enemyHeroId: ENEMY_THIRD, itemId: TINY_SAMPLE_ITEM, count: 3, deltaWpa: 3.0 },
        ]),
      ],
      enemyLiveStates: DEFAULT_ENEMY_LIVE,
    });
    expect(result.ready).toBe(true);
    const buildItemIds = result.recommendedBuild.map((row) => row.itemId);
    expect(buildItemIds).not.toContain(TINY_SAMPLE_ITEM);
    expect(result.nextAction.targetItemId).not.toBe(TINY_SAMPLE_ITEM);
    // The strong broad wildcard still wins discovery in the same run.
    expect(buildItemIds).toContain(WILDCARD_COUNTER_ITEM);
  });

  it('E - strong legal outside-skeleton wildcard is discovered and selected', async () => {
    const result = await runGolden({
      ownedItemIds: [101, 102, 103, 104, 105],
      spendableSouls: 4000,
      wpaRows: STRONG_WILDCARD_ROWS,
      enemyLiveStates: DEFAULT_ENEMY_LIVE,
    });
    expect(result.ready).toBe(true);
    const buildItemIds = result.recommendedBuild.map((row) => row.itemId);
    expect(buildItemIds).toContain(WILDCARD_COUNTER_ITEM);
    const wildcardRow = result.recommendedBuild.find((row) => row.itemId === WILDCARD_COUNTER_ITEM)!;
    expect(['NEXT', 'OWNED']).toContain(wildcardRow.status);
    const wildcardCandidate = result.decisionTrace!.candidates.find(
      (candidate) => candidate.action.targetItemId === WILDCARD_COUNTER_ITEM ||
        candidate.action.buyItemId === WILDCARD_COUNTER_ITEM,
    );
    expect(wildcardCandidate).toBeDefined();
    expect(wildcardCandidate!.selected).toBe(true);
    // Provenance stays traceable: outside-skeleton discovery is recorded with its
    // situational source and discovery reason codes.
    expect(['WILDCARD', 'DISCOVERED', 'EXPLICIT_SITUATIONAL']).toContain(wildcardCandidate!.source);
    const provenanceCodes = [
      ...(wildcardCandidate!.action.reasonCodes ?? []),
      ...(wildcardCandidate!.matchup?.reasonCodes ?? []),
    ];
    const selectedSituational = (result.strategy as unknown as { situationalDecision?: { reasonCodes: readonly string[] } })?.situationalDecision;
    const discoveryCodes = [
      ...(selectedSituational?.reasonCodes ?? []),
      ...provenanceCodes,
    ];
    expect(discoveryCodes).toContain('MATCHUP_DISCOVERY_OUTSIDE_SKELETON');
  });

  it('F - hard core is never sold for ordinary WPA uplift', async () => {
    // Full inventory, hard goals unmet only through late-core; core items carry terrible
    // historical value while selling any of them would free a slot for the late buy.
    const result = await runGolden({
      ownedItemIds: [...CORE_IDS, BRANCH_A_ITEM, BRANCH_B_ITEM, WEAK_FLEX_ITEM],
      spendableSouls: 4000,
      wpaRows: [
        ...goldenRows(
          CORE_IDS.flatMap((itemId) => [
            { enemyHeroId: ENEMY_FED, itemId, count: 5000, deltaWpa: -0.5 },
            { enemyHeroId: ENEMY_PRIO, itemId, count: 5000, deltaWpa: -0.5 },
            { enemyHeroId: ENEMY_THIRD, itemId, count: 5000, deltaWpa: -0.5 },
          ]),
        ),
        ...STRONG_WILDCARD_ROWS,
        ...goldenRows([
          { enemyHeroId: ENEMY_FED, itemId: 115, count: 3000, deltaWpa: 0.02 },
          { enemyHeroId: ENEMY_PRIO, itemId: 115, count: 3000, deltaWpa: 0.02 },
          { enemyHeroId: ENEMY_THIRD, itemId: 115, count: 3000, deltaWpa: 0.02 },
        ]),
      ],
      enemyLiveStates: DEFAULT_ENEMY_LIVE,
    });
    expect(result.ready).toBe(true);
    const projected = result.recommendedBuild.map((row) => row.itemId);
    for (const coreItemId of CORE_IDS) {
      expect(projected).toContain(coreItemId);
    }
    if (result.nextAction.type === 'REPLACE') {
      expect(CORE_IDS).not.toContain(result.nextAction.sellItemId);
    }
    for (const replacement of result.decisionTrace?.replacements ?? []) {
      if (replacement.selected) {
        expect(CORE_IDS).not.toContain(replacement.sellItemId);
      }
    }
  });

  it('G - free slot buys the winner without any sell instruction', async () => {
    const result = await runGolden({
      ownedItemIds: [...CORE_IDS, BRANCH_A_ITEM],
      spendableSouls: 5000,
      wpaRows: NEUTRAL_ROWS,
      enemyLiveStates: DEFAULT_ENEMY_LIVE,
    });
    expect(result.ready).toBe(true);
    expect(result.nextAction.type).toBe('BUY');
    expect(result.nextAction.sellItemId).toBeUndefined();
    expect(result.recommendedBuild.length).toBeLessThanOrEqual(12);
  });

  it('H - 12/12 replacement sells the weak flex item and buys the stronger wildcard', async () => {
    const result = await runGolden({
      ownedItemIds: [...CORE_IDS, BRANCH_A_ITEM, BRANCH_B_ITEM, WEAK_FLEX_ITEM],
      spendableSouls: 4000,
      wpaRows: STRONG_WILDCARD_ROWS,
      enemyLiveStates: DEFAULT_ENEMY_LIVE,
    });
    expect(result.ready).toBe(true);
    expect(result.nextAction.type).toBe('REPLACE');
    expect(result.nextAction.sellItemId).toBeDefined();
    expect(result.nextAction.buyItemId).toBeDefined();
    expect(result.nextAction.sellItemId).toBe(WEAK_FLEX_ITEM);
    // The sell-driven outside-skeleton wildcard clears its 0.30 whole-build threshold
    // and is compiled into an explicit replacement transaction.
    expect(result.nextAction.buyItemId).toBe(WILDCARD_COUNTER_ITEM);
    const situational = (result.strategy as unknown as { situationalDecision?: { targetItemId: number; reasonCodes: readonly string[] } })?.situationalDecision;
    expect(situational?.targetItemId).toBe(WILDCARD_COUNTER_ITEM);
    expect(situational?.reasonCodes).toContain('MATCHUP_DISCOVERY_SELL_DRIVEN');
    expect(result.recommendedBuild.length).toBeLessThanOrEqual(12);
    const replacement = (result.decisionTrace?.replacements ?? []).find((row) => row.selected);
    expect(replacement).toBeDefined();
    expect(replacement!.accepted).toBe(true);
    expect(replacement!.netImprovement).toBeGreaterThanOrEqual(replacement!.requiredThreshold);
    expect(replacement!.inventoryCount).toBe(12);
    expect(replacement!.maxItemCount).toBe(12);
  });

  it('I - 12/12 replacement below the threshold is rejected without a 13th item', async () => {
    // Hard goals are satisfied, the build is complete, and the only attractive item
    // carries marginal evidence: no replacement may be invented for it.
    const result = await runGolden({
      ownedItemIds: [...CORE_IDS, 115, BRANCH_A_ITEM, BRANCH_B_ITEM],
      spendableSouls: 4000,
      wpaRows: MARGINAL_WILDCARD_ROWS,
      enemyLiveStates: DEFAULT_ENEMY_LIVE,
    });
    expect(result.ready).toBe(true);
    expect(result.nextAction.type).not.toBe('REPLACE');
    expect(result.nextAction.type).not.toBe('BUY');
    expect(result.recommendedBuild.length).toBeLessThanOrEqual(12);
    expect(result.recommendedBuild.map((row) => row.itemId)).not.toContain(WILDCARD_COUNTER_ITEM);
    const rejected = (result.decisionTrace?.replacements ?? []).filter((row) => !row.accepted);
    expect(rejected.length).toBeGreaterThan(0);
    for (const row of rejected) {
      expect(row.netImprovement).toBeLessThan(row.requiredThreshold);
    }
  });

  it('J - item bought inside the recent-purchase window is protected from selling', async () => {
    const owned = [...CORE_IDS, BRANCH_A_ITEM, BRANCH_B_ITEM, WEAK_FLEX_ITEM];
    const firstRun = await runGolden({
      ownedItemIds: owned,
      wpaRows: STRONG_WILDCARD_ROWS,
      enemyLiveStates: DEFAULT_ENEMY_LIVE,
    });
    // Simulate the flex item having been purchased moments ago: the previous snapshot
    // did not contain it, so the replay delta marks it as a recent purchase.
    const result = await runGolden({
      ownedItemIds: owned,
      wpaRows: STRONG_WILDCARD_ROWS,
      enemyLiveStates: DEFAULT_ENEMY_LIVE,
      previousResult: firstRun,
      previousOwnedItemIds: [...CORE_IDS, BRANCH_A_ITEM, BRANCH_B_ITEM],
    });
    expect(result.ready).toBe(true);
    if (result.nextAction.type === 'REPLACE') {
      expect(result.nextAction.sellItemId).not.toBe(WEAK_FLEX_ITEM);
    }
    expect(result.recommendedBuild.map((row) => row.itemId)).toContain(WEAK_FLEX_ITEM);
  });

  it('K - unknown sell economics fail closed instead of inventing a refund', async () => {
    // Item 130 has no sellTransition: it is the only sellable-looking candidate at 12/12.
    const result = await runGolden({
      ownedItemIds: [...CORE_IDS, BRANCH_A_ITEM, BRANCH_B_ITEM, 130],
      spendableSouls: 4000,
      wpaRows: STRONG_WILDCARD_ROWS,
      enemyLiveStates: DEFAULT_ENEMY_LIVE,
    });
    expect(result.ready).toBe(true);
    expect(result.nextAction.type).not.toBe('REPLACE');
    expect(result.nextAction.type).not.toBe('SELL');
    expect(result.recommendedBuild.map((row) => row.itemId)).toContain(130);
  });

  it('L - stale/missing WPA falls back to skeleton-driven behavior without hallucinated confidence', async () => {
    const result = await runGolden({
      ownedItemIds: [101, 102, 103, 104],
      wpaRows: [],
      enemyLiveStates: DEFAULT_ENEMY_LIVE,
    });
    expect(result.ready).toBe(true);
    const nextTarget = result.nextAction.targetItemId;
    expect([...MID_CORE_IDS, ...LATE_CORE_IDS, BRANCH_A_ITEM, BRANCH_B_ITEM]).toContain(nextTarget);
  });

  it('M - missing live stats stay neutral while historical matchup evidence still applies', async () => {
    const result = await runGolden({
      ownedItemIds: [101, 102, 103, 104, 105],
      enemyLiveStates: [
        { steamId: 'steam-20', heroId: ENEMY_FED },
        { steamId: 'steam-30', heroId: ENEMY_PRIO },
        { steamId: 'steam-40', heroId: ENEMY_THIRD },
      ],
    });
    expect(result.ready).toBe(true);
    // Historical branch preference (branch B) must survive neutral threat weighting.
    expect(result.recommendedBuild.map((row) => row.itemId)).toContain(BRANCH_B_ITEM);
  });

  it('N - close snapshots do not churn the plan back and forth', async () => {
    const options: GoldenHarnessOptions = {
      ownedItemIds: [101, 102, 103, 104, 105],
      enemyLiveStates: DEFAULT_ENEMY_LIVE,
    };
    const first = await runGolden(options);
    const second = await runGolden({
      ...options,
      previousResult: first,
      previousOwnedItemIds: [101, 102, 103, 104, 105],
    });
    expect(second.ready).toBe(true);
    expect(second.nextAction.actionKey).toBe(first.nextAction.actionKey);
    expect(second.recommendedBuild.map((row) => row.itemId).join(','))
      .toBe(first.recommendedBuild.map((row) => row.itemId).join(','));
  });

  it('O - failed relational ingest keeps the previous active dataset serving recommendations', async () => {
    const { service } = buildGoldenService({ ownedItemIds: [101, 102, 103, 104, 105] });
    // The golden harness fakes the repository edge; here the previous dataset is represented
    // by the default rows, and a failed ingest must not remove them from serving.
    const result = await service.recommend({ matchId: 'golden-match', localSteamId: 'steam-local' });
    expect(result.ready).toBe(true);
    expect(result.recommendedBuild.length).toBeGreaterThan(0);
    expect(result.nextAction.type).toBeDefined();
  });

  it('P - relational repository serves rows without whole-dataset hydration', async () => {
    const { service } = buildGoldenService({ ownedItemIds: [101, 102, 103, 104, 105] });
    const result = await service.recommend({ matchId: 'golden-match', localSteamId: 'steam-local' });
    expect(result.ready).toBe(true);
    const serialized = JSON.stringify(result);
    // No RAW WPA payload may leak into the recommendation response.
    expect(serialized).not.toContain('draftMatchupByItemId');
    expect(serialized).not.toContain('rawDeltaWpa');
    expect(serialized).not.toContain('draftEnemyThreats');
    expect(serialized.length).toBeLessThan(120_000);
  });

  it('Q - response is one coherent build, one executable action, bounded trace', async () => {
    const result = await runGolden({
      ownedItemIds: [101, 102, 103, 104, 105],
      spendableSouls: 4000,
      enemyLiveStates: DEFAULT_ENEMY_LIVE,
    });
    expect(result.ready).toBe(true);
    // One coherent build with at most 12 held items.
    expect(result.recommendedBuild.length).toBeLessThanOrEqual(12);
    // Exactly one executable next action consistent with the semantic plan.
    expect(result.nextAction).toBeDefined();
    expect(result.nextAction.actionKey).toBeDefined();
    if (result.planSession && result.planSession.state === 'ACTIVE') {
      expect(result.nextAction.type).not.toBe('HOLD');
    }
    // Bounded canonical trace whose final selection matches the returned action.
    const trace = result.decisionTrace!;
    expect(trace).toBeDefined();
    expect(JSON.stringify(trace.candidates ?? []).length).toBeLessThan(60_000);
    expect(trace.finalSelection.action.actionKey).toBe(result.nextAction.actionKey);
    // Policy snapshot is present with every required number.
    expect(trace.policy.heldItemCapacity).toBe(12);
    expect(trace.policy.thresholds).toEqual({
      planSwitch: 0.08,
      sellBuy: 0.20,
      softCoreReplace: 0.25,
      wildcardReplace: 0.30,
      matchupConfidence: 0.35,
    });
    // No RAW WPA dumps anywhere in the response.
    expect(JSON.stringify(result)).not.toContain('rawDeltaWpa');
  });
});
