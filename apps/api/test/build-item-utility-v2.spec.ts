import { BuildArchetypeV2 } from '../src/statlocker-adaptive/build-archetype-v2';
import { BuildItemUtilityV2Service } from '../src/statlocker-adaptive/build-item-utility-v2.service';
import { EnemyThreatScoreV1 } from '../src/statlocker-adaptive/enemy-threat-v1.service';
import {
  StatlockerT4ChainsV1,
  StatlockerWpaPatchDataV1,
} from '../src/statlocker-adaptive/statlocker-adaptive.types';
import { ThreatWeightedMatchupV1Service } from '../src/statlocker-adaptive/threat-weighted-matchup-v1.service';

const HERO_ID = 72;
const ITEM_ID = 1002;
const PREDECESSOR_ID = 1001;
const ENEMY_A = 27;
const ENEMY_B = 6;
const CATALOG_SHA = 'a'.repeat(64);

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
        itemId: PREDECESSOR_ID,
        familyId: PREDECESSOR_ID,
        role: 'FREQUENT',
        sourceProfileCount: 3,
        profileCoverage: 1,
        purchaseRate: 0.8,
        timing: { medianBuyTimeS: 360, spreadS: 45, phase: 'EARLY' },
        structuralPriority: 0.7,
      },
      {
        itemId: ITEM_ID,
        familyId: ITEM_ID,
        role: 'CORE',
        sourceProfileCount: 3,
        profileCoverage: 1,
        purchaseRate: 0.95,
        timing: { medianBuyTimeS: 720, spreadS: 90, phase: 'MID' },
        structuralPriority: 0.95,
      },
    ],
    groups: [],
    orderEdges: [{
      beforeItemId: PREDECESSOR_ID,
      afterItemId: ITEM_ID,
      confidence: 0.9,
      sourceProfileCount: 3,
      strength: 'HARD',
    }],
    relationships: [{
      leftItemId: PREDECESSOR_ID,
      rightItemId: ITEM_ID,
      strength: 0.8,
      sourceProfileCount: 3,
    }],
    quality: { support: 1, coherence: 0.9, separation: 0.4, sourceProfileCount: 3 },
  };
}

function threat(heroId: number, threatMultiplier: number): EnemyThreatScoreV1 {
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

function wpaPatch(): StatlockerWpaPatchDataV1 {
  return {
    patchId: 'patch-a',
    items: [{
      heroId: HERO_ID,
      itemId: ITEM_ID,
      meanWpa: 0.04,
      sampleSize: 1500,
      wpaConfidence: 0.9,
      gameState: {},
      purchaseTiming: { medianPurchaseSec: 720 },
    }],
  };
}

function t4Chains(): StatlockerT4ChainsV1 {
  return {
    chains: [{
      heroId: HERO_ID,
      itemIds: [PREDECESSOR_ID, ITEM_ID],
      sampleSize: 900,
      meanWpa: 0.06,
    }],
  };
}

function baseInput() {
  return {
    heroId: HERO_ID,
    itemId: ITEM_ID,
    archetype: archetype(),
    gameTimeSec: 720,
    ownedItemIds: [PREDECESSOR_ID],
    projectedItemIds: [] as number[],
    enemyHeroIds: [ENEMY_A, ENEMY_B],
    enemyThreats: [threat(ENEMY_A, 1), threat(ENEMY_B, 1)],
    vsHeroRows: [
      { heroId: HERO_ID, enemyHeroId: ENEMY_A, itemId: ITEM_ID, count: 1000, deltaWpa: 0.09 },
      { heroId: HERO_ID, enemyHeroId: ENEMY_B, itemId: ITEM_ID, count: 1000, deltaWpa: -0.01 },
    ],
    wpaPatchData: wpaPatch(),
    t4Chains: t4Chains(),
    transition: {
      transactionPenalty: 0,
      churnPenalty: 0,
      recentPurchasePenalty: 0,
      replacementPenalty: 0,
    },
  };
}

function service(): BuildItemUtilityV2Service {
  return new BuildItemUtilityV2Service(new ThreatWeightedMatchupV1Service());
}

describe('BuildItemUtilityV2Service', () => {
  it('decomposes a CORE recommendation into structure, matchup, progression, and transition layers', () => {
    const result = service().scoreItem(baseInput());

    expect(result.itemId).toBe(ITEM_ID);
    expect(result.layers.structure.weighted).toBeGreaterThan(0);
    expect(result.layers.matchup.weighted).toBeGreaterThan(0);
    expect(result.layers.progression.weighted).toBeGreaterThan(0);
    expect(result.layers.transition.weighted).toBe(0);
    expect(result.reasonCodes).toContain('STRUCTURE_ARCHETYPE_CORE');
    expect(result.total).toBeCloseTo(
      result.layers.structure.weighted +
      result.layers.matchup.weighted +
      result.layers.progression.weighted +
      result.layers.transition.weighted,
      8,
    );
  });

  it('increases matchup value when the enemy helped by the item is currently more threatening', () => {
    const scorer = service();
    const neutral = scorer.scoreItem(baseInput());
    const weighted = scorer.scoreItem({
      ...baseInput(),
      enemyThreats: [threat(ENEMY_A, 1.5), threat(ENEMY_B, 0.75)],
    });

    expect(weighted.layers.matchup.weighted).toBeGreaterThan(neutral.layers.matchup.weighted);
  });

  it('strongly shrinks tiny-sample matchup evidence', () => {
    const scorer = service();
    const strong = scorer.scoreItem(baseInput());
    const tiny = scorer.scoreItem({
      ...baseInput(),
      vsHeroRows: baseInput().vsHeroRows.map((row) => ({ ...row, count: 3 })),
    });

    expect(strong.layers.matchup.confidence).toBeGreaterThan(tiny.layers.matchup.confidence);
    expect(Math.abs(strong.layers.matchup.weighted)).toBeGreaterThan(Math.abs(tiny.layers.matchup.weighted));
  });

  it('keeps transition costs explicit and lowers total utility without mutating evidence layers', () => {
    const scorer = service();
    const baseline = scorer.scoreItem(baseInput());
    const costly = scorer.scoreItem({
      ...baseInput(),
      transition: {
        transactionPenalty: 0.25,
        churnPenalty: 0.2,
        recentPurchasePenalty: 0.15,
        replacementPenalty: 0.1,
      },
    });

    expect(costly.layers.transition.weighted).toBeLessThan(0);
    expect(costly.layers.structure).toEqual(baseline.layers.structure);
    expect(costly.layers.matchup).toEqual(baseline.layers.matchup);
    expect(costly.layers.progression).toEqual(baseline.layers.progression);
    expect(costly.total).toBeLessThan(baseline.total);
  });

  it('remains useful when WPA is unavailable and exposes the degradation', () => {
    const result = service().scoreItem({
      ...baseInput(),
      vsHeroRows: [],
      wpaPatchData: undefined,
    });

    expect(result.layers.matchup.confidence).toBe(0);
    expect(result.layers.structure.weighted).toBeGreaterThan(0);
    expect(result.layers.progression.weighted).toBeGreaterThan(0);
    expect(result.reasonCodes).toContain('MATCHUP_WPA_UNAVAILABLE');
    expect(Number.isFinite(result.total)).toBe(true);
  });

  it('does not invalidate progression when T4 chain evidence is missing', () => {
    const result = service().scoreItem({ ...baseInput(), t4Chains: undefined });

    expect(result.layers.progression.confidence).toBeGreaterThan(0);
    expect(result.reasonCodes).toContain('PROGRESSION_T4_UNAVAILABLE');
    expect(Number.isFinite(result.total)).toBe(true);
  });
});
