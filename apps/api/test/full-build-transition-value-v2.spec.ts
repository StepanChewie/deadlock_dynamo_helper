import { createRecommendationItemGraph } from '@dynamo-lab/build-domain';
import { BuildArchetypeV2 } from '../src/statlocker-adaptive/build-archetype-v2';
import { BuildItemUtilityV2 } from '../src/statlocker-adaptive/build-item-utility-v2.service';
import {
  FullBuildTransitionValueV2Service,
  replacementImprovementThreshold,
} from '../src/statlocker-adaptive/full-build-transition-value-v2.service';
import { STATLOCKER_BUILD_V2_CONFIG } from '../src/statlocker-adaptive/statlocker-build-v2.config';

const HERO_ID = 72;

function utility(itemId: number, total: number, confidence: number): BuildItemUtilityV2 {
  const emptyLayer = {
    raw: 0,
    normalized: 0,
    confidence: 0,
    weighted: 0,
    contributions: [],
  };
  return {
    itemId,
    total,
    confidence,
    layers: {
      structure: emptyLayer,
      matchup: emptyLayer,
      progression: emptyLayer,
      transition: emptyLayer,
    },
    reasonCodes: [],
  };
}

function archetype(): BuildArchetypeV2 {
  return {
    archetypeId: 'archetype:test',
    heroId: HERO_ID,
    rulesetVersion: 'r1',
    catalogSha256: 'a'.repeat(64),
    statlockerPatchId: 'p1',
    sourceProfileAccountIds: ['p1'],
    items: [],
    groups: [],
    orderEdges: [],
    relationships: [],
    quality: { support: 1, coherence: 1, separation: 1, sourceProfileCount: 1 },
  };
}

describe('FullBuildTransitionValueV2Service', () => {
  it('reproduces whole-inventory totals, marginal gain and resulting confidence for a REPLACE transition', () => {
    const scoreItem = jest.fn((input: { itemId: number; transition?: unknown }) => {
      if (input.itemId === 10) return utility(10, 0.4, 0.6);
      if (input.itemId === 20) return utility(20, 0.2, 0.8);
      if (input.itemId === 30) {
        return input.transition
          ? utility(30, 0.9, 0.9)
          : utility(30, 1.1, 0.9);
      }
      throw new Error(`Unexpected item ${input.itemId}`);
    });
    const service = new FullBuildTransitionValueV2Service({ scoreItem } as any);

    const result = service.evaluate({
      heroId: HERO_ID,
      archetype: archetype(),
      itemGraph: createRecommendationItemGraph([]),
      gameTimeSec: 1_800,
      currentInventoryItemIds: [20, 10],
      resultingInventoryItemIds: [30, 10],
      targetItemId: 30,
      enemyHeroIds: [],
      enemyThreats: [],
      vsHeroRows: [],
      transition: { transactionPenalty: 0.1, replacementPenalty: 0.2 },
    });

    expect(result.currentState.total).toBe(0.6);
    expect(result.currentState.confidence).toBe(0.7);
    expect(result.resultingState.total).toBe(1.3);
    expect(result.resultingState.confidence).toBe(0.75);
    expect(result.marginalGain).toBe(0.7);
    expect(scoreItem).toHaveBeenCalledTimes(4);
    expect(scoreItem.mock.calls.map(([input]) => input.itemId)).toEqual([10, 20, 10, 30]);
    expect(scoreItem.mock.calls[3][0].transition).toEqual({
      transactionPenalty: 0.1,
      replacementPenalty: 0.2,
    });
  });

  it('uses the higher configured threshold for CORE replacement', () => {
    expect(replacementImprovementThreshold('CORE')).toBe(
      STATLOCKER_BUILD_V2_CONFIG.fullBuildResolver.coreReplacementMinImprovement,
    );
  });

  it('uses the normal replacement threshold for non-CORE and unknown roles', () => {
    const expected = STATLOCKER_BUILD_V2_CONFIG.fullBuildResolver.replacementMinImprovement;
    expect(replacementImprovementThreshold('FREQUENT')).toBe(expected);
    expect(replacementImprovementThreshold('SITUATIONAL')).toBe(expected);
    expect(replacementImprovementThreshold('FLEX')).toBe(expected);
    expect(replacementImprovementThreshold(undefined)).toBe(expected);
  });
});
