import {
  RecommendationItemDefinition,
  createRecommendationItemGraph,
} from '@deadlock-live-probe/build-domain';
import { BuildArchetypeV2 } from '../src/statlocker-adaptive/build-archetype-v2';
import { BuildItemUtilityV2Service } from '../src/statlocker-adaptive/build-item-utility-v2.service';
import { FamilyFirstFullBuildResolverV2Service } from '../src/statlocker-adaptive/family-first-full-build-resolver-v2.service';
import { ThreatWeightedMatchupV1Service } from '../src/statlocker-adaptive/threat-weighted-matchup-v1.service';

const HERO_ID = 72;
const REQUIRED = 101;
const OUTSIDE = 202;
const ENEMY_ID = 27;
const RULESET_ID = 'ruleset-a';

const itemGraph = createRecommendationItemGraph(
  [REQUIRED, OUTSIDE].map((itemId): RecommendationItemDefinition => ({
    itemId,
    name: `Item ${itemId}`,
    slotType: 'weapon',
    active: false,
    availableRulesetIds: [RULESET_ID],
    directPurchaseCost: 500,
    upgradeRecipes: [],
    sellTransition: { soulsRefund: 250, returnedItemIds: [] },
    maxCopies: 1,
  })),
);

function archetype(): BuildArchetypeV2 {
  return {
    archetypeId: 'archetype:outside-family-first',
    heroId: HERO_ID,
    rulesetVersion: RULESET_ID,
    catalogSha256: 'a'.repeat(64),
    statlockerPatchId: 'patch-a',
    sourceProfileAccountIds: ['profile-1'],
    families: [{
      familyId: REQUIRED,
      requirement: 'REQUIRED',
      aggregateFrequencyTier: 'CORE',
      sourceProfileCount: 1,
      profileCoverage: 1,
      purchaseRate: 1,
      structuralPriority: 1,
      progressionNodes: [{
        itemId: REQUIRED,
        rawFrequencyTier: 'CORE',
        progressionRole: 'DEFAULT_TERMINAL',
        sourceProfileCount: 1,
        profileCoverage: 1,
        purchaseRate: 1,
        timing: { medianBuyTimeS: 120, spreadS: 30, phase: 'EARLY' },
      }],
      terminalCandidates: [{
        itemId: REQUIRED,
        kind: 'DEFAULT_TERMINAL',
        sourceProfileCount: 1,
        profileCoverage: 1,
        purchaseRate: 1,
        rawFrequencyTier: 'CORE',
      }],
    }],
    items: [],
    groups: [],
    orderEdges: [],
    relationships: [],
    quality: { support: 1, coherence: 1, separation: 1, sourceProfileCount: 1 },
  };
}

function service(): FamilyFirstFullBuildResolverV2Service {
  return new FamilyFirstFullBuildResolverV2Service(
    new BuildItemUtilityV2Service(new ThreatWeightedMatchupV1Service()),
  );
}

function baseInput() {
  return {
    matchId: 'match-outside-family-first',
    stateRevision: 'state-1',
    heroId: HERO_ID,
    rulesetId: RULESET_ID,
    archetype: archetype(),
    itemGraph,
    capacity: 2,
    gameTimeSec: 600,
    currentInventoryItemIds: [] as number[],
    enemyHeroIds: [ENEMY_ID],
    enemyThreats: [{
      steamId: 'enemy-27',
      heroId: ENEMY_ID,
      rawThreatScore: 1,
      threatMultiplier: 1,
      completeness: 1,
      components: {
        souls: { weight: 0, contribution: 0, observed: false },
        heroDamage: { weight: 0, contribution: 0, observed: false },
        killsAssists: { weight: 0, contribution: 0, observed: false },
        level: { weight: 0, contribution: 0, observed: false },
        deaths: { weight: 0, contribution: 0, observed: false },
      },
      reasonCodes: [],
    }],
    vsHeroRows: [],
  };
}

function outsideBuyCandidate() {
  return {
    targetItemId: OUTSIDE,
    source: 'STATLOCKER_VS_HERO_WPA',
    candidate: {
      actionId: `BUY_ITEM:${OUTSIDE}`,
      action: { type: 'BUY_ITEM', itemId: OUTSIDE },
      feasible: true,
      reasons: ['FEASIBLE'],
      recommendationEligible: true,
      recommendationSuppressionReasons: [],
      effectiveCostSouls: 500,
      spendableSoulsAfter: 4500,
      resultingItemIds: [REQUIRED, OUTSIDE],
      evidence: {
        spendableSouls: 'OBSERVED',
        shopOpportunity: 'OBSERVED',
        ruleset: 'RECONSTRUCTED',
        inventory: 'OBSERVED',
        transaction: 'RECONSTRUCTED',
      },
    },
    matchup: { normalized: 0.4, confidence: 1, coverage: 1, score: 0.4, reasonCodes: [] },
    utility: { total: 0.4, confidence: 1, layers: {} },
    replacement: false,
    requiredImprovement: 0.08,
    reasonCodes: [
      'MATCHUP_DISCOVERY_OUTSIDE_ARCHETYPE',
      'MATCHUP_DISCOVERY_STATLOCKER_VS_HERO_WPA',
    ],
  } as any;
}

function outsideRequiredReplacementCandidate() {
  return {
    ...outsideBuyCandidate(),
    candidate: {
      ...outsideBuyCandidate().candidate,
      actionId: `REPLACE_ITEM:${REQUIRED}->${OUTSIDE}`,
      action: { type: 'REPLACE_ITEM', sellItemId: REQUIRED, buyItemId: OUTSIDE },
      resultingItemIds: [OUTSIDE],
    },
    replacement: true,
    sellItemId: REQUIRED,
    reasonCodes: [
      'MATCHUP_DISCOVERY_OUTSIDE_ARCHETYPE',
      'MATCHUP_DISCOVERY_STATLOCKER_VS_HERO_WPA',
      'MATCHUP_DISCOVERY_REPLACEMENT',
      'MATCHUP_DISCOVERY_CORE_REPLACEMENT',
    ],
  } as any;
}

describe('FamilyFirstFullBuildResolverV2Service outside candidates', () => {
  it('uses a strong Statlocker-backed outside candidate when optional capacity remains', () => {
    const result = service().resolve({
      ...baseInput(),
      outsideCandidates: [outsideBuyCandidate()],
    });

    expect(result.steps.map((step) => step.buyItemId)).toEqual([REQUIRED, OUTSIDE]);
    expect(result.steps[1].reasonCodes).toContain('MATCHUP_DISCOVERY_OUTSIDE_ARCHETYPE');
    expect(result.validation.valid).toBe(true);
  });

  it('rejects an outside replacement that would break a satisfied required family', () => {
    const result = service().resolve({
      ...baseInput(),
      capacity: 1,
      currentInventoryItemIds: [REQUIRED],
      outsideCandidates: [outsideRequiredReplacementCandidate()],
    });

    expect(result.steps).toHaveLength(0);
    expect(result.semanticValidation.valid).toBe(true);
    expect(result.validation.valid).toBe(true);
  });
});
