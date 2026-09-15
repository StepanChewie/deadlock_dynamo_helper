import {
  RecommendationItemDefinition,
  createRecommendationItemGraph,
} from '@dynamo-lab/build-domain';
import { AdaptiveRecommendationV2Service } from '../src/statlocker-adaptive/adaptive-recommendation-v2.service';
import { BuildArchetypeFamilyV2, BuildArchetypeV2 } from '../src/statlocker-adaptive/build-archetype-v2';
import { BuildDebugTraceStoreV2Service } from '../src/statlocker-adaptive/build-debug-trace-store-v2.service';
import { BuildDecisionTraceCollectorV2 } from '../src/statlocker-adaptive/build-decision-trace-v2';
import { BuildItemUtilityV2Service } from '../src/statlocker-adaptive/build-item-utility-v2.service';
import {
  FamilyFirstFullBuildLifetimeResolverV2Input,
  FamilyFirstFullBuildResolverV2Service,
} from '../src/statlocker-adaptive/family-first-full-build-resolver-v2.service';
import { ResolvedFullBuildPlanV2 } from '../src/statlocker-adaptive/full-build-plan-v2';
import { ThreatWeightedMatchupV1Service } from '../src/statlocker-adaptive/threat-weighted-matchup-v1.service';

const MATCH_ID = 'match-previous-plan-wiring';
const HERO_ID = 72;
const RULESET_ID = 'ruleset-a';
const CATALOG_SHA = 'a'.repeat(64);
const ENEMY_HERO_IDS = [6, 10, 13, 27, 31, 35];

function plan(revision: string) {
  return {
    planRevision: revision,
    matchId: MATCH_ID,
    heroId: HERO_ID,
    archetypeId: 'archetype:a',
    stateRevision: 'state-1',
    steps: [],
    desiredState: {
      families: [],
      selectedChoiceFamilyIdsByGroup: {},
      reasonCodes: [],
    },
    degradedReasons: [],
    mechanicalValidation: { valid: true, reasonCodes: [] },
    semanticValidation: { valid: true, reasonCodes: [], finalFamilyStates: [] },
    validation: { valid: true, reasonCodes: [] },
  } as any;
}

function harness() {
  const itemGraph = createRecommendationItemGraph([]);
  const decision = {
    state: {
      decisionId: 'decision-1',
      matchId: MATCH_ID,
      playerSlot: 0,
      gameTimeSec: 600,
      rulesetId: RULESET_ID,
      heroId: HERO_ID,
      inventory: {
        initializedFromSnapshot: true,
        heldByItemId: new Map(),
        lifecycleCountByItemId: new Map(),
        nextInstanceSequence: 1,
      },
      economy: {
        spendableSouls: { evidence: 'OBSERVED', value: 50_000 },
        shopOpportunity: { evidence: 'UNKNOWN', reason: 'test' },
      },
    },
    itemGraph,
    catalogVersionId: 'catalog-a',
    catalogSha256: CATALOG_SHA,
    rulesetId: RULESET_ID,
    localSteamId: 'steam-local',
    allyHeroIds: [],
    enemyHeroIds: ENEMY_HERO_IDS,
    enemyHeroes: ENEMY_HERO_IDS.map((heroId) => ({ heroId })),
    enemyLiveStates: ENEMY_HERO_IDS.map((heroId) => ({ steamId: `enemy-${heroId}`, heroId })),
    allyItemIds: [],
    enemyItemIds: [],
    slots: {
      baseSlots: 0,
      baseSlotsByType: { weapon: 0, vitality: 0, spirit: 0 },
      maxFlexSlots: 12,
      maxActiveItems: 4,
      unlockedFlexSlots: 12,
      usedSlots: 0,
      usedSlotsByType: { weapon: 0, vitality: 0, spirit: 0 },
      usedByType: { weapon: 0, vitality: 0, spirit: 0 },
      overflowByType: { weapon: 0, vitality: 0, spirit: 0 },
      usedFlexSlots: 0,
      provedFlexLowerBound: 12,
      freeBaseSlots: 0,
      freeBaseSlotsByType: { weapon: 0, vitality: 0, spirit: 0 },
      freeBaseByType: { weapon: 0, vitality: 0, spirit: 0 },
      freeFlexSlots: 12,
      totalCapacity: 12,
      activeItemsUsed: 0,
      usedActiveItems: 0,
      freeActiveItemSlots: 4,
      mechanicsEvidence: 'RECONSTRUCTED',
      flexEvidence: 'OBSERVED',
      evidence: 'OBSERVED',
    },
    investment: {
      tracks: {
        weapon: { type: 'weapon', currentValue: 0 },
        vitality: { type: 'vitality', currentValue: 0 },
        spirit: { type: 'spirit', currentValue: 0 },
      },
      evidence: 'RECONSTRUCTED',
    },
    economyRulesEvidence: 'RECONSTRUCTED',
    stateRevision: 'state-1',
  } as any;

  const selection = {
    archetypeId: 'archetype:a',
    mode: 'VS_HERO_WPA',
    scores: [{
      archetypeId: 'archetype:a',
      score: 1,
      confidence: 1,
      coverage: 1,
    }],
    degradedReasons: [],
  };
  const lock = {
    matchId: MATCH_ID,
    heroId: HERO_ID,
    snapshotId: 'snapshot-a',
    archetypeId: 'archetype:a',
    enemyHeroIds: ENEMY_HERO_IDS,
    selection,
    lockedAt: new Date('2026-09-11T08:00:00.000Z'),
    lockedGameTimeS: 300,
    degradedReasons: [],
  };
  const snapshot = {
    snapshotId: 'snapshot-a',
    heroId: HERO_ID,
    rulesetVersion: RULESET_ID,
    catalogSha256: CATALOG_SHA,
    statlockerPatchId: 'patch-a',
    generatedAt: '2026-09-11T08:00:00.000Z',
    sourceProfileAccountIds: Array.from({ length: 10 }, (_, index) => `profile-${index}`),
    archetypes: [{ archetypeId: 'archetype:a' }],
  } as any;
  const unavailable = (dataset: string) => ({
    dataset,
    scopeKey: `test:${dataset}`,
    freshness: 'UNAVAILABLE',
    confidence: 0,
  });
  const evidenceBundle = {
    heroId: HERO_ID,
    rulesetVersion: RULESET_ID,
    catalogSha256: CATALOG_SHA,
    statlockerPatchId: 'patch-a',
    usable: true,
    snapshotIds: [],
    degradedReasons: [],
    families: [],
    byDataset: {
      WPA_PATCH_DATA: unavailable('WPA_PATCH_DATA'),
      VS_HERO_WPA: unavailable('VS_HERO_WPA'),
      T4_CHAINS: unavailable('T4_CHAINS'),
      CONSENSUS_SKELETON: unavailable('CONSENSUS_SKELETON'),
      WPA_FILTERED_ITEMS: unavailable('WPA_FILTERED_ITEMS'),
    },
  };

  const resolver = {
    resolve: jest
      .fn()
      .mockReturnValueOnce(plan('plan-1'))
      .mockReturnValueOnce(plan('plan-2')),
  };
  const traceStore = new BuildDebugTraceStoreV2Service();
  const service = new AdaptiveRecommendationV2Service(
    { build: jest.fn(async () => decision) } as any,
    { getLocalEvidence: jest.fn(() => evidenceBundle) } as any,
    { getById: jest.fn(async () => snapshot) } as any,
    { findActive: jest.fn(async () => []) } as any,
    {} as any,
    { get: jest.fn(async () => lock) } as any,
    { scoreEnemies: jest.fn(() => []) } as any,
    { discover: jest.fn(() => []) } as any,
    resolver as any,
    traceStore,
  );

  return { service, resolver, traceStore };
}

describe('AdaptiveRecommendationV2Service previous-plan wiring', () => {
  it('passes the previously stored final plan into the resolver before the second resolution', async () => {
    const h = harness();

    await h.service.recommend({ matchId: MATCH_ID, localSteamId: 'steam-local' });
    const previousPlan = h.traceStore.get(MATCH_ID, 'steam-local')?.finalPlan;
    expect(previousPlan).toBeDefined();

    await h.service.recommend({ matchId: MATCH_ID, localSteamId: 'steam-local' });

    expect(h.resolver.resolve).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ previousPlan }),
    );
  });
});

const HYSTERESIS_MATCH_ID = 'match-hysteresis-trace';
const HYSTERESIS_HERO_ID = 72;
const HYSTERESIS_TERMINAL_ITEM_ID = 999;
const HYSTERESIS_PREVIOUS_ONLY_ITEM_ID = 4242;

function hysteresisItem(itemId: number): RecommendationItemDefinition {
  return {
    itemId,
    name: `item-${itemId}`,
    slotType: 'weapon',
    active: true,
    availableRulesetIds: ['r1'],
    directPurchaseCost: 500,
    upgradeRecipes: [],
    sellTransition: { soulsRefund: 250, returnedItemIds: [] },
    maxCopies: 1,
  };
}

function hysteresisArchetype(): BuildArchetypeV2 {
  const family: BuildArchetypeFamilyV2 = {
    familyId: HYSTERESIS_TERMINAL_ITEM_ID,
    requirement: 'REQUIRED',
    aggregateFrequencyTier: 'CORE',
    sourceProfileCount: 5,
    profileCoverage: 0.5,
    purchaseRate: 0.5,
    structuralPriority: 0.5,
    progressionNodes: [{
      itemId: HYSTERESIS_TERMINAL_ITEM_ID,
      rawFrequencyTier: 'CORE',
      progressionRole: 'DEFAULT_TERMINAL',
      sourceProfileCount: 5,
      profileCoverage: 0.5,
      purchaseRate: 0.5,
      timing: { medianBuyTimeS: 300, spreadS: 30, phase: 'EARLY' },
    }],
    progressionEdges: [],
    terminalCandidates: [{
      itemId: HYSTERESIS_TERMINAL_ITEM_ID,
      kind: 'DEFAULT_TERMINAL',
      sourceProfileCount: 5,
      profileCoverage: 0.5,
      purchaseRate: 0.5,
      rawFrequencyTier: 'CORE',
    }],
  };
  return {
    archetypeId: 'archetype:hysteresis-trace',
    heroId: HYSTERESIS_HERO_ID,
    rulesetVersion: 'r1',
    catalogSha256: 'a'.repeat(64),
    statlockerPatchId: 'p1',
    sourceProfileAccountIds: ['p1', 'p2', 'p3', 'p4', 'p5'],
    families: [family],
    items: [],
    groups: [],
    orderEdges: [],
    relationships: [],
    quality: { support: 1, coherence: 0.9, separation: 0.5, sourceProfileCount: 5 },
  };
}

function hysteresisLifetimeInput(): FamilyFirstFullBuildLifetimeResolverV2Input {
  return {
    matchId: HYSTERESIS_MATCH_ID,
    stateRevision: 'state-1',
    heroId: HYSTERESIS_HERO_ID,
    rulesetId: 'r1',
    archetype: hysteresisArchetype(),
    itemGraph: createRecommendationItemGraph([hysteresisItem(HYSTERESIS_TERMINAL_ITEM_ID)]),
    capacity: 12,
    gameTimeSec: 1_000,
    currentInventoryItemIds: [],
    enemyHeroIds: [1, 2, 3, 4, 5, 6],
    enemyThreats: [],
    vsHeroRows: [],
  };
}

function hysteresisResolver(): FamilyFirstFullBuildResolverV2Service {
  return new FamilyFirstFullBuildResolverV2Service(
    new BuildItemUtilityV2Service(new ThreatWeightedMatchupV1Service()),
  );
}

function baselinePlan(resolver: FamilyFirstFullBuildResolverV2Service): ResolvedFullBuildPlanV2 {
  return resolver.resolve({ ...hysteresisLifetimeInput(), trace: new BuildDecisionTraceCollectorV2() });
}

function planSearchPayload(collector: BuildDecisionTraceCollectorV2): {
  branches: readonly {
    sequence: number;
    targetItemId: number;
    action?: string;
    disposition: string;
    reasonCodes: readonly string[];
  }[];
  hysteresis?: {
    action: 'KEEP_PREVIOUS' | 'SWITCH_TO_CANDIDATE';
    improvement: number;
    requiredImprovement: number;
    reasonCodes: readonly string[];
  };
} {
  const entry = collector.stages().find((stage) => stage.stage === 'PLAN_SEARCH');
  expect(entry).toBeDefined();
  return (entry as unknown as { payload: ReturnType<typeof planSearchPayload> }).payload;
}

describe('FamilyFirstFullBuildResolverV2Service hysteresis trace', () => {
  it('records KEEP_PREVIOUS with a suppressed candidate branch when the improvement margin is not cleared', () => {
    const resolver = hysteresisResolver();
    const baseline = baselinePlan(resolver);

    const previousPlan: ResolvedFullBuildPlanV2 = {
      ...baseline,
      planRevision: 'previous-plan',
      steps: [{
        sequence: 1,
        action: 'BUY',
        buyItemId: HYSTERESIS_PREVIOUS_ONLY_ITEM_ID,
        consumedItemIds: [],
        inventoryBefore: [],
        inventoryAfter: [HYSTERESIS_PREVIOUS_ONLY_ITEM_ID],
        reasonCodes: ['PREVIOUS_PLAN_STEP'],
      }],
    };

    const trace = new BuildDecisionTraceCollectorV2();
    const plan = resolver.resolve({
      ...hysteresisLifetimeInput(),
      previousPlan,
      trace,
    });

    expect(plan.planRevision).toBe('previous-plan');
    const payload = planSearchPayload(trace);
    expect(payload.hysteresis).toBeDefined();
    expect(payload.hysteresis?.action).toBe('KEEP_PREVIOUS');
    expect(payload.hysteresis?.reasonCodes).toContain('PLAN_HYSTERESIS_MARGIN_NOT_CLEARED');

    expect(payload.branches.some((branch) =>
      branch.targetItemId === HYSTERESIS_PREVIOUS_ONLY_ITEM_ID &&
      branch.disposition === 'SELECTED',
    )).toBe(true);

    const suppressed = payload.branches.filter((branch) => branch.disposition === 'SUPPRESSED_BY_HYSTERESIS');
    expect(suppressed.length).toBeGreaterThan(0);
    expect(suppressed.every((branch) => branch.targetItemId === HYSTERESIS_TERMINAL_ITEM_ID)).toBe(true);
    expect(suppressed[0].reasonCodes).toContain('PLAN_HYSTERESIS_MARGIN_NOT_CLEARED');
  });

  it('records SWITCH_TO_CANDIDATE and clears the margin without suppressing branches above the threshold', () => {
    const resolver = hysteresisResolver();
    const baseline = baselinePlan(resolver);

    const previousPlan: ResolvedFullBuildPlanV2 = {
      ...baseline,
      planRevision: 'previous-plan',
      desiredState: {
        ...baseline.desiredState!,
        families: baseline.desiredState!.families.map((family) => ({
          ...family,
          score: family.score - 1,
        })),
      },
    };

    const trace = new BuildDecisionTraceCollectorV2();
    const plan = resolver.resolve({
      ...hysteresisLifetimeInput(),
      previousPlan,
      trace,
    });

    expect(plan.planRevision).toBe(baseline.planRevision);
    const payload = planSearchPayload(trace);
    expect(payload.hysteresis?.action).toBe('SWITCH_TO_CANDIDATE');
    expect(payload.branches.every((branch) => branch.disposition === 'SELECTED')).toBe(true);
    expect(payload.branches.some((branch) =>
      branch.reasonCodes.includes('PLAN_HYSTERESIS_MARGIN_CLEARED'),
    )).toBe(true);
  });

  it('omits the hysteresis payload and selects every branch when there is no previous plan', () => {
    const trace = new BuildDecisionTraceCollectorV2();
    hysteresisResolver().resolve({ ...hysteresisLifetimeInput(), trace });

    const payload = planSearchPayload(trace);
    expect(payload.hysteresis).toBeUndefined();
    expect(payload.branches.length).toBeGreaterThan(0);
    expect(payload.branches.every((branch) => branch.disposition === 'SELECTED')).toBe(true);
  });
});
