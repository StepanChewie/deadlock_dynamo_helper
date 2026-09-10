import { createRecommendationItemGraph } from '@deadlock-live-probe/build-domain';
import { AdaptiveChoiceResolverV1Service } from '../src/statlocker-adaptive/adaptive-choice-resolver-v1.service';
import { AdaptiveEvidenceScorerV1Service } from '../src/statlocker-adaptive/adaptive-evidence-scorer-v1.service';
import { ConsensusBuildGroupV1 } from '../src/statlocker-adaptive/statlocker-adaptive.types';

const itemGraph = createRecommendationItemGraph([
  { itemId: 10, name: 'A', slotType: 'weapon', active: false, availableRulesetIds: ['r1'], directPurchaseCost: 800, upgradeRecipes: [] },
  { itemId: 20, name: 'B', slotType: 'vitality', active: false, availableRulesetIds: ['r1'], directPurchaseCost: 800, upgradeRecipes: [] },
  { itemId: 30, name: 'C', slotType: 'spirit', active: false, availableRulesetIds: ['r1'], directPurchaseCost: 800, upgradeRecipes: [] },
]);

const group: ConsensusBuildGroupV1 = {
  groupId: 'choice-two-of-three',
  phase: 'MID',
  type: 'CHOICE',
  minSelect: 2,
  maxSelect: 2,
  confidence: 1,
  inferred: false,
  candidates: [10, 20, 30].map((itemId) => ({
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

function fakeScorer(scores: Record<number, number>) {
  return {
    scoreItem: jest.fn((itemId: number) => ({
      itemId,
      score: scores[itemId] ?? 0,
      confidence: 1,
      completeness: 1,
      components: [],
      version: 'adaptive-evidence-scorer-v1',
    })),
  } as any;
}

function family(dataset: string, payload: unknown) {
  return { dataset, scopeKey: 'global', freshness: 'FRESH', confidence: 1, payload } as any;
}

function draftScore(normalized: number) {
  return { raw: normalized * 0.05, normalized, confidence: 1, coverage: 1, usedCount: 2, contributions: [] };
}

function realScorerContext() {
  const wpaItems = [10, 20, 30].map((itemId) => ({
    heroId: 1,
    itemId,
    meanWpa: 0,
    sampleSize: 1000,
    wpaConfidence: 1,
    gameState: {},
    purchaseTiming: { medianPurchaseSec: 800 },
  }));
  const evidence = {
    heroId: 1,
    rulesetVersion: 'r1',
    catalogSha256: 'a'.repeat(64),
    statlockerPatchId: 'patch-a',
    usable: true,
    snapshotIds: [],
    degradedReasons: [],
    families: [],
    draftMatchupByItemId: {
      '10': draftScore(-0.2),
      '20': draftScore(0.35),
      '30': draftScore(0.9),
    },
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
          components: { coverage: 0.8, purchaseRate: 0.8, frequencyTier: 0.7, orderConsistency: 0.8, relationship: 0 },
        })),
      }),
      WPA_FILTERED_ITEMS: family('WPA_FILTERED_ITEMS', { heroId: 1, items: wpaItems }),
    },
  } as any;

  return {
    heroId: 1,
    enemyHeroIds: [40, 50],
    enemyLiveStates: [],
    gameTimeSec: 800,
    gameStateBlend: { ahead: 0, even: 1, behind: 0 },
    ownedItemIds: [],
    plannedPrefixItemIds: [],
    evidence,
  } as any;
}

describe('AdaptiveChoiceResolverV1Service K-of-N', () => {
  it('selects exactly the required two best alternatives', () => {
    const service = new AdaptiveChoiceResolverV1Service(fakeScorer({ 10: 0.2, 20: 0.9, 30: 0.7 }));
    const result = service.resolveChoice(group, {
      scorerContext: {} as any,
      itemGraph,
      ownedItemIds: [],
    });

    expect(result.selectedItemIds).toEqual([20, 30]);
    expect(result.selectedItemIds).toHaveLength(2);
    expect(result.committedItemIds).toEqual([]);
  });

  it('uses threat-weighted draft evidence to select exactly K with the real scorer', () => {
    const service = new AdaptiveChoiceResolverV1Service(new AdaptiveEvidenceScorerV1Service());
    const result = service.resolveChoice(group, {
      scorerContext: realScorerContext(),
      itemGraph,
      ownedItemIds: [],
    });

    expect(result.selectedItemIds).toEqual([30, 20]);
    expect(result.selectedItemIds).toHaveLength(2);
    expect(result.scores.find((entry) => entry.itemId === 30)?.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'draftMatchupFit' }),
    ]));
  });

  it('keeps a committed choice and fills only the remaining required slot', () => {
    const service = new AdaptiveChoiceResolverV1Service(fakeScorer({ 10: 0.1, 20: 0.7, 30: 0.9 }));
    const result = service.resolveChoice(group, {
      scorerContext: {} as any,
      itemGraph,
      ownedItemIds: [10],
    });

    expect(result.committedItemIds).toEqual([10]);
    expect(result.selectedItemIds).toEqual([10, 30]);
    expect(result.selectedItemIds).toHaveLength(2);
  });

  it('marks state externally divergent when more branches are committed than maxSelect', () => {
    const service = new AdaptiveChoiceResolverV1Service(fakeScorer({ 10: 0.1, 20: 0.7, 30: 0.9 }));
    const result = service.resolveChoice(group, {
      scorerContext: {} as any,
      itemGraph,
      ownedItemIds: [10, 20, 30],
    });

    expect(result.externallyDiverged).toBe(true);
    expect(result.committed).toBe(false);
    expect(result.replacementOptions).toEqual([]);
  });
});
