import {
  RecommendationItemDefinition,
  createRecommendationItemGraph,
} from '@deadlock-live-probe/build-domain';
import { BuildArchetypeV2 } from '../src/statlocker-adaptive/build-archetype-v2';
import { FullBuildResolverV2Service } from '../src/statlocker-adaptive/full-build-resolver-v2.service';

const HERO_ID = 72;
const RULESET_ID = 'ruleset-a';
const OWNED_CORE_ID = 1;
const MANDATORY_CORE_ID = 4;

function item(itemId: number): RecommendationItemDefinition {
  return {
    itemId,
    name: `Item ${itemId}`,
    slotType: 'weapon',
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
    archetypeId: 'archetype:mandatory-core',
    heroId: HERO_ID,
    rulesetVersion: RULESET_ID,
    catalogSha256: 'a'.repeat(64),
    statlockerPatchId: 'patch-a',
    sourceProfileAccountIds: ['p1', 'p2'],
    items: [
      {
        itemId: OWNED_CORE_ID,
        familyId: OWNED_CORE_ID,
        role: 'CORE',
        sourceProfileCount: 2,
        profileCoverage: 1,
        purchaseRate: 1,
        timing: { medianBuyTimeS: 300, spreadS: 10, phase: 'EARLY' },
        structuralPriority: 1,
      },
      {
        itemId: MANDATORY_CORE_ID,
        familyId: MANDATORY_CORE_ID,
        role: 'CORE',
        sourceProfileCount: 2,
        profileCoverage: 1,
        purchaseRate: 1,
        timing: { medianBuyTimeS: 900, spreadS: 10, phase: 'MID' },
        structuralPriority: 1,
      },
    ],
    groups: [],
    orderEdges: [],
    relationships: [],
    quality: { support: 1, coherence: 1, separation: 1, sourceProfileCount: 2 },
  };
}

function utilityService() {
  return {
    scoreItem: jest.fn(({ itemId }: { itemId: number }) => ({
      itemId,
      total: itemId === MANDATORY_CORE_ID ? 1 : 10,
      confidence: 1,
      layers: {
        structure: { weighted: 0 },
        matchup: { weighted: 0 },
        progression: { weighted: 0 },
        transition: { weighted: 0 },
      },
      reasonCodes: [],
    })),
  } as any;
}

describe('FullBuildResolverV2Service mandatory core completion', () => {
  it('replaces a non-core item to reach a remaining CORE goal even when local utility drops', () => {
    const resolver = new FullBuildResolverV2Service(utilityService());
    const plan = resolver.resolve({
      matchId: 'mandatory-core-match',
      stateRevision: 'revision-1',
      heroId: HERO_ID,
      rulesetId: RULESET_ID,
      archetype: archetype(),
      itemGraph: createRecommendationItemGraph([item(1), item(2), item(3), item(4)]),
      capacity: 3,
      gameTimeSec: 900,
      currentInventoryItemIds: [OWNED_CORE_ID, 2, 3],
      enemyHeroIds: [],
      enemyThreats: [],
      vsHeroRows: [],
      maxSteps: 1,
    });

    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({
      action: 'REPLACE',
      buyItemId: MANDATORY_CORE_ID,
      sellItemId: 2,
    });
    expect(plan.steps[0].reasonCodes).toContain('MANDATORY_CORE_PROGRESSION_REPLACEMENT');
    expect(plan.degradedReasons).not.toContain('LIFETIME_PROGRESS_BLOCKED');
  });
});
