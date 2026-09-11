import {
  RecommendationItemDefinition,
  createRecommendationItemGraph,
} from '@deadlock-live-probe/build-domain';
import { BuildArchetypeV2 } from '../src/statlocker-adaptive/build-archetype-v2';
import { BuildItemUtilityV2Service } from '../src/statlocker-adaptive/build-item-utility-v2.service';
import { FullBuildResolverV2Service } from '../src/statlocker-adaptive/full-build-resolver-v2.service';
import { ThreatWeightedMatchupV1Service } from '../src/statlocker-adaptive/threat-weighted-matchup-v1.service';

const HERO_ID = 72;
const RULESET_ID = 'ruleset-a';
const BLOCKED_TARGET_ID = 5;
const TRANSITIONABLE_TARGET_ID = 6;

function directItem(itemId: number): RecommendationItemDefinition {
  return {
    itemId,
    name: `Item ${itemId}`,
    slotType: itemId % 3 === 0 ? 'spirit' : itemId % 3 === 1 ? 'weapon' : 'vitality',
    active: false,
    availableRulesetIds: [RULESET_ID],
    directPurchaseCost: 500,
    upgradeRecipes: [],
    sellTransition: { soulsRefund: 250, returnedItemIds: [] },
    maxCopies: 1,
  };
}

function archetype(): BuildArchetypeV2 {
  return {
    archetypeId: 'archetype:ranked-fallback',
    heroId: HERO_ID,
    rulesetVersion: RULESET_ID,
    catalogSha256: 'a'.repeat(64),
    statlockerPatchId: 'patch-a',
    sourceProfileAccountIds: Array.from({ length: 10 }, (_, index) => `p${index + 1}`),
    items: [
      {
        itemId: BLOCKED_TARGET_ID,
        familyId: BLOCKED_TARGET_ID,
        role: 'CORE',
        sourceProfileCount: 10,
        profileCoverage: 1,
        purchaseRate: 1,
        timing: { medianBuyTimeS: 600, spreadS: 30, phase: 'MID' },
        structuralPriority: 1,
      },
      {
        itemId: TRANSITIONABLE_TARGET_ID,
        familyId: TRANSITIONABLE_TARGET_ID,
        role: 'FREQUENT',
        sourceProfileCount: 10,
        profileCoverage: 1,
        purchaseRate: 0.9,
        timing: { medianBuyTimeS: 600, spreadS: 30, phase: 'MID' },
        structuralPriority: 0.9,
      },
    ],
    groups: [],
    orderEdges: [],
    relationships: [],
    quality: { support: 1, coherence: 0.9, separation: 0.4, sourceProfileCount: 10 },
  };
}

describe('FullBuildResolverV2Service lifetime branch fallback', () => {
  it('tries the next ranked semantic target when the highest-utility target cannot transition', () => {
    const definitions: RecommendationItemDefinition[] = [
      directItem(1),
      directItem(2),
      directItem(3),
      directItem(4),
      {
        itemId: BLOCKED_TARGET_ID,
        name: 'Blocked upgrade',
        slotType: 'weapon',
        active: false,
        availableRulesetIds: [RULESET_ID],
        upgradeRecipes: [{ recipeId: '4-to-5', consumedItemIds: [4], soulsCost: 1000 }],
        sellTransition: { soulsRefund: 500, returnedItemIds: [] },
        maxCopies: 1,
      },
      directItem(TRANSITIONABLE_TARGET_ID),
    ];
    const resolver = new FullBuildResolverV2Service(
      new BuildItemUtilityV2Service(new ThreatWeightedMatchupV1Service()),
    );

    const plan = resolver.resolve({
      matchId: 'ranked-fallback-match',
      stateRevision: 'revision-1',
      heroId: HERO_ID,
      rulesetId: RULESET_ID,
      archetype: archetype(),
      itemGraph: createRecommendationItemGraph(definitions),
      capacity: 3,
      gameTimeSec: 600,
      currentInventoryItemIds: [1, 2, 3],
      enemyHeroIds: [],
      enemyThreats: [],
      vsHeroRows: [],
      maxSteps: 1,
    });

    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({
      action: 'REPLACE',
      buyItemId: TRANSITIONABLE_TARGET_ID,
    });
    expect(plan.degradedReasons).not.toContain('LIFETIME_PROGRESS_BLOCKED');
  });
});
