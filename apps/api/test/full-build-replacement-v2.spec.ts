import { createRecommendationItemGraph } from '@deadlock-live-probe/build-domain';
import {
  BuildArchetypeRoleV2,
  BuildArchetypeV2,
  BuildObservedProgressionEdgeV2,
} from '../src/statlocker-adaptive/build-archetype-v2';
import {
  DesiredFamilyGoalKindV2,
  DesiredFamilyStateV2,
} from '../src/statlocker-adaptive/build-desired-state-v2.service';
import { FullBuildMatchupProtectionV1Service } from '../src/statlocker-adaptive/full-build-matchup-protection-v1.service';
import { FullBuildSellRankerV1Service } from '../src/statlocker-adaptive/full-build-sell-ranker-v1.service';
import {
  FullBuildReplacementContextV2,
  FullBuildReplacementV2Input,
  FullBuildReplacementV2Result,
  FullBuildReplacementV2Service,
} from '../src/statlocker-adaptive/full-build-replacement-v2.service';
import {
  FullBuildTransitionValueV2Input,
  FullBuildTransitionValueV2Service,
} from '../src/statlocker-adaptive/full-build-transition-value-v2.service';
import { StatlockerHeroItemLifecycleV1 } from '../src/statlocker-adaptive/statlocker-adaptive.types';
import {
  StatlockerBuildV2Config,
  STATLOCKER_BUILD_V2_CONFIG,
} from '../src/statlocker-adaptive/statlocker-build-v2.config';
import { StatlockerVsHeroWpaAggregateSourceV1 } from '../src/statlocker-adaptive/statlocker-vs-hero-wpa-repository-v1.service';

const HERO_ID = 10;
const BUY_ITEM_ID = 50;
const PROJECTED_INVENTORY = [30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41];

interface SellPairValueV2 {
  marginalGain: number;
  confidence: number;
}

function transitionValueStub(pairs: ReadonlyMap<number, SellPairValueV2>): {
  service: FullBuildTransitionValueV2Service;
  evaluate: jest.Mock;
} {
  const evaluate = jest.fn((call: FullBuildTransitionValueV2Input) => {
    const soldItemId = call.currentInventoryItemIds.find(
      (itemId) => !call.resultingInventoryItemIds.includes(itemId),
    );
    const pair = soldItemId === undefined ? undefined : pairs.get(soldItemId);
    if (!pair) throw new Error(`Unexpected sell candidate ${soldItemId}`);
    return {
      currentState: { total: 0, confidence: 0, itemUtilities: [] },
      resultingState: {
        total: pair.marginalGain,
        confidence: pair.confidence,
        itemUtilities: [],
      },
      marginalGain: pair.marginalGain,
      confidence: pair.confidence,
    };
  });
  return { service: { evaluate } as unknown as FullBuildTransitionValueV2Service, evaluate };
}

function lifecycleRow(
  itemId: number,
  generalWpa: number,
  averagePurchaseTimeS: number,
  heroId: number = HERO_ID,
): StatlockerHeroItemLifecycleV1 {
  return { heroId, itemId, generalWpa, averagePurchaseTimeS };
}

const BASE_LIFECYCLE = [lifecycleRow(30, 0.1, 100), lifecycleRow(31, 0.2, 200)];

function progressionEdge(
  fromItemId: number,
  toItemId: number,
): BuildObservedProgressionEdgeV2 {
  return {
    fromItemId,
    toItemId,
    sourceProfileCount: 3,
    orderedProfileCount: 3,
    orderConfidence: 0.9,
    timing: {
      fromMedianBuyTimeS: 100,
      toMedianBuyTimeS: 200,
      fromSpreadS: 10,
      toSpreadS: 10,
    },
    evidence: 'STATLOCKER_SAME_PROFILE',
  };
}

function archetypeFixture(options?: {
  progressionEdges?: readonly BuildObservedProgressionEdgeV2[];
  roles?: Readonly<Record<number, BuildArchetypeRoleV2>>;
}): BuildArchetypeV2 {
  return {
    archetypeId: 'archetype:test',
    heroId: HERO_ID,
    rulesetVersion: 'r1',
    catalogSha256: 'a'.repeat(64),
    statlockerPatchId: 'p1',
    sourceProfileAccountIds: ['p1'],
    families: [
      {
        familyId: 1,
        requirement: 'REQUIRED',
        aggregateFrequencyTier: 'CORE',
        sourceProfileCount: 3,
        profileCoverage: 1,
        purchaseRate: 1,
        structuralPriority: 1,
        progressionNodes: [],
        ...(options?.progressionEdges ? { progressionEdges: options.progressionEdges } : {}),
        terminalCandidates: [],
      },
    ],
    items: Object.entries(options?.roles ?? {}).map(([itemId, role]) => ({
      itemId: Number(itemId),
      familyId: 1,
      role,
      sourceProfileCount: 3,
      profileCoverage: 1,
      purchaseRate: 1,
      timing: { medianBuyTimeS: 100, spreadS: 10, phase: 'EARLY' as const },
      structuralPriority: 1,
    })),
    groups: [],
    orderEdges: [],
    relationships: [],
    quality: { support: 1, coherence: 1, separation: 1, sourceProfileCount: 1 },
  };
}

function desiredFamilyFixture(goalKind: DesiredFamilyGoalKindV2): DesiredFamilyStateV2 {
  const requirement =
    goalKind === 'REQUIRED'
      ? 'REQUIRED'
      : goalKind === 'CHOICE_SELECTED'
        ? 'CHOICE'
        : goalKind === 'OPTIONAL'
          ? 'OPTIONAL'
          : 'SITUATIONAL';
  return {
    familyId: 1,
    requirement,
    goalKind,
    selectedTerminalItemId: BUY_ITEM_ID,
    selectedTerminalKind: 'DEFAULT_TERMINAL',
    score: 0.9,
    confidence: 0.8,
    reasonCodes: [],
  };
}

const BASE_CONTEXT: FullBuildReplacementContextV2 = {
  heroId: HERO_ID,
  gameTimeSec: 1_800,
  enemyHeroIds: [21, 22],
  enemyThreats: [],
  vsHeroRows: [],
  lifecycleEvidence: BASE_LIFECYCLE,
};

function makeInput(parts?: {
  archetype?: BuildArchetypeV2;
  desiredFamily?: DesiredFamilyStateV2;
  activeProgressionProtectedItemIds?: ReadonlySet<number>;
  context?: Partial<FullBuildReplacementContextV2>;
}): FullBuildReplacementV2Input {
  return {
    archetype: parts?.archetype ?? archetypeFixture(),
    desiredFamily: parts?.desiredFamily ?? desiredFamilyFixture('OPTIONAL'),
    buyItemId: BUY_ITEM_ID,
    projectedInventoryItemIds: PROJECTED_INVENTORY,
    activeProgressionProtectedItemIds:
      parts?.activeProgressionProtectedItemIds ?? new Set<number>(),
    itemGraph: createRecommendationItemGraph([]),
    rulesetId: 'r1',
    context: { ...BASE_CONTEXT, ...parts?.context },
  };
}

function makeService(pairs: ReadonlyMap<number, SellPairValueV2>, config?: StatlockerBuildV2Config) {
  const transition = transitionValueStub(pairs);
  const service = new FullBuildReplacementV2Service(
    transition.service,
    new FullBuildMatchupProtectionV1Service(),
    new FullBuildSellRankerV1Service(),
    config,
  );
  return { service, evaluate: transition.evaluate };
}

function soldItemIds(evaluate: jest.Mock): number[] {
  return evaluate.mock.calls
    .map(([call]: [{ currentInventoryItemIds: number[]; resultingInventoryItemIds: number[] }]) =>
      call.currentInventoryItemIds.find(
        (itemId) => !call.resultingInventoryItemIds.includes(itemId),
      ),
    )
    .filter((itemId: number | undefined): itemId is number => itemId !== undefined)
    .sort((a: number, b: number) => a - b);
}

describe('FullBuildReplacementV2Service', () => {
  it('ranks two eligible held items by lifecycle and sells the earlier/lower-WPA one even when the other gains more', () => {
    const pairs = new Map<number, SellPairValueV2>([
      [30, { marginalGain: 0.31, confidence: 0.6 }],
      [31, { marginalGain: 0.6, confidence: 0.6 }],
    ]);
    const { service, evaluate } = makeService(pairs);

    const result: FullBuildReplacementV2Result = service.decide(makeInput());

    // Item 30 is earlier and lower-WPA, so it dominates and is picked despite
    // item 31 clearing the gates with a higher marginal gain. The ten held
    // fillers carry no lifecycle evidence and are reported as dropped. With
    // the calibrated production config and no captured rows the protection
    // gate reports insufficient evidence instead of the uncalibrated marker.
    expect(result).toEqual({
      kind: 'REPLACE',
      sellItemId: 30,
      reasonCodes: ['INSUFFICIENT_MATCHUP_EVIDENCE', 'SELL_CANDIDATE_LIFECYCLE_MISSING'],
    });
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(soldItemIds(evaluate)).toEqual([30, 31]);
  });

  it('skips a MATCHUP_PROTECTED candidate and selects the next safe candidate', () => {
    const enabledConfig: StatlockerBuildV2Config = {
      ...STATLOCKER_BUILD_V2_CONFIG,
      sellMatchupProtection: {
        enabled: true,
        shrinkK: 500,
        minTeamWpaPct: 0.1,
        minConfidence: 0.3,
      },
    };
    const vsHeroRows: StatlockerVsHeroWpaAggregateSourceV1[] = [
      { heroId: HERO_ID, enemyHeroId: 21, itemId: 31, count: 10_000, deltaWpa: 0.9 },
      { heroId: HERO_ID, enemyHeroId: 22, itemId: 31, count: 10_000, deltaWpa: 0.9 },
    ];
    const pairs = new Map<number, SellPairValueV2>([
      [30, { marginalGain: 0.5, confidence: 0.6 }],
    ]);
    const { service, evaluate } = makeService(pairs, enabledConfig);

    const result = service.decide(makeInput({ context: { vsHeroRows } }));

    // Item 31 is matchup-protected across the whole enemy team, so item 30 is
    // sold instead and item 31 is never simulated.
    expect(result).toMatchObject({ kind: 'REPLACE', sellItemId: 30 });
    expect(result.reasonCodes).toContain('MATCHUP_PROTECTED');
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(soldItemIds(evaluate)).toEqual([30]);
  });

  it('never sells a held component that a pending confirmed upgrade needs', () => {
    const archetype = archetypeFixture({
      progressionEdges: [progressionEdge(31, BUY_ITEM_ID)],
    });
    const pairs = new Map<number, SellPairValueV2>([
      [30, { marginalGain: 0.5, confidence: 0.6 }],
    ]);
    const wpaPatchData = { patchId: 'p1', items: [] };
    const t4Chains = { chains: [] };
    const { service, evaluate } = makeService(pairs);
    const replacementInput = makeInput({ archetype, context: { wpaPatchData, t4Chains } });

    const result = service.decide(replacementInput);

    // Item 31 dominates item 30 on the lifecycle axes but it is the confirmed
    // from-item of the executed progression toward the buy target, so only
    // item 30 is sellable and item 31 stays in the inventory.
    expect(result).toMatchObject({ kind: 'REPLACE', sellItemId: 30 });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(soldItemIds(evaluate)).toEqual([30]);
    const call: FullBuildTransitionValueV2Input = evaluate.mock.calls[0][0];
    expect(call.currentInventoryItemIds).toEqual(PROJECTED_INVENTORY);
    expect(call.resultingInventoryItemIds).toEqual([
      50, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41,
    ]);
    expect(call.targetItemId).toBe(BUY_ITEM_ID);
    expect(call.heroId).toBe(HERO_ID);
    expect(call.gameTimeSec).toBe(1_800);
    expect(call.enemyHeroIds).toEqual([21, 22]);
    expect(call.enemyThreats).toEqual([]);
    expect(call.itemGraph).toBe(replacementInput.itemGraph);
    expect(call.wpaPatchData).toBe(wpaPatchData);
    expect(call.t4Chains).toBe(t4Chains);
  });

  it('blocks an OPTIONAL goal when no candidate pair clears the replacement gain threshold', () => {
    const pairs = new Map<number, SellPairValueV2>([
      [30, { marginalGain: 0.29, confidence: 0.6 }],
      [31, { marginalGain: 0.29, confidence: 0.6 }],
    ]);
    const { service, evaluate } = makeService(pairs);

    const result = service.decide(makeInput());

    expect(result.kind).toBe('BLOCKED');
    expect(result.reasonCodes).toContain('REPLACEMENT_GAIN_BELOW_THRESHOLD');
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it('blocks a SITUATIONAL goal when no candidate pair clears the replacement confidence minimum', () => {
    const pairs = new Map<number, SellPairValueV2>([
      [30, { marginalGain: 0.5, confidence: 0.35 }],
      [31, { marginalGain: 0.5, confidence: 0.35 }],
    ]);
    const { service, evaluate } = makeService(pairs);

    const result = service.decide(
      makeInput({ desiredFamily: desiredFamilyFixture('SITUATIONAL_MATCHUP_SELECTED') }),
    );

    expect(result.kind).toBe('BLOCKED');
    expect(result.reasonCodes).toContain('REPLACEMENT_CONFIDENCE_BELOW_MINIMUM');
    expect(result.reasonCodes).not.toContain('REPLACEMENT_GAIN_BELOW_THRESHOLD');
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it('sells a safe held item for a REQUIRED goal even when its pair does not clear the optional gain threshold', () => {
    const pairs = new Map<number, SellPairValueV2>([
      [30, { marginalGain: 0.1, confidence: 0.05 }],
      [31, { marginalGain: 0.1, confidence: 0.05 }],
    ]);
    const { service } = makeService(pairs);

    const required = service.decide(makeInput({ desiredFamily: desiredFamilyFixture('REQUIRED') }));
    expect(required).toMatchObject({ kind: 'REPLACE', sellItemId: 30 });
    expect(required.reasonCodes).not.toContain('REPLACEMENT_GAIN_BELOW_THRESHOLD');
    expect(required.reasonCodes).not.toContain('REPLACEMENT_CONFIDENCE_BELOW_MINIMUM');

    const choice = service.decide(
      makeInput({ desiredFamily: desiredFamilyFixture('CHOICE_SELECTED') }),
    );
    expect(choice).toMatchObject({ kind: 'REPLACE', sellItemId: 30 });
  });

  it('blocks with ITEM_META_EVIDENCE_MISSING when no candidate has verified lifecycle evidence', () => {
    const pairs = new Map<number, SellPairValueV2>([
      [30, { marginalGain: 0.5, confidence: 0.6 }],
    ]);
    const { service, evaluate } = makeService(pairs);

    const result = service.decide(
      makeInput({
        // The only lifecycle row belongs to another hero, so no candidate has
        // verified evidence for this hero.
        context: { lifecycleEvidence: [lifecycleRow(30, 0.1, 100, 999)] },
      }),
    );

    expect(result.kind).toBe('BLOCKED');
    expect(result.reasonCodes).toContain('ITEM_META_EVIDENCE_MISSING');
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('drops unevidenced candidates from ranking and reports SELL_CANDIDATE_LIFECYCLE_MISSING', () => {
    const evidence = [lifecycleRow(30, 0.3, 300)];
    const pairs = new Map<number, SellPairValueV2>([
      [30, { marginalGain: 0.5, confidence: 0.6 }],
    ]);
    const { service, evaluate } = makeService(pairs);

    const result = service.decide(makeInput({ context: { lifecycleEvidence: evidence } }));

    // Item 31 has no lifecycle row, so it cannot be ranked or simulated; item
    // 30 is the only remaining candidate and the drop is reported.
    expect(result).toMatchObject({ kind: 'REPLACE', sellItemId: 30 });
    expect(result.reasonCodes).toContain('SELL_CANDIDATE_LIFECYCLE_MISSING');
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(soldItemIds(evaluate)).toEqual([30]);
  });

  it('never sells an active-progression-protected held item', () => {
    const pairs = new Map<number, SellPairValueV2>([
      [31, { marginalGain: 0.5, confidence: 0.6 }],
    ]);
    const { service, evaluate } = makeService(pairs);

    const result = service.decide(
      makeInput({ activeProgressionProtectedItemIds: new Set([30]) }),
    );

    // Item 30 would dominate the ranking, but the active progression owns it,
    // so item 31 is the pick and item 30 is never simulated.
    expect(result).toMatchObject({ kind: 'REPLACE', sellItemId: 31 });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(soldItemIds(evaluate)).toEqual([31]);
  });

  it('gates OPTIONAL goals by the sold role threshold: CORE needs the higher core improvement', () => {
    const pairs = new Map<number, SellPairValueV2>([
      [30, { marginalGain: 0.4, confidence: 0.6 }],
    ]);
    const { service } = makeService(pairs);
    const evidence = { lifecycleEvidence: [lifecycleRow(30, 0.1, 100)] };

    const core = service.decide(
      makeInput({ archetype: archetypeFixture({ roles: { 30: 'CORE' } }), context: evidence }),
    );
    expect(core.kind).toBe('BLOCKED');
    expect(core.reasonCodes).toContain('REPLACEMENT_GAIN_BELOW_THRESHOLD');

    const frequent = service.decide(
      makeInput({ archetype: archetypeFixture({ roles: { 30: 'FREQUENT' } }), context: evidence }),
    );
    expect(frequent).toMatchObject({ kind: 'REPLACE', sellItemId: 30 });
  });
});
