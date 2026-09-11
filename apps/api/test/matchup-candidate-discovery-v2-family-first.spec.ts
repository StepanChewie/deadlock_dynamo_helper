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
const ENTRY_ITEM_ID = 10;
const TERMINAL_ITEM_ID = 11;
const ENEMY_ID = 27;

function threat(): EnemyThreatScoreV1 {
  const component = { weight: 0, contribution: 0, observed: false };
  return {
    steamId: 'enemy-27',
    heroId: ENEMY_ID,
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

function legalCandidate(): RecommendationCandidate {
  return {
    actionId: `BUY_ITEM:${TERMINAL_ITEM_ID}`,
    action: { type: 'BUY_ITEM', itemId: TERMINAL_ITEM_ID },
    feasible: true,
    reasons: ['FEASIBLE'],
    recommendationEligible: true,
    recommendationSuppressionReasons: [],
    effectiveCostSouls: 3_000,
    spendableSoulsAfter: 2_000,
    resultingItemIds: [TERMINAL_ITEM_ID],
    evidence: {
      spendableSouls: 'OBSERVED',
      shopOpportunity: 'OBSERVED',
      ruleset: 'RECONSTRUCTED',
      inventory: 'OBSERVED',
      transaction: 'RECONSTRUCTED',
    },
  };
}

describe('MatchupCandidateDiscoveryV2Service family-first boundary', () => {
  it('does not rediscover a progression or terminal node that belongs to the locked family when the legacy item projection is empty', () => {
    const definitions: RecommendationItemDefinition[] = [
      {
        itemId: ENTRY_ITEM_ID,
        name: 'Entry',
        slotType: 'weapon',
        active: false,
        availableRulesetIds: ['ruleset-a'],
        directPurchaseCost: 1_000,
        upgradeRecipes: [],
        sellTransition: { soulsRefund: 500, returnedItemIds: [] },
      },
      {
        itemId: TERMINAL_ITEM_ID,
        name: 'Terminal',
        slotType: 'weapon',
        active: false,
        availableRulesetIds: ['ruleset-a'],
        directPurchaseCost: 3_000,
        upgradeRecipes: [],
        sellTransition: { soulsRefund: 1_500, returnedItemIds: [] },
      },
    ];
    const graph = createRecommendationItemGraph(definitions);
    const archetype: BuildArchetypeV2 = {
      archetypeId: 'archetype:family-first',
      heroId: HERO_ID,
      rulesetVersion: 'ruleset-a',
      catalogSha256: 'a'.repeat(64),
      statlockerPatchId: 'patch-a',
      sourceProfileAccountIds: ['p1', 'p2', 'p3'],
      families: [{
        familyId: ENTRY_ITEM_ID,
        requirement: 'REQUIRED',
        aggregateFrequencyTier: 'CORE',
        sourceProfileCount: 3,
        profileCoverage: 1,
        purchaseRate: 1,
        structuralPriority: 1,
        progressionNodes: [
          {
            itemId: ENTRY_ITEM_ID,
            rawFrequencyTier: 'CORE',
            progressionRole: 'ENTRY',
            sourceProfileCount: 3,
            profileCoverage: 1,
            purchaseRate: 1,
            timing: { medianBuyTimeS: 300, spreadS: 30, phase: 'EARLY' },
          },
          {
            itemId: TERMINAL_ITEM_ID,
            rawFrequencyTier: 'CORE',
            progressionRole: 'DEFAULT_TERMINAL',
            sourceProfileCount: 3,
            profileCoverage: 1,
            purchaseRate: 1,
            timing: { medianBuyTimeS: 900, spreadS: 60, phase: 'MID' },
          },
        ],
        terminalCandidates: [{
          itemId: TERMINAL_ITEM_ID,
          kind: 'DEFAULT_TERMINAL',
          sourceProfileCount: 3,
          profileCoverage: 1,
          purchaseRate: 1,
          rawFrequencyTier: 'CORE',
        }],
      }],
      items: [],
      groups: [],
      orderEdges: [],
      relationships: [],
      quality: { support: 1, coherence: 1, separation: 1, sourceProfileCount: 3 },
    };
    const matchup = new ThreatWeightedMatchupV1Service();
    const service = new MatchupCandidateDiscoveryV2Service(
      new BuildItemUtilityV2Service(matchup),
      matchup,
    );

    const result = service.discover({
      heroId: HERO_ID,
      archetype,
      legalByTarget: new Map([[TERMINAL_ITEM_ID, legalCandidate()]]),
      itemGraph: graph,
      gameTimeSec: 720,
      ownedItemIds: [],
      projectedItemIds: [],
      enemyHeroIds: [ENEMY_ID],
      enemyThreats: [threat()],
      vsHeroRows: [{
        heroId: HERO_ID,
        enemyHeroId: ENEMY_ID,
        itemId: TERMINAL_ITEM_ID,
        count: 1_000,
        deltaWpa: 0.10,
      }],
    });

    expect(result).toEqual([]);
  });
});
