import {
  RecommendationCandidate,
  RecommendationItemDefinition,
  createRecommendationItemGraph,
} from '@dynamo-lab/build-domain';
import {
  BuildArchetypeItemV2,
  BuildArchetypeRelationshipV2,
  BuildArchetypeV2,
} from '../src/statlocker-adaptive/build-archetype-v2';
import { BuildItemUtilityV2Service } from '../src/statlocker-adaptive/build-item-utility-v2.service';
import { EnemyThreatScoreV1 } from '../src/statlocker-adaptive/enemy-threat-v1.service';
import { FullBuildResolverV2Service } from '../src/statlocker-adaptive/full-build-resolver-v2.service';
import { ThreatWeightedMatchupV1Service } from '../src/statlocker-adaptive/threat-weighted-matchup-v1.service';

const HERO_ID = 72;
const CORE_ITEM_ID = 1;
const FLEX_RELATED_ITEM_ID = 2;
const FLEX_FREE_ITEM_ID = 3;
const COUNTER_ITEM_ID = 4;
const PLAN_A_ITEM_ID = 5;
const PLAN_B_ITEM_ID = 6;
const ENEMY_A = 27;
const ENEMY_B = 6;
const CATALOG_SHA = 'a'.repeat(64);

interface EvaluationShape {
  actionId: string;
  accepted: boolean;
  currentWholeUtility: number;
  resultingWholeUtility: number;
  marginalGain: number;
  requiredImprovement: number;
  reasonCodes: readonly string[];
}

const itemDefinitions: RecommendationItemDefinition[] = Array.from(
  { length: 6 },
  (_, index): RecommendationItemDefinition => ({
    itemId: index + 1,
    name: `Item ${index + 1}`,
    slotType: index % 3 === 0 ? 'weapon' : index % 3 === 1 ? 'vitality' : 'spirit',
    active: false,
    availableRulesetIds: ['ruleset-a'],
    directPurchaseCost: 800,
    upgradeRecipes: [],
    sellTransition: { soulsRefund: 400, returnedItemIds: [] },
  }),
);

const itemGraph = createRecommendationItemGraph(itemDefinitions);

function archetype(options: {
  item2Priority?: number;
  item3Priority?: number;
  planAPriority?: number;
  planBPriority?: number;
  relationships?: readonly BuildArchetypeRelationshipV2[];
} = {}): BuildArchetypeV2 {
  const items: BuildArchetypeItemV2[] = [
    buildItem(CORE_ITEM_ID, 'CORE', 0.05),
    buildItem(FLEX_RELATED_ITEM_ID, 'FLEX', options.item2Priority ?? 0.05),
    buildItem(FLEX_FREE_ITEM_ID, 'FLEX', options.item3Priority ?? 0.05),
  ];
  if (options.planAPriority !== undefined) {
    items.push(buildItem(PLAN_A_ITEM_ID, 'FLEX', options.planAPriority, 600, 'MID'));
  }
  if (options.planBPriority !== undefined) {
    items.push(buildItem(PLAN_B_ITEM_ID, 'FLEX', options.planBPriority, 600, 'MID'));
  }

  return {
    archetypeId: 'archetype:test',
    heroId: HERO_ID,
    rulesetVersion: 'ruleset-a',
    catalogSha256: CATALOG_SHA,
    statlockerPatchId: 'patch-a',
    sourceProfileAccountIds: Array.from({ length: 10 }, (_, index) => `p${index + 1}`),
    items,
    groups: [],
    orderEdges: [],
    relationships: [...(options.relationships ?? [])],
    quality: { support: 1, coherence: 0.9, separation: 0.4, sourceProfileCount: 10 },
  };
}

function buildItem(
  itemId: number,
  role: BuildArchetypeItemV2['role'],
  structuralPriority: number,
  medianBuyTimeS = 0,
  phase: BuildArchetypeItemV2['timing']['phase'] = 'EARLY',
): BuildArchetypeItemV2 {
  return {
    itemId,
    familyId: itemId,
    role,
    sourceProfileCount: 10,
    profileCoverage: 0.05,
    purchaseRate: 0.05,
    timing: { medianBuyTimeS, spreadS: 60, phase },
    structuralPriority,
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

function replacementCandidate(
  sellItemId: number,
  buyItemId: number,
  resultingItemIds: readonly number[],
  effectiveCostSouls: number,
): RecommendationCandidate {
  return {
    actionId: `REPLACE_ITEM:${sellItemId}->${buyItemId}`,
    action: { type: 'REPLACE_ITEM', sellItemId, buyItemId },
    feasible: true,
    reasons: ['FEASIBLE'],
    recommendationEligible: true,
    recommendationSuppressionReasons: [],
    effectiveCostSouls,
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

function buyCandidate(itemId: number): RecommendationCandidate {
  return {
    actionId: `BUY_ITEM:${itemId}`,
    action: { type: 'BUY_ITEM', itemId },
    feasible: true,
    reasons: ['FEASIBLE'],
    recommendationEligible: true,
    recommendationSuppressionReasons: [],
    effectiveCostSouls: 800,
    spendableSoulsAfter: 4200,
    resultingItemIds: [itemId],
    evidence: {
      spendableSouls: 'OBSERVED',
      shopOpportunity: 'OBSERVED',
      ruleset: 'RECONSTRUCTED',
      inventory: 'OBSERVED',
      transaction: 'RECONSTRUCTED',
    },
  };
}

function service(): FullBuildResolverV2Service {
  const matchup = new ThreatWeightedMatchupV1Service();
  return new FullBuildResolverV2Service(new BuildItemUtilityV2Service(matchup));
}

function matchupRows(deltaWpa: number, count: number) {
  return [
    { heroId: HERO_ID, enemyHeroId: ENEMY_A, itemId: COUNTER_ITEM_ID, count, deltaWpa },
    { heroId: HERO_ID, enemyHeroId: ENEMY_B, itemId: COUNTER_ITEM_ID, count, deltaWpa },
  ];
}

function commonInput(build: BuildArchetypeV2) {
  return {
    heroId: HERO_ID,
    archetype: build,
    itemGraph,
    gameTimeSec: 3000,
    currentInventoryItemIds: [CORE_ITEM_ID, FLEX_RELATED_ITEM_ID, FLEX_FREE_ITEM_ID],
    enemyHeroIds: [ENEMY_A, ENEMY_B],
    enemyThreats: [threat(ENEMY_A), threat(ENEMY_B)],
    vsHeroRows: matchupRows(0.5, 100_000),
  };
}

function evaluationByActionId(
  resolution: { evaluations: readonly EvaluationShape[] },
  actionId: string,
): EvaluationShape {
  const evaluation = resolution.evaluations.find((entry) => entry.actionId === actionId);
  if (!evaluation) throw new Error(`Missing evaluation ${actionId}`);
  return evaluation;
}

describe('FullBuildResolverV2Service', () => {
  it('chooses a replacement by marginal whole-inventory utility instead of the cheapest sell source', () => {
    const build = archetype({
      relationships: [{
        leftItemId: CORE_ITEM_ID,
        rightItemId: FLEX_RELATED_ITEM_ID,
        strength: 1,
        sourceProfileCount: 10,
      }],
    });
    const replaceRelated = replacementCandidate(
      FLEX_RELATED_ITEM_ID,
      COUNTER_ITEM_ID,
      [CORE_ITEM_ID, FLEX_FREE_ITEM_ID, COUNTER_ITEM_ID],
      100,
    );
    const replaceFree = replacementCandidate(
      FLEX_FREE_ITEM_ID,
      COUNTER_ITEM_ID,
      [CORE_ITEM_ID, FLEX_RELATED_ITEM_ID, COUNTER_ITEM_ID],
      1200,
    );
    const resolution = service().resolve({
      ...commonInput(build),
      candidates: [replaceRelated, replaceFree],
      transitionCostsByActionId: new Map([
        [replaceRelated.actionId, { transactionPenalty: 0.01, replacementPenalty: 0.10 }],
        [replaceFree.actionId, { transactionPenalty: 0.05, replacementPenalty: 0.10 }],
      ]),
    });

    expect(resolution.selected?.candidate.action).toEqual({
      type: 'REPLACE_ITEM',
      sellItemId: FLEX_FREE_ITEM_ID,
      buyItemId: COUNTER_ITEM_ID,
    });
    const related = evaluationByActionId(resolution, replaceRelated.actionId);
    const free = evaluationByActionId(resolution, replaceFree.actionId);
    expect(related.accepted).toBe(true);
    expect(free.accepted).toBe(true);
    expect(free.resultingWholeUtility).toBeGreaterThan(related.resultingWholeUtility);
    expect(free.marginalGain).toBeGreaterThan(related.marginalGain);
  });

  it('requires materially more marginal gain to replace CORE than FLEX', () => {
    const build = archetype();
    const replaceCore = replacementCandidate(
      CORE_ITEM_ID,
      COUNTER_ITEM_ID,
      [FLEX_RELATED_ITEM_ID, FLEX_FREE_ITEM_ID, COUNTER_ITEM_ID],
      800,
    );
    const replaceFlex = replacementCandidate(
      FLEX_FREE_ITEM_ID,
      COUNTER_ITEM_ID,
      [CORE_ITEM_ID, FLEX_RELATED_ITEM_ID, COUNTER_ITEM_ID],
      800,
    );
    const resolution = service().resolve({
      ...commonInput(build),
      candidates: [replaceCore, replaceFlex],
      vsHeroRows: matchupRows(0.25, 1000),
    });

    const core = evaluationByActionId(resolution, replaceCore.actionId);
    const flex = evaluationByActionId(resolution, replaceFlex.actionId);
    expect(core.requiredImprovement).toBeGreaterThan(flex.requiredImprovement);
    expect(core.accepted).toBe(false);
    expect(core.reasonCodes).toContain('MARGINAL_GAIN_BELOW_THRESHOLD');
    expect(flex.accepted).toBe(true);
    expect(resolution.selected?.candidate.actionId).toBe(replaceFlex.actionId);
  });

  it('can replace CORE when strong live Statlocker evidence actually clears the higher threshold', () => {
    const build = archetype();
    const replaceCore = replacementCandidate(
      CORE_ITEM_ID,
      COUNTER_ITEM_ID,
      [FLEX_RELATED_ITEM_ID, FLEX_FREE_ITEM_ID, COUNTER_ITEM_ID],
      800,
    );
    const resolution = service().resolve({
      ...commonInput(build),
      candidates: [replaceCore],
    });

    const core = evaluationByActionId(resolution, replaceCore.actionId);
    expect(core.accepted).toBe(true);
    expect(resolution.selected?.candidate.actionId).toBe(replaceCore.actionId);
  });

  it('protects a recently purchased item from an immediate sell and chooses another valid replacement', () => {
    const build = archetype({ item2Priority: 0.20, item3Priority: 0.05 });
    const replaceItem2 = replacementCandidate(
      FLEX_RELATED_ITEM_ID,
      COUNTER_ITEM_ID,
      [CORE_ITEM_ID, FLEX_FREE_ITEM_ID, COUNTER_ITEM_ID],
      800,
    );
    const replaceRecentItem3 = replacementCandidate(
      FLEX_FREE_ITEM_ID,
      COUNTER_ITEM_ID,
      [CORE_ITEM_ID, FLEX_RELATED_ITEM_ID, COUNTER_ITEM_ID],
      800,
    );
    const resolution = service().resolve({
      ...commonInput(build),
      candidates: [replaceItem2, replaceRecentItem3],
      recentPurchases: [{ itemId: FLEX_FREE_ITEM_ID, ageSec: 30 }],
    });

    const recent = evaluationByActionId(resolution, replaceRecentItem3.actionId);
    expect(recent.accepted).toBe(false);
    expect(recent.reasonCodes).toContain('RECENT_PURCHASE_PROTECTED');
    expect(resolution.selected?.candidate.actionId).toBe(replaceItem2.actionId);
  });

  it('keeps the previous next action when a challenger improves by less than the hysteresis margin', () => {
    const build = archetype({ planAPriority: 0.30, planBPriority: 0.40 });
    const planA = buyCandidate(PLAN_A_ITEM_ID);
    const planB = buyCandidate(PLAN_B_ITEM_ID);
    const resolution = service().resolve({
      heroId: HERO_ID,
      archetype: build,
      itemGraph,
      gameTimeSec: 600,
      currentInventoryItemIds: [],
      candidates: [planA, planB],
      enemyHeroIds: [ENEMY_A, ENEMY_B],
      enemyThreats: [threat(ENEMY_A), threat(ENEMY_B)],
      vsHeroRows: [],
      previousActionId: planA.actionId,
    });

    expect(resolution.selected?.candidate.actionId).toBe(planA.actionId);
    expect(resolution.selectionReasonCodes).toContain('PLAN_HYSTERESIS_HELD');
  });

  it('switches next action when the challenger clears the hysteresis margin', () => {
    const build = archetype({ planAPriority: 0.10, planBPriority: 1 });
    const planA = buyCandidate(PLAN_A_ITEM_ID);
    const planB = buyCandidate(PLAN_B_ITEM_ID);
    const resolution = service().resolve({
      heroId: HERO_ID,
      archetype: build,
      itemGraph,
      gameTimeSec: 600,
      currentInventoryItemIds: [],
      candidates: [planA, planB],
      enemyHeroIds: [ENEMY_A, ENEMY_B],
      enemyThreats: [threat(ENEMY_A), threat(ENEMY_B)],
      vsHeroRows: [],
      previousActionId: planA.actionId,
    });

    expect(resolution.selected?.candidate.actionId).toBe(planB.actionId);
    expect(resolution.selectionReasonCodes).toContain('PLAN_HYSTERESIS_SWITCHED');
  });
});