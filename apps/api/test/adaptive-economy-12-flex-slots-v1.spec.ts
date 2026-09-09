import { createRecommendationItemGraph } from '@deadlock-live-probe/build-domain';
import {
  createCanonicalEconomyRulesV1,
  deriveAdaptiveSlotStateV1,
  slotRulesFromEconomyRulesV1,
} from '../src/statlocker-adaptive/adaptive-economy-v1';

const catalogSha256 = 'a'.repeat(64);

const graph = createRecommendationItemGraph(
  Array.from({ length: 13 }, (_, index) => ({
    itemId: index + 1,
    name: `Weapon ${index + 1}`,
    slotType: 'weapon' as const,
    active: false,
    availableRulesetIds: ['ruleset-a'],
    directPurchaseCost: 800,
    upgradeRecipes: [],
    sellTransition: { soulsRefund: 400, returnedItemIds: [] },
    maxCopies: 1,
  })),
);

describe('adaptive economy exact twelve flex slots', () => {
  it('defines canonical capacity as twelve fully flexible slots', () => {
    const economyRules = createCanonicalEconomyRulesV1('ruleset-a', catalogSha256);

    expect(economyRules.baseSlots).toBe(0);
    expect(economyRules.baseSlotsByType).toEqual({ weapon: 0, vitality: 0, spirit: 0 });
    expect(economyRules.maxFlexSlots).toBe(12);

    const slots = deriveAdaptiveSlotStateV1([], graph, slotRulesFromEconomyRulesV1(economyRules));
    expect(slots.baseSlots).toBe(0);
    expect(slots.unlockedFlexSlots).toBe(12);
    expect(slots.totalCapacity).toBe(12);
    expect(slots.freeFlexSlots).toBe(12);
  });

  it('normalizes a legacy persisted economy slot shape to twelve flex slots', () => {
    const legacyRules = {
      rulesetId: 'ruleset-a',
      catalogSha256,
      baseSlots: 12,
      baseSlotsByType: { weapon: 4, vitality: 4, spirit: 4 },
      maxFlexSlots: 4,
      maxActiveItems: 4,
      investmentBreakpoints: {
        weapon: [1600],
        vitality: [1600],
        spirit: [1600],
      },
    } as const;

    const slots = deriveAdaptiveSlotStateV1([], graph, slotRulesFromEconomyRulesV1(legacyRules));

    expect(slots.baseSlotsByType).toEqual({ weapon: 0, vitality: 0, spirit: 0 });
    expect(slots.maxFlexSlots).toBe(12);
    expect(slots.unlockedFlexSlots).toBe(12);
    expect(slots.totalCapacity).toBe(12);
  });

  it('keeps the twelve-slot game invariant when economy rules are unavailable', () => {
    const slots = deriveAdaptiveSlotStateV1([], graph, slotRulesFromEconomyRulesV1(undefined));

    expect(slots.baseSlotsByType).toEqual({ weapon: 0, vitality: 0, spirit: 0 });
    expect(slots.maxFlexSlots).toBe(12);
    expect(slots.unlockedFlexSlots).toBe(12);
    expect(slots.totalCapacity).toBe(12);
  });
});
