import {
  RecommendationItemDefinition,
  createRecommendationItemGraph,
} from '@dynamo-lab/build-domain';
import { BuildArchetypeFamilyV2, BuildArchetypeV2 } from '../src/statlocker-adaptive/build-archetype-v2';
import { BuildItemUtilityV2Service } from '../src/statlocker-adaptive/build-item-utility-v2.service';
import {
  FamilyFirstFullBuildLifetimeResolverV2Input,
  FamilyFirstFullBuildResolverV2Service,
} from '../src/statlocker-adaptive/family-first-full-build-resolver-v2.service';
import {
  FullBuildReplacementV2Input,
  FullBuildReplacementV2Result,
  FullBuildReplacementV2Service,
} from '../src/statlocker-adaptive/full-build-replacement-v2.service';
import {
  FullBuildTransactionPlannerV2Input,
  FullBuildTransactionPlannerV2Service,
} from '../src/statlocker-adaptive/full-build-transaction-planner-v2.service';
import { StatlockerHeroItemLifecycleV1 } from '../src/statlocker-adaptive/statlocker-adaptive.types';
import { ThreatWeightedMatchupV1Service } from '../src/statlocker-adaptive/threat-weighted-matchup-v1.service';

const HERO_ID = 72;
const EXTRA_ITEM_ID = 999;

function item(itemId: number): RecommendationItemDefinition {
  return {
    itemId,
    name: `item-${itemId}`,
    slotType: 'weapon',
    active: true,
    availableRulesetIds: ['r1'],
    directPurchaseCost: 500,
    upgradeRecipes: [],
    sellTransition: { soulsRefund: 250, returnedItemIds: [] },
    maxCopies: 1,
  };
}

function standaloneArchetype(): BuildArchetypeV2 {
  const family: BuildArchetypeFamilyV2 = {
    familyId: EXTRA_ITEM_ID,
    requirement: 'REQUIRED',
    aggregateFrequencyTier: 'CORE',
    sourceProfileCount: 5,
    profileCoverage: 0.5,
    purchaseRate: 0.5,
    structuralPriority: 0.5,
    progressionNodes: [{
      itemId: EXTRA_ITEM_ID,
      rawFrequencyTier: 'CORE',
      progressionRole: 'DEFAULT_TERMINAL',
      sourceProfileCount: 5,
      profileCoverage: 0.5,
      purchaseRate: 0.5,
      timing: { medianBuyTimeS: 300, spreadS: 30, phase: 'EARLY' },
    }],
    progressionEdges: [],
    terminalCandidates: [{
      itemId: EXTRA_ITEM_ID,
      kind: 'DEFAULT_TERMINAL',
      sourceProfileCount: 5,
      profileCoverage: 0.5,
      purchaseRate: 0.5,
      rawFrequencyTier: 'CORE',
    }],
  };
  return {
    archetypeId: 'archetype:family-first-replacement',
    heroId: HERO_ID,
    rulesetVersion: 'r1',
    catalogSha256: 'a'.repeat(64),
    statlockerPatchId: 'p1',
    sourceProfileAccountIds: Array.from({ length: 5 }, (_, index) => `p${index + 1}`),
    families: [family],
    items: [],
    groups: [],
    orderEdges: [],
    relationships: [],
    quality: { support: 1, coherence: 0.9, separation: 0.5, sourceProfileCount: 5 },
  };
}

function lifecycleRow(itemId: number): StatlockerHeroItemLifecycleV1 {
  return { heroId: HERO_ID, itemId, generalWpa: 0.42, averagePurchaseTimeS: 320, sampleSize: 120 };
}

function lifetimeInput(
  overrides: Partial<FamilyFirstFullBuildLifetimeResolverV2Input> = {},
): FamilyFirstFullBuildLifetimeResolverV2Input {
  return {
    matchId: 'match-1',
    stateRevision: 'state-1',
    heroId: HERO_ID,
    rulesetId: 'r1',
    archetype: standaloneArchetype(),
    itemGraph: createRecommendationItemGraph([item(EXTRA_ITEM_ID)]),
    capacity: 12,
    gameTimeSec: 1_000,
    currentInventoryItemIds: [],
    enemyHeroIds: [1, 2, 3, 4, 5, 6],
    enemyThreats: [],
    vsHeroRows: [],
    lifecycleEvidence: [lifecycleRow(EXTRA_ITEM_ID)],
    ...overrides,
  };
}

class StubFullBuildReplacementV2Service {
  readonly calls: FullBuildReplacementV2Input[] = [];

  constructor(private readonly respond?: (input: FullBuildReplacementV2Input) => FullBuildReplacementV2Result) {}

  decide(input: FullBuildReplacementV2Input): FullBuildReplacementV2Result {
    this.calls.push(input);
    return this.respond ? this.respond(input) : { kind: 'BLOCKED', reasonCodes: ['STUB_BLOCKED'] };
  }
}

describe('FamilyFirstFullBuildResolverV2Service lifecycle replacement integration', () => {
  it('passes matchup and lifecycle facts to the transaction planner replacement context', () => {
    const spyPlanner = {
      plan: jest.fn(() => ({ actions: [], reasonCodes: [] })),
    } as unknown as FullBuildTransactionPlannerV2Service;
    const resolver = new FamilyFirstFullBuildResolverV2Service(
      new BuildItemUtilityV2Service(new ThreatWeightedMatchupV1Service()),
      spyPlanner,
    );
    const lifecycleEvidence = [lifecycleRow(EXTRA_ITEM_ID), lifecycleRow(1_000)];
    const wpaPatchData = { patchId: 'p1', items: [] };
    const t4Chains = { chains: [] };

    resolver.resolve(lifetimeInput({ wpaPatchData, t4Chains, lifecycleEvidence }));

    expect(spyPlanner.plan).toHaveBeenCalledTimes(1);
    const plannerInput = (spyPlanner.plan as jest.Mock).mock.calls[0][0] as FullBuildTransactionPlannerV2Input;
    expect(plannerInput.replacementContext).toEqual({
      heroId: HERO_ID,
      gameTimeSec: 1_000,
      enemyHeroIds: [1, 2, 3, 4, 5, 6],
      enemyThreats: [],
      vsHeroRows: [],
      wpaPatchData,
      t4Chains,
      lifecycleEvidence,
    });
    expect(Object.keys(plannerInput.replacementContext ?? {}).sort()).toEqual([
      'enemyHeroIds',
      'enemyThreats',
      'gameTimeSec',
      'heroId',
      'lifecycleEvidence',
      't4Chains',
      'vsHeroRows',
      'wpaPatchData',
    ]);
    expect(Object.keys(plannerInput).sort()).toEqual([
      'archetype',
      'capacity',
      'currentInventoryItemIds',
      'desiredState',
      'itemGraph',
      'replacementContext',
      'rulesetId',
    ]);
  });

  it('forwards the verified lifecycle evidence through the planner to the replacement decision', () => {
    const filler = Array.from({ length: 12 }, (_, index) => 2_000 + index);
    const stub = new StubFullBuildReplacementV2Service(() => ({
      kind: 'REPLACE',
      sellItemId: 2_000,
      reasonCodes: ['STUB_SELL'],
    }));
    const transactionPlanner = new FullBuildTransactionPlannerV2Service(
      stub as unknown as FullBuildReplacementV2Service,
    );
    const resolver = new FamilyFirstFullBuildResolverV2Service(
      new BuildItemUtilityV2Service(new ThreatWeightedMatchupV1Service()),
      transactionPlanner,
    );
    const lifecycleEvidence = [lifecycleRow(EXTRA_ITEM_ID)];

    const plan = resolver.resolve(lifetimeInput({
      currentInventoryItemIds: filler,
      itemGraph: createRecommendationItemGraph([item(EXTRA_ITEM_ID), ...filler.map((itemId) => item(itemId))]),
      lifecycleEvidence,
    }));

    expect(stub.calls).toHaveLength(1);
    const captured = stub.calls[0];
    expect(captured.buyItemId).toBe(EXTRA_ITEM_ID);
    expect(captured.context.heroId).toBe(HERO_ID);
    expect(captured.context.gameTimeSec).toBe(1_000);
    expect(captured.context.lifecycleEvidence).toEqual(lifecycleEvidence);
    expect(JSON.parse(JSON.stringify(captured.context))).toEqual(captured.context);
    expect(plan.steps.some((step) =>
      step.action === 'REPLACE' && step.sellItemId === 2_000 && step.buyItemId === EXTRA_ITEM_ID,
    )).toBe(true);
  });
});
