import {
  buildInventoryInstancesForRecommendation,
  createRecommendationItemGraph,
  generateRecommendationCandidates,
  observedFact,
} from '@dynamo-lab/build-domain';
import {
  ADAPTIVE_UNIVERSAL_SLOT_RULES_V1,
  candidateGeneratorRulesFromSlotStateV1,
  deriveAdaptiveSlotStateV1,
} from '../src/statlocker-adaptive/adaptive-economy-v1';

const graph = createRecommendationItemGraph([{
  itemId: 1,
  name: 'Active Item',
  slotType: 'weapon',
  active: true,
  availableRulesetIds: ['r1'],
  directPurchaseCost: 800,
  upgradeRecipes: [],
  sellTransition: { soulsRefund: 400, returnedItemIds: [] },
  maxCopies: 1,
}]);

describe('adaptive candidate rule evidence', () => {
  it('propagates unknown active-capacity mechanics instead of trusting fallback numeric limits', () => {
    const slots = deriveAdaptiveSlotStateV1(
      [],
      graph,
      ADAPTIVE_UNIVERSAL_SLOT_RULES_V1,
      { unlockedFlexSlots: 0, evidence: 'OBSERVED' },
    );
    const rules = candidateGeneratorRulesFromSlotStateV1(slots);
    const heldByItemId = buildInventoryInstancesForRecommendation([], graph);
    const candidates = generateRecommendationCandidates({
      state: {
        decisionId: 'd',
        matchId: 'm',
        playerSlot: 0,
        gameTimeSec: 100,
        rulesetId: 'r1',
        heroId: 1,
        inventory: {
          initializedFromSnapshot: true,
          heldByItemId,
          lifecycleCountByItemId: new Map(),
          nextInstanceSequence: 1,
        },
        economy: {
          spendableSouls: observedFact(5000, 'test'),
          shopOpportunity: observedFact('AVAILABLE', 'test'),
        },
      },
      itemGraph: graph,
      rules,
    });
    const buy = candidates.find((candidate) => candidate.actionId === 'BUY_ITEM:1');

    expect(rules.activeCapacityEvidence).toBe('UNKNOWN');
    expect(buy?.feasible).toBe(false);
    expect(buy?.reasons).toContain('ACTIVE_ITEM_CAPACITY_UNKNOWN');
  });
});
