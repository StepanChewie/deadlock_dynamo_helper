import { createRecommendationItemGraph } from '@deadlock-live-probe/build-domain';
import {
  AdaptiveChoiceResolverV1Service,
  reconstructChoiceStateV1,
} from '../src/statlocker-adaptive/adaptive-choice-resolver-v1.service';
import { AdaptiveEvidenceScorerV1Service } from '../src/statlocker-adaptive/adaptive-evidence-scorer-v1.service';
import { ConsensusBuildGroupV1 } from '../src/statlocker-adaptive/statlocker-adaptive.types';

function graph() {
  return createRecommendationItemGraph([
    {
      itemId: 1,
      name: 'Shared',
      slotType: 'weapon',
      active: false,
      availableRulesetIds: ['ruleset-a'],
      directPurchaseCost: 800,
      upgradeRecipes: [],
    },
    {
      itemId: 2,
      name: 'Unique A',
      slotType: 'weapon',
      active: false,
      availableRulesetIds: ['ruleset-a'],
      directPurchaseCost: 800,
      upgradeRecipes: [],
    },
    {
      itemId: 3,
      name: 'Unique B',
      slotType: 'weapon',
      active: false,
      availableRulesetIds: ['ruleset-a'],
      directPurchaseCost: 800,
      upgradeRecipes: [],
    },
    {
      itemId: 10,
      name: 'A',
      slotType: 'weapon',
      active: false,
      availableRulesetIds: ['ruleset-a'],
      directPurchaseCost: 3200,
      upgradeRecipes: [{ recipeId: 'a', consumedItemIds: [1, 2], soulsCost: 1600 }],
    },
    {
      itemId: 20,
      name: 'B',
      slotType: 'weapon',
      active: false,
      availableRulesetIds: ['ruleset-a'],
      directPurchaseCost: 3200,
      upgradeRecipes: [{ recipeId: 'b', consumedItemIds: [1, 3], soulsCost: 1600 }],
    },
  ]);
}

function choiceGroup(): ConsensusBuildGroupV1 {
  return {
    groupId: 'hero:10:MID:CHOICE:10,20',
    phase: 'MID',
    type: 'CHOICE',
    minSelect: 1,
    maxSelect: 1,
    confidence: 0.8,
    inferred: true,
    candidates: [10, 20].map((itemId) => ({
      itemId,
      strength: 0.7,
      coverage: 0.5,
      purchaseRate: 0.6,
      medianBuyTimeS: 800,
      timingSpreadS: 50,
      sourceProfileCount: 5,
      frequencyTier: 'FREQUENT' as const,
      rushEvidence: false,
    })),
  };
}

function family(dataset: string, payload: unknown) {
  return { dataset, scopeKey: 'global', freshness: 'FRESH', confidence: 1, payload } as any;
}

function matchup(normalized: number) {
  return {
    raw: normalized * 0.05,
    normalized,
    confidence: 1,
    coverage: 1,
    usedCount: 1,
    contributions: [],
  };
}

function evidence() {
  const group = choiceGroup();
  const items = group.candidates.map((candidate) => ({
    itemId: candidate.itemId,
    medianBuyTimeS: candidate.medianBuyTimeS,
    strength: candidate.strength,
    tier: candidate.frequencyTier,
    components: { coverage: 0.5, purchaseRate: 0.6, frequencyTier: 0.65, orderConsistency: 0.8, relationship: 0 },
  }));
  return {
    heroId: 10,
    rulesetVersion: 'ruleset-a',
    catalogSha256: 'a'.repeat(64),
    statlockerPatchId: '15-1',
    usable: true,
    snapshotIds: [],
    degradedReasons: [],
    families: [],
    draftMatchupByItemId: {
      '10': matchup(-0.4),
      '20': matchup(0.8),
    },
    byDataset: {
      WPA_PATCH_DATA: family('WPA_PATCH_DATA', {
        patchId: '15-1',
        items: [10, 20].map((itemId) => ({
          heroId: 10,
          itemId,
          meanWpa: 0,
          sampleSize: 1000,
          wpaConfidence: 1,
          gameState: {},
          purchaseTiming: { medianPurchaseSec: 800 },
        })),
      }),
      VS_HERO_WPA: family('VS_HERO_WPA', { slices: [] }),
      T4_CHAINS: family('T4_CHAINS', { chains: [] }),
      CONSENSUS_SKELETON: family('CONSENSUS_SKELETON', { heroId: 10, profileCount: 10, groups: [group], items }),
      WPA_FILTERED_ITEMS: family('WPA_FILTERED_ITEMS', { heroId: 10, items: [] }),
    },
  } as any;
}

function scorerContext() {
  return {
    heroId: 10,
    enemyHeroIds: [30],
    gameTimeSec: 800,
    gameStateBlend: { ahead: 0, even: 1, behind: 0 },
    ownedItemIds: [] as number[],
    plannedPrefixItemIds: [] as number[],
    evidence: evidence(),
  };
}

describe('AdaptiveChoiceResolverV1Service', () => {
  it('does not commit a branch from a component shared by all alternatives', () => {
    expect(reconstructChoiceStateV1(choiceGroup(), [1], graph())).toEqual(expect.objectContaining({
      committed: false,
      externallyDiverged: false,
    }));
  });

  it('commits from a branch-unique component or owned final target', () => {
    expect(reconstructChoiceStateV1(choiceGroup(), [2], graph())).toEqual(expect.objectContaining({
      committed: true,
      committedItemId: 10,
      selectedItemId: 10,
    }));
    expect(reconstructChoiceStateV1(choiceGroup(), [20], graph())).toEqual(expect.objectContaining({
      committed: true,
      committedItemId: 20,
    }));
  });

  it('preserves a valid previous committed branch when inventory indicates conflicting branches', () => {
    expect(reconstructChoiceStateV1(choiceGroup(), [2, 3], graph(), 20)).toEqual(expect.objectContaining({
      committed: true,
      committedItemId: 20,
      externallyDiverged: false,
    }));
    expect(reconstructChoiceStateV1(choiceGroup(), [2, 3], graph())).toEqual(expect.objectContaining({
      committed: false,
      externallyDiverged: true,
    }));
  });

  it('uses threat-weighted draft matchup evidence to choose between declared alternatives', () => {
    const service = new AdaptiveChoiceResolverV1Service(new AdaptiveEvidenceScorerV1Service());
    const result = service.resolveChoice(choiceGroup(), {
      scorerContext: scorerContext(),
      itemGraph: graph(),
      ownedItemIds: [],
    });

    expect(result.selectedItemId).toBe(20);
    expect(result.committed).toBe(false);
    expect(result.scores.find((entry) => entry.itemId === 20)?.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'draftMatchupFit', raw: expect.any(Number) }),
    ]));
  });

  it('retains an uncommitted previous choice when improvement is below local hysteresis', () => {
    const fakeScorer = {
      scoreItem: jest.fn((itemId: number) => ({
        itemId,
        score: itemId === 10 ? 1 : 1.05,
        confidence: 1,
        completeness: 1,
        components: [],
        version: 'adaptive-evidence-scorer-v1',
      })),
    } as any;
    const service = new AdaptiveChoiceResolverV1Service(fakeScorer);
    const result = service.resolveChoice(choiceGroup(), {
      scorerContext: scorerContext(),
      itemGraph: graph(),
      ownedItemIds: [],
      previousSelectedItemId: 10,
    });

    expect(result.selectedItemId).toBe(10);
  });

  it('does not promote an uncommitted previous selection when inventory has conflicting branch investment', () => {
    const service = new AdaptiveChoiceResolverV1Service(new AdaptiveEvidenceScorerV1Service());
    const result = service.resolveChoice(choiceGroup(), {
      scorerContext: scorerContext(),
      itemGraph: graph(),
      ownedItemIds: [2, 3],
      previousSelectedItemId: 10,
    });

    expect(result.committed).toBe(false);
    expect(result.committedItemId).toBeUndefined();
    expect(result.externallyDiverged).toBe(true);
  });

  it('never switches a committed branch during normal contextual resolution', () => {
    const service = new AdaptiveChoiceResolverV1Service(new AdaptiveEvidenceScorerV1Service());
    const result = service.resolveChoice(choiceGroup(), {
      scorerContext: scorerContext(),
      itemGraph: graph(),
      ownedItemIds: [2],
    });

    expect(result.selectedItemId).toBe(10);
    expect(result.committedItemId).toBe(10);
  });
});
