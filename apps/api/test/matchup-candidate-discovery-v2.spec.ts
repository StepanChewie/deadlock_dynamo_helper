import {
  RecommendationCandidate,
  RecommendationItemDefinition,
  createRecommendationItemGraph,
} from '@deadlock-live-probe/build-domain';
import { BuildArchetypeV2 } from '../src/statlocker-adaptive/build-archetype-v2';
import { BuildItemUtilityV2Service } from '../src/statlocker-adaptive/build-item-utility-v2.service';
import { EnemyThreatScoreV1 } from '../src/statlocker-adaptive/enemy-threat-v1.service';
import { MatchupCandidateDiscoveryV2Service } from '../src/statlocker-adaptive/matchup-candidate-discovery-v2.service';
import { ThreatWeightedMatchupV1Service } from '../src/statlocker-adaptive/threat-weighted-matchup-v1.service';

const HERO_ID = 72;
const CORE_ITEM_ID = 1;
const FLEX_ITEM_ID = 2;
const COUNTER_ITEM_ID = 3;
const ENEMY_A = 27;
const ENEMY_B = 6;
const CATALOG_SHA = 'a'.repeat(64);

const itemDefinitions: RecommendationItemDefinition[] = [
  {
    itemId: CORE_ITEM_ID,
    name: 'Core',
    slotType: 'weapon',
    active: false,
    availableRulesetIds: ['ruleset-a'],
    directPurchaseCost: 800,
    upgradeRecipes: [],
    sellTransition: { soulsRefund: 400, returnedItemIds: [] },
  },
  {
    itemId: FLEX_ITEM_ID,
    name: 'Flex',
    slotType: 'vitality',
    active: false,
    availableRulesetIds: ['ruleset-a'],
    directPurchaseCost: 800,
    upgradeRecipes: [],
    sellTransition: { soulsRefund: 400, returnedItemIds: [] },
  },
  {
    itemId: COUNTER_ITEM_ID,
    name: 'Counter',
    slotType: 'spirit',
    active: false,
    availableRulesetIds: ['ruleset-a'],
    directPurchaseCost: 800,
    upgradeRecipes: [],
    sellTransition: { soulsRefund: 400, returnedItemIds: [] },
  },
];

const itemGraph = createRecommendationItemGraph(itemDefinitions);

function archetype(): BuildArchetypeV2 {
  return {
    archetypeId: 'archetype:test',
    heroId: HERO_ID,
    rulesetVersion: 'ruleset-a',
    catalogSha256: CATALOG_SHA,
    statlockerPatchId: 'patch-a',
    sourceProfileAccountIds: ['p1', 'p2', 'p3'],
    items: [
      {
        itemId: CORE_ITEM_ID,
        familyId: CORE_ITEM_ID,
        role: 'CORE',
        sourceProfileCount: 3,
        profileCoverage: 1,
        purchaseRate: 0.95,
        timing: { medianBuyTimeS: 420, spreadS: 60, phase: 'EARLY' },
        structuralPriority: 0.95,
      },
      {
        itemId: FLEX_ITEM_ID,
        familyId: FLEX_ITEM_ID,
        role: 'FLEX',
        sourceProfileCount: 2,
        profileCoverage: 0.67,
        purchaseRate: 0.45,
        timing: { medianBuyTimeS: 900, spreadS: 180, phase: 'MID' },
        structuralPriority: 0.35,
      },
    ],
    groups: [],
    orderEdges: [],
    relationships: [],
    quality: { support: 1, coherence: 0.9, separation: 0.4, sourceProfileCount: 3 },
  };
}

function threat(heroId: number, threatMultiplier = 1): EnemyThreatScoreV1 {
  const component = { weight: 0, contribution: 0, observed: false };
  return {
    steamId: `enemy-${heroId}`,
    heroId,
    rawThreatScore: threatMultiplier,
    threatMultiplier,
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

function candidate(
  action: RecommendationCandidate['action'],
  resultingItemIds: readonly number[],
): RecommendationCandidate {
  return {
    actionId: action.type === 'REPLACE_ITEM'
      ? `REPLACE_ITEM:${action.sellItemId}->${action.buyItemId}`
      : `BUY_ITEM:${COUNTER_ITEM_ID}`,
    action,
    feasible: true,
    reasons: ['FEASIBLE'],
    recommendationEligible: true,
    recommendationSuppressionReasons: [],
    effectiveCostSouls: 800,
    spendableSoulsAfter: 4200,
    resultingItemIds,
    evidence: {
      spendableSouls: 'OBSERVED',
      shopOpportunity: 'OBSERVED',
      ruleset: 'RECONSTRUCTED',
      inventory: 'OBSERVED',
      transaction: 'RECONSTRUCTED',
    },
  };
}

function service(): MatchupCandidateDiscoveryV2Service {
  const matchup = new ThreatWeightedMatchupV1Service();
  return new MatchupCandidateDiscoveryV2Service(
    new BuildItemUtilityV2Service(matchup),
    matchup,
  );
}

function input(
  legalCandidate: RecommendationCandidate,
  options: { count?: number; includeEnemyB?: boolean; deltaWpa?: number } = {},
) {
  const count = options.count ?? 1000;
  const includeEnemyB = options.includeEnemyB ?? true;
  const deltaWpa = options.deltaWpa ?? 0.09;
  return {
    heroId: HERO_ID,
    archetype: archetype(),
    legalByTarget: new Map([[COUNTER_ITEM_ID, legalCandidate]]),
    itemGraph,
    gameTimeSec: 720,
    ownedItemIds: [CORE_ITEM_ID, FLEX_ITEM_ID],
    projectedItemIds: [] as number[],
    enemyHeroIds: [ENEMY_A, ENEMY_B],
    enemyThreats: [threat(ENEMY_A, 1), threat(ENEMY_B, 1)],
    vsHeroRows: [
      { heroId: HERO_ID, enemyHeroId: ENEMY_A, itemId: COUNTER_ITEM_ID, count, deltaWpa },
      ...(includeEnemyB
        ? [{ heroId: HERO_ID, enemyHeroId: ENEMY_B, itemId: COUNTER_ITEM_ID, count, deltaWpa: 0.04 }]
        : []),
    ],
  };
}

describe('MatchupCandidateDiscoveryV2Service', () => {
  it('discovers a legal outside-archetype counter directly from Statlocker matchup evidence without situational windows', () => {
    const result = service().discover(input(
      candidate({ type: 'BUY_ITEM', itemId: COUNTER_ITEM_ID }, [CORE_ITEM_ID, FLEX_ITEM_ID, COUNTER_ITEM_ID]),
    ));

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      targetItemId: COUNTER_ITEM_ID,
      source: 'STATLOCKER_VS_HERO_WPA',
      replacement: false,
    });
    expect(result[0].matchup.coverage).toBe(1);
    expect(result[0].matchup.confidence).toBeGreaterThan(0);
    expect(result[0].reasonCodes).toContain('MATCHUP_DISCOVERY_OUTSIDE_ARCHETYPE');
  });

  it('rejects an outside-archetype candidate when enemy-roster coverage is below the discovery floor', () => {
    const legal = candidate(
      { type: 'BUY_ITEM', itemId: COUNTER_ITEM_ID },
      [CORE_ITEM_ID, FLEX_ITEM_ID, COUNTER_ITEM_ID],
    );
    const base = input(legal, { includeEnemyB: false });
    const lowCoverageEnemyHeroIds = [ENEMY_A, ENEMY_B, 7, 8, 9, 10];
    const result = service().discover({
      ...base,
      enemyHeroIds: lowCoverageEnemyHeroIds,
      enemyThreats: lowCoverageEnemyHeroIds.map((heroId) => threat(heroId, 1)),
    });

    expect(result).toEqual([]);
  });

  it('rejects tiny-sample and non-positive matchup evidence', () => {
    const tiny = service().discover(input(
      candidate({ type: 'BUY_ITEM', itemId: COUNTER_ITEM_ID }, [CORE_ITEM_ID, FLEX_ITEM_ID, COUNTER_ITEM_ID]),
      { count: 3 },
    ));
    const negative = service().discover(input(
      candidate({ type: 'BUY_ITEM', itemId: COUNTER_ITEM_ID }, [CORE_ITEM_ID, FLEX_ITEM_ID, COUNTER_ITEM_ID]),
      { deltaWpa: -0.10 },
    ));

    expect(tiny).toEqual([]);
    expect(negative).toEqual([]);
  });

  it('keeps replacement admission separate from final replacement choice and makes CORE replacement materially harder than FLEX replacement', () => {
    const flexReplacement = service().discover(input(candidate(
      { type: 'REPLACE_ITEM', sellItemId: FLEX_ITEM_ID, buyItemId: COUNTER_ITEM_ID },
      [CORE_ITEM_ID, COUNTER_ITEM_ID],
    )))[0];
    const coreReplacement = service().discover(input(candidate(
      { type: 'REPLACE_ITEM', sellItemId: CORE_ITEM_ID, buyItemId: COUNTER_ITEM_ID },
      [FLEX_ITEM_ID, COUNTER_ITEM_ID],
    )))[0];

    expect(flexReplacement).toBeDefined();
    expect(coreReplacement).toBeDefined();
    expect(flexReplacement.replacement).toBe(true);
    expect(coreReplacement.replacement).toBe(true);
    expect(coreReplacement.requiredImprovement).toBeGreaterThan(flexReplacement.requiredImprovement);
    expect(coreReplacement.reasonCodes).toContain('MATCHUP_DISCOVERY_CORE_REPLACEMENT');
  });

  it('does not rediscover items that already belong to the locked archetype', () => {
    const coreCandidate = candidate(
      { type: 'BUY_ITEM', itemId: CORE_ITEM_ID },
      [CORE_ITEM_ID, FLEX_ITEM_ID],
    );
    const result = service().discover({
      ...input(coreCandidate),
      legalByTarget: new Map([[CORE_ITEM_ID, coreCandidate]]),
      vsHeroRows: [
        { heroId: HERO_ID, enemyHeroId: ENEMY_A, itemId: CORE_ITEM_ID, count: 2000, deltaWpa: 0.12 },
        { heroId: HERO_ID, enemyHeroId: ENEMY_B, itemId: CORE_ITEM_ID, count: 2000, deltaWpa: 0.10 },
      ],
    });

    expect(result).toEqual([]);
  });
});