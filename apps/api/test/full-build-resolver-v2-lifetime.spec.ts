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
const A = 11;
const B = 22;
const D = 33;
const E = 44;
const F = 55;
const ENEMY_A = 27;
const ENEMY_B = 6;

const graph = createRecommendationItemGraph(
  [A, B, D, E, F].map((itemId): RecommendationItemDefinition => ({
    itemId,
    name: `Item ${itemId}`,
    slotType: 'weapon',
    active: false,
    availableRulesetIds: ['ruleset-a'],
    directPurchaseCost: 500,
    upgradeRecipes: [],
    sellTransition: { soulsRefund: 250, returnedItemIds: [] },
    maxCopies: 1,
  })),
);

function buildItem(
  itemId: number,
  role: BuildArchetypeItemV2['role'],
  phase: BuildArchetypeItemV2['timing']['phase'],
  medianBuyTimeS: number,
): BuildArchetypeItemV2 {
  return {
    itemId,
    familyId: itemId,
    role,
    sourceProfileCount: 10,
    profileCoverage: 1,
    purchaseRate: 1,
    timing: { medianBuyTimeS, spreadS: 60, phase },
    structuralPriority: 1,
  };
}

function archetype(): BuildArchetypeV2 {
  return {
    archetypeId: 'archetype:lifetime',
    heroId: HERO_ID,
    rulesetVersion: 'ruleset-a',
    catalogSha256: 'a'.repeat(64),
    statlockerPatchId: 'patch-a',
    sourceProfileAccountIds: Array.from({ length: 10 }, (_, index) => `p${index + 1}`),
    items: [
      buildItem(A, 'CORE', 'EARLY', 120),
      buildItem(B, 'CORE', 'EARLY', 240),
      buildItem(D, 'FREQUENT', 'MID', 720),
      buildItem(E, 'FREQUENT', 'MID', 720),
      buildItem(F, 'CORE', 'LATE', 1500),
    ],
    groups: [{
      groupId: 'choice:d-or-e',
      type: 'CHOICE',
      candidateItemIds: [D, E],
      minSelect: 1,
      maxSelect: 1,
      source: 'STATLOCKER_EXPLICIT',
      confidence: 1,
    }],
    orderEdges: [
      { beforeItemId: A, afterItemId: B, confidence: 1, sourceProfileCount: 10, strength: 'HARD' },
      { beforeItemId: B, afterItemId: D, confidence: 1, sourceProfileCount: 10, strength: 'HARD' },
      { beforeItemId: B, afterItemId: E, confidence: 1, sourceProfileCount: 10, strength: 'HARD' },
      { beforeItemId: D, afterItemId: F, confidence: 1, sourceProfileCount: 10, strength: 'HARD' },
      { beforeItemId: E, afterItemId: F, confidence: 1, sourceProfileCount: 10, strength: 'HARD' },
    ],
    relationships: [],
    quality: { support: 1, coherence: 1, separation: 0.5, sourceProfileCount: 10 },
  };
}

function threat(heroId: number): EnemyThreatScoreV1 {
  const component = { weight: 0, contribution: 0, observed: false };
  return {
    steamId: `enemy-${heroId}`,
    heroId,
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

describe('FullBuildResolverV2Service lifetime planning', () => {
  it('resolves A -> B -> (D OR E) -> F and continues after the selected CHOICE item', () => {
    const result = service().resolve({
      matchId: 'match-lifetime',
      stateRevision: 'state-1',
      heroId: HERO_ID,
      rulesetId: 'ruleset-a',
      archetype: archetype(),
      itemGraph: graph,
      capacity: 12,
      gameTimeSec: 600,
      currentInventoryItemIds: [],
      enemyHeroIds: [ENEMY_A, ENEMY_B],
      enemyThreats: [threat(ENEMY_A), threat(ENEMY_B)],
      vsHeroRows: [
        { heroId: HERO_ID, enemyHeroId: ENEMY_A, itemId: D, count: 100_000, deltaWpa: -0.30 },
        { heroId: HERO_ID, enemyHeroId: ENEMY_B, itemId: D, count: 100_000, deltaWpa: -0.30 },
        { heroId: HERO_ID, enemyHeroId: ENEMY_A, itemId: E, count: 100_000, deltaWpa: 0.30 },
        { heroId: HERO_ID, enemyHeroId: ENEMY_B, itemId: E, count: 100_000, deltaWpa: 0.30 },
      ],
    });

    expect(result.steps.map((step) => step.buyItemId)).toEqual([A, B, E, F]);
    expect(result.steps.map((step) => step.buyItemId)).not.toContain(D);
    expect(result.steps[2].reasonCodes).toContain('CHOICE_SELECTED');
    expect(result.steps[3].buyItemId).toBe(F);
    expect(result.validation.valid).toBe(true);
    expect(result.archetypeId).toBe('archetype:lifetime');
  });
});
