import { createRecommendationItemGraph } from '@dynamo-lab/build-domain';
import {
  deriveAdaptiveSlotStateV1,
  loadRecommendationEconomyRulesRegistryV1,
  resolveRecommendationEconomyRulesV1,
  slotRulesFromEconomyRulesV1,
} from '../src/statlocker-adaptive/adaptive-economy-v1';

const sha = 'a'.repeat(64);

function graph() {
  return createRecommendationItemGraph([
    ...[1, 2, 3, 4, 5].map((itemId) => ({
      itemId,
      name: `Weapon ${itemId}`,
      slotType: 'weapon' as const,
      active: false,
      availableRulesetIds: ['r1'],
      directPurchaseCost: 500,
      upgradeRecipes: [],
    })),
    {
      itemId: 10,
      name: 'Vitality Active',
      slotType: 'vitality' as const,
      active: true,
      availableRulesetIds: ['r1'],
      directPurchaseCost: 500,
      upgradeRecipes: [],
    },
  ]);
}

describe('ruleset-aware adaptive economy', () => {
  it('fails closed when the exact ruleset/catalog pair is unknown', () => {
    expect(resolveRecommendationEconomyRulesV1('missing', sha, [])).toBeUndefined();
    // Under the approved 12-slot capacity model (commit 40249886 / roadmap M0.4),
    // 12-slot capacity is independent of economy snapshots: flex slots default to 12.
    expect(slotRulesFromEconomyRulesV1(undefined)).toEqual({
      baseSlots: 0,
      baseSlotsByType: { weapon: 0, vitality: 0, spirit: 0 },
      maxFlexSlots: 12,
      maxActiveItems: 4,
      evidence: 'RECONSTRUCTED',
    });
  });

  it('accepts only an exact ruleset and catalog SHA match', () => {
    const registry = loadRecommendationEconomyRulesRegistryV1(JSON.stringify([{
      rulesetId: 'r1',
      catalogSha256: sha,
      baseSlotsByType: { weapon: 4, vitality: 4, spirit: 4 },
      maxFlexSlots: 4,
      maxActiveItems: 4,
      investmentBreakpoints: { weapon: [4800], vitality: [4800], spirit: [4800] },
      source: 'fixture',
    }]));

    expect(resolveRecommendationEconomyRulesV1('r1', sha, registry)?.source).toBe('fixture');
    expect(resolveRecommendationEconomyRulesV1('r2', sha, registry)).toBeUndefined();
    expect(resolveRecommendationEconomyRulesV1('r1', 'b'.repeat(64), registry)).toBeUndefined();
  });

  it('computes flex overflow per category rather than from total item count', () => {
    const slotRules = {
      baseSlotsByType: { weapon: 4, vitality: 4, spirit: 4 },
      maxFlexSlots: 4,
      maxActiveItems: 4,
      evidence: 'RECONSTRUCTED' as const,
    };
    const slots = deriveAdaptiveSlotStateV1([1, 2, 3, 4, 5, 10], graph(), slotRules, {
      unlockedFlexSlots: 2,
      evidence: 'OBSERVED',
    });

    expect(slots.usedByType).toEqual({ weapon: 5, vitality: 1, spirit: 0 });
    expect(slots.usedFlexSlots).toBe(1);
    expect(slots.freeBaseByType).toEqual({ weapon: 0, vitality: 3, spirit: 4 });
    expect(slots.freeFlexSlots).toBe(1);
    expect(slots.usedActiveItems).toBe(1);
  });

  it('preserves unknown flex unlock evidence even when slot topology is verified', () => {
    const slots = deriveAdaptiveSlotStateV1([1, 2, 3, 4, 5], graph(), {
      baseSlotsByType: { weapon: 4, vitality: 4, spirit: 4 },
      maxFlexSlots: 4,
      maxActiveItems: 4,
      evidence: 'RECONSTRUCTED',
    });

    expect(slots.usedFlexSlots).toBe(1);
    expect(slots.provedFlexLowerBound).toBe(1);
    expect(slots.freeFlexSlots).toBeUndefined();
    expect(slots.flexEvidence).toBe('UNKNOWN');
  });

  it('parses a pinned upgrade pricing policy from the exact ruleset registry', () => {
    const registry = loadRecommendationEconomyRulesRegistryV1(JSON.stringify([{
      rulesetId: 'r1',
      catalogSha256: sha,
      baseSlotsByType: { weapon: 4, vitality: 4, spirit: 4 },
      maxFlexSlots: 4,
      maxActiveItems: 4,
      investmentBreakpoints: { weapon: [4800], vitality: [4800], spirit: [4800] },
      upgradePricingPolicy: {
        mode: 'TARGET_COST_MINUS_VERIFIED_COMPONENT_CREDIT',
        componentCreditRatio: 1,
        evidence: 'RECONSTRUCTED',
      },
      source: 'fixture',
    }]));

    expect(registry[0].upgradePricingPolicy).toMatchObject({
      mode: 'TARGET_COST_MINUS_VERIFIED_COMPONENT_CREDIT',
      componentCreditRatio: 1,
      evidence: 'RECONSTRUCTED',
    });
  });
});
