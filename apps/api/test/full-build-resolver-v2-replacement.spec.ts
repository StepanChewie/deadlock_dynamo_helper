import {
  RecommendationItemDefinition,
  createRecommendationItemGraph,
} from '@deadlock-live-probe/build-domain';
import {
  BuildArchetypeItemV2,
  BuildArchetypeV2,
} from '../src/statlocker-adaptive/build-archetype-v2';
import { BuildItemUtilityV2Service } from '../src/statlocker-adaptive/build-item-utility-v2.service';
import { EnemyThreatScoreV1 } from '../src/statlocker-adaptive/enemy-threat-v1.service';
import { FullBuildResolverV2Service } from '../src/statlocker-adaptive/full-build-resolver-v2.service';
import { ThreatWeightedMatchupV1Service } from '../src/statlocker-adaptive/threat-weighted-matchup-v1.service';

const HERO_ID = 72;
const A = 101;
const B = 102;
const C = 103;
const M = 104;
const ENEMY = 27;

const graph = createRecommendationItemGraph([
  { itemId: A, name: 'Cheap core A', directPurchaseCost: 100 },
  { itemId: B, name: 'Core B', directPurchaseCost: 1000 },
  { itemId: C, name: 'Expensive flex C', directPurchaseCost: 3000 },
  { itemId: M, name: 'Desired M', directPurchaseCost: 2000 },
].map((source): RecommendationItemDefinition => ({
  ...source,
  slotType: 'weapon',
  active: false,
  availableRulesetIds: ['ruleset-a'],
  upgradeRecipes: [],
  sellTransition: { soulsRefund: Math.floor(source.directPurchaseCost / 2), returnedItemIds: [] },
  maxCopies: 1,
})));

function item(
  itemId: number,
  role: BuildArchetypeItemV2['role'],
  structuralPriority: number,
): BuildArchetypeItemV2 {
  return {
    itemId,
    familyId: itemId,
    role,
    sourceProfileCount: role === 'FLEX' ? 3 : 10,
    profileCoverage: role === 'FLEX' ? 0.3 : 1,
    purchaseRate: role === 'FLEX' ? 0.3 : 1,
    timing: { medianBuyTimeS: 900, spreadS: 90, phase: 'MID' },
    structuralPriority,
  };
}

function archetype(): BuildArchetypeV2 {
  return {
    archetypeId: 'archetype:replacement',
    heroId: HERO_ID,
    rulesetVersion: 'ruleset-a',
    catalogSha256: 'b'.repeat(64),
    statlockerPatchId: 'patch-a',
    sourceProfileAccountIds: Array.from({ length: 10 }, (_, index) => `p${index + 1}`),
    items: [
      item(A, 'CORE', 1),
      item(B, 'CORE', 1),
      item(C, 'FLEX', 0.1),
      item(M, 'CORE', 1),
    ],
    groups: [],
    orderEdges: [
      { beforeItemId: A, afterItemId: M, confidence: 1, sourceProfileCount: 10, strength: 'HARD' },
      { beforeItemId: B, afterItemId: M, confidence: 1, sourceProfileCount: 10, strength: 'HARD' },
    ],
    relationships: [],
    quality: { support: 1, coherence: 1, separation: 0.5, sourceProfileCount: 10 },
  };
}

function threat(): EnemyThreatScoreV1 {
  const component = { weight: 0, contribution: 0, observed: false };
  return {
    steamId: 'enemy',
    heroId: ENEMY,
    rawThreatScore: 1,
    threatMultiplier: 1,
    completeness: 1,
    components: {
      souls: component,
      heroDamage: component,
      killsAssists: component,
      level: component,
      deaths: component,
    },
    reasonCodes: [],
  };
}

function service(): FullBuildResolverV2Service {
  return new FullBuildResolverV2Service(
    new BuildItemUtilityV2Service(new ThreatWeightedMatchupV1Service()),
  );
}

describe('FullBuildResolverV2Service lifetime replacement search', () => {
  it('sells the lowest whole-inventory utility item instead of the cheapest item', () => {
    const result = service().resolve({
      matchId: 'match-replacement',
      stateRevision: 'state-1',
      heroId: HERO_ID,
      rulesetId: 'ruleset-a',
      archetype: archetype(),
      itemGraph: graph,
      capacity: 3,
      gameTimeSec: 900,
      currentInventoryItemIds: [A, B, C],
      enemyHeroIds: [ENEMY],
      enemyThreats: [threat()],
      vsHeroRows: [
        { heroId: HERO_ID, enemyHeroId: ENEMY, itemId: C, count: 100_000, deltaWpa: -0.40 },
        { heroId: HERO_ID, enemyHeroId: ENEMY, itemId: M, count: 100_000, deltaWpa: 0.40 },
      ],
    });

    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({
      action: 'REPLACE',
      sellItemId: C,
      buyItemId: M,
    });
    expect(result.steps[0].sellItemId).not.toBe(A);
    expect(result.steps[0].inventoryAfter).toEqual([A, B, M]);
    expect(result.steps[0].reasonCodes).toContain('WHOLE_INVENTORY_REPLACEMENT_SELECTED');
    expect(result.validation.valid).toBe(true);
  });
});
