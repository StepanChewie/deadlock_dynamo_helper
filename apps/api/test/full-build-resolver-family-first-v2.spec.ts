import {
  RecommendationItemDefinition,
  createRecommendationItemGraph,
} from '@deadlock-live-probe/build-domain';
import { BuildArchetypeV2 } from '../src/statlocker-adaptive/build-archetype-v2';
import { BuildItemUtilityV2Service } from '../src/statlocker-adaptive/build-item-utility-v2.service';
import { FamilyFirstFullBuildResolverV2Service } from '../src/statlocker-adaptive/family-first-full-build-resolver-v2.service';
import { ThreatWeightedMatchupV1Service } from '../src/statlocker-adaptive/threat-weighted-matchup-v1.service';

const HERO_ID = 72;
const A = 101;
const B = 102;
const C = 103;
const D = 104;

function item(
  itemId: number,
  recipe?: { recipeId: string; consumedItemIds: readonly number[] },
): RecommendationItemDefinition {
  return {
    itemId,
    name: `item-${itemId}`,
    slotType: 'weapon',
    active: true,
    availableRulesetIds: ['r1'],
    directPurchaseCost: recipe ? undefined : 500,
    upgradeRecipes: recipe ? [{ ...recipe, soulsCost: 1_000 }] : [],
    sellTransition: { soulsRefund: 250, returnedItemIds: [] },
    maxCopies: 1,
  };
}

const itemGraph = createRecommendationItemGraph([
  item(A),
  item(B, { recipeId: 'A-to-B', consumedItemIds: [A] }),
  item(C, { recipeId: 'B-to-C', consumedItemIds: [B] }),
  item(D, { recipeId: 'C-to-D', consumedItemIds: [C] }),
]);

function archetype(): BuildArchetypeV2 {
  return {
    archetypeId: 'archetype:family-first',
    heroId: HERO_ID,
    rulesetVersion: 'r1',
    catalogSha256: 'a'.repeat(64),
    statlockerPatchId: 'p1',
    sourceProfileAccountIds: ['p1', 'p2'],
    families: [{
      familyId: A,
      requirement: 'REQUIRED',
      aggregateFrequencyTier: 'CORE',
      sourceProfileCount: 2,
      profileCoverage: 1,
      purchaseRate: 1,
      structuralPriority: 1,
      progressionNodes: [
        { itemId: A, rawFrequencyTier: 'CORE', progressionRole: 'ENTRY', sourceProfileCount: 2, profileCoverage: 1, purchaseRate: 1, timing: { medianBuyTimeS: 300, spreadS: 30, phase: 'EARLY' } },
        { itemId: B, rawFrequencyTier: 'CORE', progressionRole: 'INTERMEDIATE', sourceProfileCount: 2, profileCoverage: 1, purchaseRate: 1, timing: { medianBuyTimeS: 700, spreadS: 30, phase: 'MID' } },
        { itemId: C, rawFrequencyTier: 'FREQUENT', progressionRole: 'DEFAULT_TERMINAL', sourceProfileCount: 2, profileCoverage: 1, purchaseRate: 0.9, timing: { medianBuyTimeS: 1_200, spreadS: 60, phase: 'MID' } },
        { itemId: D, rawFrequencyTier: 'SOMETIMES', progressionRole: 'OPTIONAL_TERMINAL', sourceProfileCount: 1, profileCoverage: 0.5, purchaseRate: 0.4, timing: { medianBuyTimeS: 1_800, spreadS: 90, phase: 'LATE' } },
      ],
      terminalCandidates: [
        { itemId: C, kind: 'DEFAULT_TERMINAL', sourceProfileCount: 2, profileCoverage: 1, purchaseRate: 0.9, rawFrequencyTier: 'FREQUENT' },
        { itemId: D, kind: 'OPTIONAL_TERMINAL', sourceProfileCount: 1, profileCoverage: 0.5, purchaseRate: 0.4, rawFrequencyTier: 'SOMETIMES' },
      ],
    }],
    items: [],
    groups: [],
    orderEdges: [],
    relationships: [],
    quality: { support: 1, coherence: 1, separation: 1, sourceProfileCount: 2 },
  };
}

function input(vsHeroRows: readonly any[] = []) {
  return {
    matchId: 'match-1',
    stateRevision: 'state-1',
    heroId: HERO_ID,
    rulesetId: 'r1',
    archetype: archetype(),
    itemGraph,
    capacity: 12,
    gameTimeSec: 1_000,
    currentInventoryItemIds: [] as readonly number[],
    enemyHeroIds: [1, 2, 3, 4, 5, 6],
    enemyThreats: [],
    vsHeroRows,
    outsideCandidates: [],
  };
}

function optionalTerminalRows(deltaWpa: number) {
  return [1, 2, 3, 4, 5, 6].map((enemyHeroId) => ({
    heroId: HERO_ID,
    enemyHeroId,
    itemId: D,
    count: 100_000,
    deltaWpa,
  }));
}

describe('FamilyFirstFullBuildResolverV2Service lifetime mode', () => {
  it('returns desired state and semantic validation for a required family lineage', () => {
    const matchup = new ThreatWeightedMatchupV1Service();
    const resolver = new FamilyFirstFullBuildResolverV2Service(new BuildItemUtilityV2Service(matchup));

    const result = resolver.resolve(input());

    expect(result.desiredState?.families).toEqual([
      expect.objectContaining({
        familyId: A,
        selectedTerminalItemId: C,
        selectedTerminalKind: 'DEFAULT_TERMINAL',
      }),
    ]);
    expect(result.steps.map((step) => [step.action, step.buyItemId])).toEqual([
      ['BUY', A],
      ['UPGRADE', B],
      ['UPGRADE', C],
    ]);
    expect(result.mechanicalValidation?.valid).toBe(true);
    expect(result.semanticValidation?.valid).toBe(true);
    expect(result.validation.valid).toBe(true);
  });

  it('holds a near-term previous plan for a small optional-terminal improvement and switches for a material one', () => {
    const matchup = new ThreatWeightedMatchupV1Service();
    const resolver = new FamilyFirstFullBuildResolverV2Service(new BuildItemUtilityV2Service(matchup));
    const previous = resolver.resolve(input());

    const held = resolver.resolve({
      ...input(optionalTerminalRows(0.015)),
      previousPlan: previous,
    });
    expect(held.planRevision).toBe(previous.planRevision);
    expect(held.desiredState?.families[0].selectedTerminalItemId).toBe(C);

    const switched = resolver.resolve({
      ...input(optionalTerminalRows(0.06)),
      previousPlan: previous,
    });
    expect(switched.planRevision).not.toBe(previous.planRevision);
    expect(switched.desiredState?.families[0].selectedTerminalItemId).toBe(D);
  });
});
