import {
  RecommendationItemDefinition,
  createRecommendationItemGraph,
} from '@dynamo-lab/build-domain';
import { AdaptiveRecommendationV2Controller } from '../src/statlocker-adaptive/adaptive-recommendation-v2.controller';
import { enabledAvailability } from './adaptive-availability-stub';
import { AdaptiveRecommendationV2Service } from '../src/statlocker-adaptive/adaptive-recommendation-v2.service';
import { BuildArchetypeV2, BuildArchetypeSnapshotV2 } from '../src/statlocker-adaptive/build-archetype-v2';
import { BuildArchetypeSelectorV2Service } from '../src/statlocker-adaptive/build-archetype-selector-v2.service';
import { BuildArchetypeSessionV2Service } from '../src/statlocker-adaptive/build-archetype-session-v2.service';
import { BuildDebugTraceStoreV2Service } from '../src/statlocker-adaptive/build-debug-trace-store-v2.service';
import { BuildItemUtilityV2Service } from '../src/statlocker-adaptive/build-item-utility-v2.service';
import { EnemyThreatV1Service } from '../src/statlocker-adaptive/enemy-threat-v1.service';
import { FamilyFirstFullBuildResolverV2Service } from '../src/statlocker-adaptive/family-first-full-build-resolver-v2.service';
import { ResolvedFullBuildPlanV2 } from '../src/statlocker-adaptive/full-build-plan-v2';
import { MatchupCandidateDiscoveryV2Service } from '../src/statlocker-adaptive/matchup-candidate-discovery-v2.service';
import { ThreatWeightedMatchupV1Service } from '../src/statlocker-adaptive/threat-weighted-matchup-v1.service';

const HERO_ID = 72;
const RULESET_ID = 'ruleset-a';
const PATCH_ID = 'patch-a';
const CATALOG_SHA = 'a'.repeat(64);
const ENEMY_HERO_IDS = [6, 10, 13, 27, 31, 35];
const CAPACITY = 12;
const ARCHETYPE_A = 'archetype:a';
const ARCHETYPE_B = 'archetype:b';

function upgradeFamily(componentItemId: number, targetItemId: number): RecommendationItemDefinition[] {
  return [
    {
      itemId: componentItemId,
      name: `Component ${componentItemId}`,
      slotType: componentItemId % 3 === 0 ? 'spirit' : componentItemId % 3 === 1 ? 'weapon' : 'vitality',
      active: false,
      availableRulesetIds: [RULESET_ID],
      directPurchaseCost: 500,
      upgradeRecipes: [],
      sellTransition: { soulsRefund: 250, returnedItemIds: [] },
      maxCopies: 1,
    },
    {
      itemId: targetItemId,
      name: `Upgrade ${targetItemId}`,
      slotType: componentItemId % 3 === 0 ? 'spirit' : componentItemId % 3 === 1 ? 'weapon' : 'vitality',
      active: false,
      availableRulesetIds: [RULESET_ID],
      upgradeRecipes: [{
        recipeId: `${componentItemId}-to-${targetItemId}`,
        consumedItemIds: [componentItemId],
        soulsCost: 1000,
      }],
      sellTransition: { soulsRefund: 750, returnedItemIds: [] },
      maxCopies: 1,
    },
  ];
}

const archetypeAFamilies = Array.from({ length: 8 }, (_, index) => ({
  componentItemId: index + 1,
  targetItemId: 101 + index,
}));
const archetypeBFamilies = Array.from({ length: 8 }, (_, index) => ({
  componentItemId: 21 + index,
  targetItemId: 201 + index,
}));
const itemGraph = createRecommendationItemGraph([
  ...archetypeAFamilies.flatMap((family) => upgradeFamily(family.componentItemId, family.targetItemId)),
  ...archetypeBFamilies.flatMap((family) => upgradeFamily(family.componentItemId, family.targetItemId)),
]);

function archetype(
  archetypeId: string,
  familyInputs: readonly { componentItemId: number; targetItemId: number }[],
  support: number,
): BuildArchetypeV2 {
  return {
    archetypeId,
    heroId: HERO_ID,
    rulesetVersion: RULESET_ID,
    catalogSha256: CATALOG_SHA,
    statlockerPatchId: PATCH_ID,
    sourceProfileAccountIds: Array.from({ length: 10 }, (_, index) => `profile-${index + 1}`),
    families: familyInputs.map((family, index) => ({
      familyId: family.componentItemId,
      requirement: 'REQUIRED',
      aggregateFrequencyTier: index < 5 ? 'CORE' : 'FREQUENT',
      sourceProfileCount: 10,
      profileCoverage: 1,
      purchaseRate: 1,
      structuralPriority: 1,
      progressionNodes: [
        {
          itemId: family.componentItemId,
          rawFrequencyTier: index < 5 ? 'CORE' : 'FREQUENT',
          progressionRole: 'ENTRY',
          sourceProfileCount: 10,
          profileCoverage: 1,
          purchaseRate: 1,
          timing: {
            medianBuyTimeS: 120 + index * 120,
            spreadS: 60,
            phase: index < 3 ? 'EARLY' : index < 6 ? 'MID' : 'LATE',
          },
        },
        {
          itemId: family.targetItemId,
          rawFrequencyTier: index < 5 ? 'CORE' : 'FREQUENT',
          progressionRole: 'DEFAULT_TERMINAL',
          sourceProfileCount: 10,
          profileCoverage: 1,
          purchaseRate: 1,
          timing: {
            medianBuyTimeS: 180 + index * 120,
            spreadS: 60,
            phase: index < 3 ? 'EARLY' : index < 6 ? 'MID' : 'LATE',
          },
        },
      ],
      progressionEdges: [{
        fromItemId: family.componentItemId,
        toItemId: family.targetItemId,
        sourceProfileCount: 10,
        orderedProfileCount: 10,
        orderConfidence: 1,
        timing: {
          fromMedianBuyTimeS: 120 + index * 120,
          toMedianBuyTimeS: 180 + index * 120,
          fromSpreadS: 60,
          toSpreadS: 60,
        },
        evidence: 'STATLOCKER_SAME_PROFILE',
      }],
      terminalCandidates: [{
        itemId: family.targetItemId,
        kind: 'DEFAULT_TERMINAL',
        sourceProfileCount: 10,
        profileCoverage: 1,
        purchaseRate: 1,
        rawFrequencyTier: index < 5 ? 'CORE' : 'FREQUENT',
      }],
    })),
    items: familyInputs.map((family, index) => ({
      itemId: family.targetItemId,
      familyId: family.componentItemId,
      role: index < 5 ? 'CORE' : 'FREQUENT',
      sourceProfileCount: 10,
      profileCoverage: 1,
      purchaseRate: 1,
      timing: {
        medianBuyTimeS: 180 + index * 120,
        spreadS: 60,
        phase: index < 3 ? 'EARLY' : index < 6 ? 'MID' : 'LATE',
      },
      structuralPriority: 1,
    })),
    groups: [],
    orderEdges: [],
    relationships: [],
    quality: {
      support,
      coherence: 0.95,
      separation: 0.75,
      sourceProfileCount: 10,
    },
  };
}

const buildA = archetype(ARCHETYPE_A, archetypeAFamilies, 0.6);
const buildB = archetype(ARCHETYPE_B, archetypeBFamilies, 0.4);
const snapshot: BuildArchetypeSnapshotV2 = {
  snapshotId: 'snapshot-v2-a',
  heroId: HERO_ID,
  rulesetVersion: RULESET_ID,
  catalogSha256: CATALOG_SHA,
  statlockerPatchId: PATCH_ID,
  generatedAt: '2026-09-10T18:00:00.000Z',
  sourceProfileAccountIds: Array.from({ length: 10 }, (_, index) => `profile-${index + 1}`),
  archetypes: [buildA, buildB],
};

function matchupRows(preferredArchetypeId: string) {
  const rows: Array<{
    heroId: number;
    enemyHeroId: number;
    itemId: number;
    count: number;
    deltaWpa: number;
  }> = [];
  for (const enemyHeroId of ENEMY_HERO_IDS) {
    for (const item of buildA.items) {
      rows.push({
        heroId: HERO_ID,
        enemyHeroId,
        itemId: item.itemId,
        count: 100_000,
        deltaWpa: preferredArchetypeId === ARCHETYPE_A ? 0.12 : -0.12,
      });
    }
    for (const item of buildB.items) {
      rows.push({
        heroId: HERO_ID,
        enemyHeroId,
        itemId: item.itemId,
        count: 100_000,
        deltaWpa: preferredArchetypeId === ARCHETYPE_B ? 0.12 : -0.12,
      });
    }
  }
  return rows;
}

function liveDecision(enemyHeroIds: readonly number[]) {
  return {
    state: {
      decisionId: 'decision-v2-a',
      matchId: 'match-v2-a',
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
    catalogVersionId: 'catalog-v2-a',
    catalogSha256: CATALOG_SHA,
    rulesetId: RULESET_ID,
    localSteamId: 'steam-local',
    allyHeroIds: [1, 2, 3, 4, 5],
    enemyHeroIds: [...enemyHeroIds],
    enemyHeroes: enemyHeroIds.map((heroId) => ({ heroId })),
    enemyLiveStates: enemyHeroIds.map((heroId, index) => ({
      steamId: `enemy-${heroId}`,
      heroId,
      level: 8 + index,
      souls: 4_000 + index * 100,
      kills: index,
      deaths: 1,
      assists: 2,
      heroDamage: 3_000 + index * 250,
    })),
    allyItemIds: [],
    enemyItemIds: [],
    slots: {
      baseSlots: 0,
      baseSlotsByType: { weapon: 0, vitality: 0, spirit: 0 },
      maxFlexSlots: CAPACITY,
      maxActiveItems: 4,
      unlockedFlexSlots: CAPACITY,
      usedSlots: 0,
      usedSlotsByType: { weapon: 0, vitality: 0, spirit: 0 },
      usedByType: { weapon: 0, vitality: 0, spirit: 0 },
      overflowByType: { weapon: 0, vitality: 0, spirit: 0 },
      usedFlexSlots: 0,
      provedFlexLowerBound: CAPACITY,
      freeBaseSlots: 0,
      freeBaseSlotsByType: { weapon: 0, vitality: 0, spirit: 0 },
      freeBaseByType: { weapon: 0, vitality: 0, spirit: 0 },
      freeFlexSlots: CAPACITY,
      totalCapacity: CAPACITY,
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
    stateRevision: `state-${enemyHeroIds.length}`,
  };
}

function evidenceBundle() {
  const unavailable = (dataset: string) => ({
    dataset,
    scopeKey: `test:${dataset}`,
    freshness: 'UNAVAILABLE',
    confidence: 0,
  });
  return {
    heroId: HERO_ID,
    rulesetVersion: RULESET_ID,
    catalogSha256: CATALOG_SHA,
    statlockerPatchId: PATCH_ID,
    usable: true,
    snapshotIds: [],
    degradedReasons: ['WPA_PATCH_DATA:UNAVAILABLE', 'T4_CHAINS:UNAVAILABLE'],
    families: [],
    byDataset: {
      WPA_PATCH_DATA: unavailable('WPA_PATCH_DATA'),
      VS_HERO_WPA: unavailable('VS_HERO_WPA'),
      T4_CHAINS: unavailable('T4_CHAINS'),
      CONSENSUS_SKELETON: unavailable('CONSENSUS_SKELETON'),
      WPA_FILTERED_ITEMS: unavailable('WPA_FILTERED_ITEMS'),
    },
  };
}

function harness(resolverOverride?: { resolve(input: unknown): ResolvedFullBuildPlanV2 }) {
  let currentDecision = liveDecision(ENEMY_HERO_IDS.slice(0, 5));
  let currentRows = matchupRows(ARCHETYPE_A);
  let persistedLock: any;

  const decisionState = {
    build: jest.fn(async () => currentDecision),
  };
  const evidence = {
    resolveLocalPatchId: jest.fn(() => PATCH_ID),
    getLocalEvidence: jest.fn(() => evidenceBundle()),
  };
  const snapshotStore = {
    getActive: jest.fn(async () => snapshot),
    getActiveWithPatch: jest.fn(async () => ({ snapshot, statlockerPatchId: PATCH_ID })),
    getById: jest.fn(async (snapshotId: string) => {
      if (snapshotId !== snapshot.snapshotId) throw new Error(`Unknown snapshot ${snapshotId}`);
      return snapshot;
    }),
  };
  const wpaRepository = {
    findActive: jest.fn(async () => currentRows),
  };
  const sessionRepository = {
    findOne: jest.fn(async ({ where }: { where: { matchId: string; steamId: string } }) =>
      persistedLock?.matchId === where.matchId && persistedLock?.steamId === where.steamId
        ? persistedLock
        : null),
    create: jest.fn((value: any) => value),
    save: jest.fn(async (value: any) => {
      persistedLock = value;
      return value;
    }),
  };

  const matchup = new ThreatWeightedMatchupV1Service();
  const utility = new BuildItemUtilityV2Service(matchup);
  const selector = new BuildArchetypeSelectorV2Service();
  const session = new BuildArchetypeSessionV2Service(sessionRepository as any);
  const threat = new EnemyThreatV1Service();
  const discovery = new MatchupCandidateDiscoveryV2Service(utility, matchup);
  const resolver = resolverOverride ?? new FamilyFirstFullBuildResolverV2Service(utility);
  const traceStore = new BuildDebugTraceStoreV2Service();
  const service = new AdaptiveRecommendationV2Service(
    decisionState as any,
    evidence as any,
    snapshotStore as any,
    wpaRepository as any,
    selector,
    session,
    threat,
    discovery,
    resolver as any,
    traceStore,
  );
  const controller = new AdaptiveRecommendationV2Controller(
    service,
    { record: jest.fn().mockResolvedValue(undefined) } as any,
    { getState: () => undefined } as any,
    enabledAvailability(),
  );

  return {
    controller,
    traceStore,
    snapshotStore,
    wpaRepository,
    snapshot,
    setFullRoster() {
      currentDecision = liveDecision(ENEMY_HERO_IDS);
    },
    preferArchetype(archetypeId: string) {
      currentRows = matchupRows(archetypeId);
    },
  };
}

describe('Adaptive recommendation V2 endpoint', () => {
  it('uses the patch the snapshot was built for, not the newest one the evidence reports', async () => {
    // The evidence reports the newest patch, which can be one statlocker has only
    // just rolled to and for which nothing is built yet: on 2026-09-17 the
    // per-hero datasets moved to 698776157349216434 while all 145 archetype
    // snapshots and every WPA row were still on 676255623445218601. `getActive`
    // then found nothing and the whole match answered BUILD_ARCHETYPE_V2_UNAVAILABLE.
    const h = harness();
    h.setFullRoster();
    h.snapshotStore.getActiveWithPatch.mockResolvedValue({
      snapshot: h.snapshot,
      statlockerPatchId: 'patch-previous',
    });

    await h.controller.recommend({ matchId: 'match-v2-fallback', localSteamId: 'steam-local' });

    expect(h.wpaRepository.findActive).toHaveBeenCalledWith(
      expect.objectContaining({ statlockerPatchId: 'patch-previous' }),
    );
  });

  it('waits for a full enemy roster before the first immutable archetype lock', async () => {
    const h = harness();

    const result = await h.controller.recommend({ matchId: 'match-v2-a', localSteamId: 'steam-local' });

    expect(result.ready).toBe(false);
    expect(result.blockers).toContain('ENEMY_ROSTER_INCOMPLETE');
    expect(result.lock).toBeUndefined();
    expect(result.fullBuild).toBeUndefined();
  });

  it('locks once, keeps the same archetype after matchup evidence changes, and returns the family-first lifetime plan', async () => {
    const h = harness();
    h.setFullRoster();
    h.preferArchetype(ARCHETYPE_A);

    const first = await h.controller.recommend({ matchId: 'match-v2-a', localSteamId: 'steam-local' });

    expect(first.ready).toBe(true);
    expect(first.lock?.archetypeId).toBe(ARCHETYPE_A);
    expect(first.lock?.selectionMode).toBe('VS_HERO_WPA');
    expect(first.fullBuild?.desiredState).toBeDefined();
    expect(first.fullBuild?.mechanicalValidation?.valid).toBe(true);
    expect(first.fullBuild?.semanticValidation?.valid).toBe(true);
    expect(first.fullBuild?.steps.length).toBe(16);
    expect(first.fullBuild?.steps.every((step) => step.inventoryAfter.length <= CAPACITY)).toBe(true);
    expect(first.fullBuild?.validation.valid).toBe(true);
    expect(first.nextAction.type).toBe(first.fullBuild?.steps[0].action);
    expect((first as any).recommendedBuild).toBeUndefined();

    h.preferArchetype(ARCHETYPE_B);
    const second = await h.controller.recommend({ matchId: 'match-v2-a', localSteamId: 'steam-local' });

    expect(second.ready).toBe(true);
    expect(second.lock?.archetypeId).toBe(ARCHETYPE_A);
    expect(second.lock?.snapshotId).toBe(first.lock?.snapshotId);
    expect(second.fullBuild?.desiredState).toBeDefined();
    expect(second.fullBuild?.semanticValidation?.valid).toBe(true);
    expect(second.fullBuild?.steps.map((step) => step.buyItemId))
      .toEqual(first.fullBuild?.steps.map((step) => step.buyItemId));
    expect(h.traceStore.revisions('match-v2-a', 'steam-local')).toHaveLength(2);
    expect(h.traceStore.get('match-v2-a', 'steam-local')?.finalPlan?.desiredState).toBeDefined();
    expect(h.traceStore.get('match-v2-a', 'steam-local')?.finalPlan?.semanticValidation?.valid).toBe(true);
  });

  it('holds instead of exposing an action from a plan that failed validation', async () => {
    const invalidPlan: ResolvedFullBuildPlanV2 = {
      planRevision: 'invalid-plan',
      matchId: 'match-v2-a',
      heroId: HERO_ID,
      archetypeId: ARCHETYPE_A,
      stateRevision: 'state-6',
      steps: [{
        sequence: 1,
        action: 'BUY',
        buyItemId: 1,
        consumedItemIds: [],
        inventoryBefore: [],
        inventoryAfter: [1],
        reasonCodes: ['INVALID_TEST_STEP'],
      }],
      degradedReasons: [],
      validation: {
        valid: false,
        reasonCodes: ['REQUIRED_FAMILY_REGRESSION'],
      },
    };
    const h = harness({ resolve: jest.fn(() => invalidPlan) });
    h.setFullRoster();

    const result = await h.controller.recommend({
      matchId: 'match-v2-a',
      localSteamId: 'steam-local',
    });

    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual(['REQUIRED_FAMILY_REGRESSION']);
    expect(result.nextAction).toEqual({
      type: 'HOLD',
      reasonCodes: ['REQUIRED_FAMILY_REGRESSION'],
    });
    expect(result.fullBuild?.validation.valid).toBe(false);
    expect(result.fullBuild?.steps).toHaveLength(1);
  });
});
