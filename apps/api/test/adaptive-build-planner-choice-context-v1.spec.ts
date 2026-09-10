import {
  createRecommendationItemGraph,
  observedFact,
} from '@deadlock-live-probe/build-domain';
import { AdaptiveBuildPlannerV1Service } from '../src/statlocker-adaptive/adaptive-build-planner-v1.service';
import { AdaptiveChoiceResolverV1Service } from '../src/statlocker-adaptive/adaptive-choice-resolver-v1.service';
import { AdaptiveEvidenceScorerV1Service } from '../src/statlocker-adaptive/adaptive-evidence-scorer-v1.service';
import {
  RecommendationEconomyRulesV1,
  deriveAdaptiveInvestmentStateV1,
  deriveAdaptiveSlotStateV1,
  slotRulesFromEconomyRulesV1,
} from '../src/statlocker-adaptive/adaptive-economy-v1';

const catalogSha256 = 'a'.repeat(64);

const economyRules: RecommendationEconomyRulesV1 = {
  rulesetId: 'ruleset-a',
  catalogSha256,
  baseSlots: 0,
  baseSlotsByType: { weapon: 0, vitality: 0, spirit: 0 },
  maxFlexSlots: 12,
  maxActiveItems: 4,
  investmentBreakpoints: {
    weapon: [1600],
    vitality: [1600],
    spirit: [1600],
  },
};

function family(dataset: string, payload: unknown) {
  return {
    dataset,
    scopeKey: dataset === 'CONSENSUS_SKELETON' ? 'hero:10:consensus' : 'global',
    snapshotId: `${dataset}-snapshot`,
    contentSha256: 'b'.repeat(64),
    freshness: 'FRESH',
    confidence: 1,
    payload,
  } as any;
}

function evidence() {
  const candidates = [10, 20].map((itemId) => ({
    itemId,
    strength: 0.8,
    coverage: 0.8,
    purchaseRate: 0.8,
    medianBuyTimeS: 300,
    timingSpreadS: 60,
    sourceProfileCount: 10,
    frequencyTier: 'FREQUENT' as const,
    rushEvidence: false,
  }));
  const wpaItems = candidates.map((candidate) => ({
    heroId: 10,
    itemId: candidate.itemId,
    meanWpa: 0,
    sampleSize: 1000,
    wpaConfidence: 1,
    gameState: { even: 0 },
    purchaseTiming: { medianPurchaseSec: 300 },
  }));
  const byDataset = {
    WPA_PATCH_DATA: family('WPA_PATCH_DATA', { patchId: '15-1', items: wpaItems }),
    VS_HERO_WPA: family('VS_HERO_WPA', { slices: [] }),
    T4_CHAINS: family('T4_CHAINS', { chains: [] }),
    CONSENSUS_SKELETON: family('CONSENSUS_SKELETON', {
      heroId: 10,
      profileCount: 10,
      groups: [{
        groupId: 'early-choice',
        phase: 'EARLY',
        type: 'CHOICE',
        minSelect: 1,
        maxSelect: 1,
        candidates,
        confidence: 1,
        inferred: false,
      }],
    }),
    WPA_FILTERED_ITEMS: family('WPA_FILTERED_ITEMS', { heroId: 10, items: wpaItems }),
  };
  return {
    heroId: 10,
    rulesetVersion: 'ruleset-a',
    catalogSha256,
    statlockerPatchId: '15-1',
    usable: true,
    snapshotIds: Object.values(byDataset).map((entry) => entry.snapshotId),
    degradedReasons: [],
    families: Object.values(byDataset),
    byDataset,
  } as any;
}

function decision() {
  const itemGraph = createRecommendationItemGraph([10, 20].map((itemId) => ({
    itemId,
    name: `Item ${itemId}`,
    slotType: itemId === 10 ? 'weapon' as const : 'vitality' as const,
    active: false,
    availableRulesetIds: ['ruleset-a'],
    directPurchaseCost: 800,
    upgradeRecipes: [],
    sellTransition: { soulsRefund: 400, returnedItemIds: [] },
    maxCopies: 1,
  })));
  const state = {
    decisionId: 'decision-choice-context',
    matchId: 'match-choice-context',
    playerSlot: 0,
    gameTimeSec: 700,
    rulesetId: 'ruleset-a',
    heroId: 10,
    inventory: {
      initializedFromSnapshot: true,
      heldByItemId: new Map(),
      lifecycleCountByItemId: new Map(),
      nextInstanceSequence: 1,
    },
    economy: {
      spendableSouls: observedFact(5000, 'test'),
      shopOpportunity: observedFact('AVAILABLE' as const, 'test'),
    },
  };
  return {
    state,
    itemGraph,
    catalogVersionId: 'catalog-a',
    catalogSha256,
    rulesetId: 'ruleset-a',
    localSteamId: 'steam-a',
    enemyHeroIds: [],
    enemyLiveStates: [],
    ourTeamSouls: 100000,
    enemyTeamSouls: 100000,
    slots: deriveAdaptiveSlotStateV1([], itemGraph, slotRulesFromEconomyRulesV1(economyRules)),
    investment: deriveAdaptiveInvestmentStateV1([], itemGraph, economyRules),
    economyRules,
    economyRulesEvidence: 'RECONSTRUCTED' as const,
    stateRevision: 'revision-choice-context',
  } as any;
}

describe('AdaptiveBuildPlannerV1Service choice context wiring', () => {
  it('passes decision economy and verified investment context into branch resolution', () => {
    const scorer = new AdaptiveEvidenceScorerV1Service();
    const resolver = new AdaptiveChoiceResolverV1Service(scorer);
    const resolveSpy = jest.spyOn(resolver, 'resolveChoice');
    const planner = new AdaptiveBuildPlannerV1Service(scorer, undefined, resolver);
    const currentDecision = decision();

    planner.plan({
      decision: currentDecision,
      evidence: evidence(),
      suppressObservability: true,
    });

    expect(resolveSpy).toHaveBeenCalled();
    const context = resolveSpy.mock.calls[0][1];
    expect(context.decisionState).toBe(currentDecision.state);
    expect(context.investment).toBe(currentDecision.investment);
    expect(context.economyRules).toBe(currentDecision.economyRules);
  });
});
