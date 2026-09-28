import { createRecommendationItemGraph } from '@dynamo-lab/build-domain';
import { BuildArchetypeV2 } from '../src/statlocker-adaptive/build-archetype-v2';
import {
  SituationalItemsSelectionV2Service,
  SituationalSelectionInputV2,
  SITUATIONAL_AGAINST_LIMIT_V2,
  SITUATIONAL_ITEM_LIMIT_V2,
} from '../src/statlocker-adaptive/situational-items-selection-v2.service';
import { ThreatWeightedMatchupV1Service } from '../src/statlocker-adaptive/threat-weighted-matchup-v1.service';

const HERO_ID = 13;
const RULESET_ID = 'ruleset-test';

function itemDefinition(itemId: number) {
  return {
    itemId,
    name: `Item ${itemId}`,
    slotType: 'weapon' as const,
    active: true,
    availableRulesetIds: [RULESET_ID],
    upgradeRecipes: [],
  };
}

// Only `items[].itemId` and `items[].role` are read, so the rest of the
// archetype is cast away rather than fabricated.
function archetypeWithRoles(roles: Readonly<Record<number, string>>): BuildArchetypeV2 {
  return {
    items: Object.entries(roles).map(([itemId, role]) => ({
      itemId: Number(itemId),
      familyId: 1,
      role,
    })),
  } as unknown as BuildArchetypeV2;
}

// count drives sampleConfidence and deltaWpa drives the score: the score rises
// with deltaWpa and is damped by sampleConfidence, which shrinks toward zero for
// small samples.
//
// The default is the **measured** real sample size — 60 is the mean and 31 the
// median of a (hero, item, enemy) row in the dataset — not a comfortable round
// number. An earlier revision used 2000, which is roughly thirty times the real
// figure: it made every gate pass, and that is precisely how a confidence floor
// that rejected every real match stayed green in the suite.
function row(itemId: number, enemyHeroId: number, deltaWpa: number, count = 60) {
  return { heroId: HERO_ID, enemyHeroId, itemId, count, deltaWpa };
}

function enemyThreats(heroIds: readonly number[]) {
  return heroIds.map((heroId) => ({ heroId, threatMultiplier: 1 }));
}

function select(overrides: Partial<SituationalSelectionInputV2> = {}) {
  const service = new SituationalItemsSelectionV2Service(new ThreatWeightedMatchupV1Service());
  return service.select({
    heroId: HERO_ID,
    rulesetId: RULESET_ID,
    archetype: archetypeWithRoles({}),
    itemGraph: createRecommendationItemGraph([
      itemDefinition(101),
      itemDefinition(102),
      itemDefinition(103),
    ]),
    ownedItemIds: [],
    enemyHeroIds: [7, 8],
    enemyThreats: enemyThreats([7, 8]),
    vsHeroRows: [],
    ...overrides,
  });
}

describe('SituationalItemsSelectionV2Service', () => {
  it('excludes items the archetype carries with the CORE role', () => {
    const result = select({
      archetype: archetypeWithRoles({ 101: 'CORE' }),
      vsHeroRows: [row(101, 7, 0.10), row(102, 7, 0.05)],
    });

    expect(result.map((entry) => entry.itemId)).toEqual([102]);
  });

  // The archetype is compiled per matchup and omits items it does not model, so
  // a staple can be missing from it entirely — Infuser is in the Viktor consensus
  // build and in none of his archetypes. The consensus build is what decides
  // "buys anyway", and FREQUENT counts: the mode exists to suggest what the player
  // would not have picked.
  it('excludes what the hero consensus build marks CORE or FREQUENT', () => {
    const result = select({
      consensusItems: [
        { itemId: 101, tier: 'CORE' },
        { itemId: 102, tier: 'FREQUENT' },
        { itemId: 103, tier: 'SOMETIMES' },
      ],
      vsHeroRows: [row(101, 7, 0.10), row(102, 7, 0.10), row(103, 7, 0.10)],
    });

    expect(result.map((entry) => entry.itemId)).toEqual([103]);
  });

  it('keeps an item the consensus build only sometimes takes', () => {
    const result = select({
      consensusItems: [{ itemId: 101, tier: 'FLEX' }],
      vsHeroRows: [row(101, 7, 0.10)],
    });

    expect(result.map((entry) => entry.itemId)).toEqual([101]);
  });

  it('keeps non-core archetype roles in the pool', () => {
    const result = select({
      archetype: archetypeWithRoles({ 101: 'SITUATIONAL', 102: 'FLEX' }),
      vsHeroRows: [row(101, 7, 0.10), row(102, 7, 0.05)],
    });

    expect(result.map((entry) => entry.itemId)).toEqual([101, 102]);
  });

  it('excludes items the player already owns', () => {
    const result = select({
      ownedItemIds: [101],
      vsHeroRows: [row(101, 7, 0.10), row(102, 7, 0.05)],
    });

    expect(result.map((entry) => entry.itemId)).toEqual([102]);
  });

  it('excludes items that are not available in this ruleset', () => {
    const result = select({
      itemGraph: createRecommendationItemGraph([
        { ...itemDefinition(101), availableRulesetIds: ['some-other-ruleset'] },
        itemDefinition(102),
      ]),
      vsHeroRows: [row(101, 7, 0.10), row(102, 7, 0.05)],
    });

    expect(result.map((entry) => entry.itemId)).toEqual([102]);
  });

  it('excludes an inactive item even when its evidence would rank it first', () => {
    const result = select({
      itemGraph: createRecommendationItemGraph([
        itemDefinition(101),
        itemDefinition(102),
        { ...itemDefinition(103), active: false },
      ]),
      vsHeroRows: [row(103, 7, 0.10), row(101, 7, 0.02), row(102, 7, 0.01)],
    });

    expect(result.map((entry) => entry.itemId)).toEqual([101, 102]);
  });

  it('ranks by normalised matchup score', () => {
    const result = select({
      vsHeroRows: [row(101, 7, 0.02), row(102, 7, 0.10)],
    });

    expect(result.map((entry) => entry.itemId)).toEqual([102, 101]);
  });

  it('exposes the underlying matchup score, confidence and coverage', () => {
    // One contributing enemy (7) out of two (7, 8), both threatMultiplier 1,
    // count 60 — the dataset's measured mean. sampleConfidence = 60 / 560.
    //   coverage   = contributing / total                 = 1 / 2  = 0.5
    //   confidence = (0.107142857 × 1) / 2                          = 0.05357143
    //   score      = tanh((0.10 × 0.107142857) / 0.15) / 2          = 0.03565355
    const result = select({ vsHeroRows: [row(101, 7, 0.10)] });

    expect(result).toHaveLength(1);
    expect(result[0].coverage).toBeCloseTo(0.5, 5);
    expect(result[0].confidence).toBeCloseTo(0.05357143, 5);
    expect(result[0].score).toBeCloseTo(0.03565355, 5);
  });

  it('rejects an item whose score is not positive', () => {
    const result = select({
      vsHeroRows: [row(101, 7, -0.10)],
    });

    expect(result).toEqual([]);
  });

  it('rejects an item with no evidence against any enemy hero', () => {
    const result = select({
      vsHeroRows: [row(101, 999, 0.10)],
    });

    expect(result).toEqual([]);
  });

  it('reports only the enemies the item helps against, strongest first', () => {
    const result = select({
      enemyHeroIds: [7, 8, 9],
      enemyThreats: enemyThreats([7, 8, 9]),
      vsHeroRows: [row(101, 7, 0.02), row(101, 8, 0.10), row(101, 9, -0.10)],
    });

    expect(result[0].against.map((target) => target.enemyHeroId)).toEqual([8, 7]);
    expect(result[0].against[0].count).toBe(60);
  });

  it('caps the reported enemies', () => {
    const enemyHeroIds = [7, 8, 9, 10];
    const result = select({
      enemyHeroIds,
      enemyThreats: enemyThreats(enemyHeroIds),
      vsHeroRows: enemyHeroIds.map((heroId, index) => row(101, heroId, 0.02 * (index + 1))),
    });

    expect(result[0].against).toHaveLength(SITUATIONAL_AGAINST_LIMIT_V2);
    // The three strongest contributions survive — deltaWpa 0.08, 0.06, 0.04 —
    // not merely three of the four.
    expect(result[0].against.map((target) => target.enemyHeroId)).toEqual([10, 9, 8]);
  });

  it('caps the returned items', () => {
    const itemIds = [101, 102, 103, 104, 105, 106, 107];
    const result = select({
      itemGraph: createRecommendationItemGraph(itemIds.map(itemDefinition)),
      vsHeroRows: itemIds.map((itemId, index) => row(itemId, 7, 0.01 * (index + 1))),
    });

    expect(result).toHaveLength(SITUATIONAL_ITEM_LIMIT_V2);
    // The five highest deltas survive, in descending order: 107…103, not 101…105.
    expect(result.map((entry) => entry.itemId)).toEqual([107, 106, 105, 104, 103]);
  });

  it('breaks ties deterministically by item id', () => {
    const result = select({
      vsHeroRows: [row(103, 7, 0.10), row(101, 7, 0.10), row(102, 7, 0.10)],
    });

    expect(result.map((entry) => entry.itemId)).toEqual([101, 102, 103]);
  });

  // The opposite of what this test used to assert. A confidence floor borrowed
  // from the build-replacement path rejected every item the real dataset can
  // produce — the median sample is 31 games, so an item's confidence sits near
  // 0.06 against a 0.35 bar — and the mode showed nothing in every real match.
  // Thin evidence is damped inside `normalized` instead, so a small sample
  // cannot outrank a large one; what it must not do is disappear.
  it('admits an item on a small sample when it still helps', () => {
    const result = select({
      vsHeroRows: [row(101, 7, 0.10, 31)],
    });

    expect(result.map((entry) => entry.itemId)).toEqual([101]);
    expect(result[0].score).toBeGreaterThan(0);
  });

  it('still drops an item whose only evidence points the wrong way', () => {
    const result = select({
      vsHeroRows: [row(101, 7, -0.10, 31)],
    });

    expect(result).toEqual([]);
  });
});
