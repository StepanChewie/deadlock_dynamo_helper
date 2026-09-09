import {
  createRecommendationItemGraph,
  observedFact,
  unknownFact,
} from '@deadlock-live-probe/build-domain';
import { AdaptiveChoiceResolverV1Service } from '../src/statlocker-adaptive/adaptive-choice-resolver-v1.service';
import { AdaptiveEvidenceScorerV1Service } from '../src/statlocker-adaptive/adaptive-evidence-scorer-v1.service';
import {
  RecommendationEconomyRulesV1,
  deriveAdaptiveInvestmentStateV1,
} from '../src/statlocker-adaptive/adaptive-economy-v1';
import { ConsensusBuildGroupV1 } from '../src/statlocker-adaptive/statlocker-adaptive.types';

const catalogSha256 = 'a'.repeat(64);

const itemGraph = createRecommendationItemGraph([
  {
    itemId: 1,
    name: 'Existing Weapon Investment',
    slotType: 'weapon',
    active: false,
    availableRulesetIds: ['ruleset-a'],
    directPurchaseCost: 1000,
    upgradeRecipes: [],
  },
  {
    itemId: 10,
    name: 'Expensive Vitality Branch',
    slotType: 'vitality',
    active: false,
    availableRulesetIds: ['ruleset-a'],
    directPurchaseCost: 3200,
    upgradeRecipes: [],
  },
  {
    itemId: 20,
    name: 'Affordable Weapon Branch',
    slotType: 'weapon',
    active: false,
    availableRulesetIds: ['ruleset-a'],
    directPurchaseCost: 800,
    upgradeRecipes: [],
  },
]);

const group: ConsensusBuildGroupV1 = {
  groupId: 'economy-investment-choice',
  phase: 'MID',
  type: 'CHOICE',
  minSelect: 1,
  maxSelect: 1,
  confidence: 1,
  inferred: false,
  candidates: [10, 20].map((itemId) => ({
    itemId,
    strength: 0.7,
    coverage: 0.8,
    purchaseRate: 0.8,
    medianBuyTimeS: 800,
    timingSpreadS: 60,
    sourceProfileCount: 10,
    frequencyTier: 'FREQUENT' as const,
    rushEvidence: false,
  })),
};

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

const investmentRules: RecommendationEconomyRulesV1 = {
  ...economyRules,
  investmentBreakpoints: {
    weapon: [1600],
    vitality: [4000],
    spirit: [1600],
  },
};

function family(dataset: string, payload: unknown) {
  return {
    dataset,
    scopeKey: 'global',
    freshness: 'FRESH',
    confidence: 1,
    payload,
  } as any;
}

function evidence() {
  const wpaItems = [10, 20].map((itemId) => ({
    heroId: 1,
    itemId,
    meanWpa: 0,
    sampleSize: 1000,
    wpaConfidence: 1,
    gameState: {},
    purchaseTiming: { medianPurchaseSec: 800 },
  }));
  return {
    heroId: 1,
    rulesetVersion: 'ruleset-a',
    catalogSha256,
    statlockerPatchId: 'patch-a',
    usable: true,
    snapshotIds: [],
    degradedReasons: [],
    families: [],
    byDataset: {
      WPA_PATCH_DATA: family('WPA_PATCH_DATA', { patchId: 'patch-a', items: wpaItems }),
      VS_HERO_WPA: family('VS_HERO_WPA', { slices: [] }),
      T4_CHAINS: family('T4_CHAINS', { chains: [] }),
      CONSENSUS_SKELETON: family('CONSENSUS_SKELETON', {
        heroId: 1,
        profileCount: 10,
        groups: [group],
        items: group.candidates.map((candidate) => ({
          itemId: candidate.itemId,
          medianBuyTimeS: candidate.medianBuyTimeS,
          strength: candidate.strength,
          tier: candidate.frequencyTier,
          components: {
            coverage: candidate.coverage,
            purchaseRate: candidate.purchaseRate,
            frequencyTier: 0.7,
            orderConsistency: 0.8,
            relationship: 0,
          },
        })),
      }),
      WPA_FILTERED_ITEMS: family('WPA_FILTERED_ITEMS', { heroId: 1, items: wpaItems }),
    },
  } as any;
}

function scorerContext(ownedItemIds: readonly number[]) {
  return {
    heroId: 1,
    enemyHeroIds: [],
    gameTimeSec: 800,
    gameStateBlend: { ahead: 0, even: 1, behind: 0 },
    ownedItemIds,
    plannedPrefixItemIds: [],
    evidence: evidence(),
  } as any;
}

function decisionState(ownedItemIds: readonly number[], wallet: number | undefined) {
  return {
    decisionId: 'choice-economy',
    matchId: 'match-choice-economy',
    playerSlot: 0,
    gameTimeSec: 800,
    rulesetId: 'ruleset-a',
    heroId: 1,
    inventory: {
      initializedFromSnapshot: true,
      heldByItemId: new Map(ownedItemIds.map((itemId, index) => [itemId, {
        itemId,
        instanceId: `item-${itemId}`,
        lifecycle: 1,
        acquiredBy: 'RECONCILE' as const,
        acquiredAtMs: index,
      }])),
      lifecycleCountByItemId: new Map(ownedItemIds.map((itemId) => [itemId, 1])),
      nextInstanceSequence: ownedItemIds.length + 1,
    },
    economy: {
      spendableSouls: wallet === undefined
        ? unknownFact<number>('test')
        : observedFact(wallet, 'test'),
      shopOpportunity: observedFact('AVAILABLE' as const, 'test'),
    },
  };
}

describe('AdaptiveChoiceResolverV1Service economy and investment', () => {
  const service = new AdaptiveChoiceResolverV1Service(new AdaptiveEvidenceScorerV1Service());

  it('prefers an immediately affordable declared branch when statistical evidence is tied', () => {
    const result = service.resolveChoice(group, {
      scorerContext: scorerContext([]),
      itemGraph,
      ownedItemIds: [],
      decisionState: decisionState([], 1000),
    } as any);

    expect(result.selectedItemId).toBe(20);
  });

  it('uses verified current investment to break a statistical tie between declared branches', () => {
    const ownedItemIds = [1];
    const result = service.resolveChoice(group, {
      scorerContext: scorerContext(ownedItemIds),
      itemGraph,
      ownedItemIds,
      decisionState: decisionState(ownedItemIds, 5000),
      investment: deriveAdaptiveInvestmentStateV1(ownedItemIds, itemGraph, investmentRules),
      economyRules: investmentRules,
    } as any);

    expect(result.selectedItemId).toBe(20);
    expect(result.scores.find((entry) => entry.itemId === 20)?.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'investmentUtility', weighted: expect.any(Number) }),
    ]));
    expect(
      result.scores.find((entry) => entry.itemId === 20)?.components
        .find((component) => component.key === 'investmentUtility')?.weighted,
    ).toBeGreaterThan(
      result.scores.find((entry) => entry.itemId === 10)?.components
        .find((component) => component.key === 'investmentUtility')?.weighted ?? 0,
    );
  });

  it('keeps economy neutral when spendable souls are unknown', () => {
    const result = service.resolveChoice(group, {
      scorerContext: scorerContext([]),
      itemGraph,
      ownedItemIds: [],
      decisionState: decisionState([], undefined),
    } as any);

    expect(result.selectedItemId).toBe(10);
  });
});
