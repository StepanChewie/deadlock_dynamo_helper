import { RecommendationItemDefinition, createRecommendationItemGraph } from '@deadlock-live-probe/build-domain';
import { BuildArchetypeFamilyV2, BuildArchetypeV2, BuildObservedProgressionEdgeV2 } from '../src/statlocker-adaptive/build-archetype-v2';
import { DesiredBuildStateV2, DesiredFamilyStateV2 } from '../src/statlocker-adaptive/build-desired-state-v2.service';
import { simulateFullBuildInventoryV2 } from '../src/statlocker-adaptive/full-build-inventory-simulator-v2';
import {
  FullBuildReplacementContextV2,
  FullBuildReplacementV2Input,
  FullBuildReplacementV2Result,
  FullBuildReplacementV2Service,
} from '../src/statlocker-adaptive/full-build-replacement-v2.service';
import { FullBuildTransactionPlannerV2Service } from '../src/statlocker-adaptive/full-build-transaction-planner-v2.service';

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

function graph(extraItemIds: readonly number[] = []) {
  return createRecommendationItemGraph([
    item(A),
    item(B, { recipeId: 'A-to-B', consumedItemIds: [A] }),
    item(C, { recipeId: 'B-to-C', consumedItemIds: [B] }),
    item(D, { recipeId: 'C-to-D', consumedItemIds: [C] }),
    ...extraItemIds.map((itemId) => item(itemId)),
  ]);
}

function observedEdge(
  fromItemId: number,
  toItemId: number,
  fromMedianBuyTimeS: number,
  toMedianBuyTimeS: number,
): BuildObservedProgressionEdgeV2 {
  return {
    fromItemId,
    toItemId,
    sourceProfileCount: 8,
    orderedProfileCount: 8,
    orderConfidence: 1,
    timing: {
      fromMedianBuyTimeS,
      toMedianBuyTimeS,
      fromSpreadS: 30,
      toSpreadS: 40,
    },
    evidence: 'STATLOCKER_SAME_PROFILE',
  };
}

function family(): BuildArchetypeFamilyV2 {
  return {
    familyId: A,
    requirement: 'REQUIRED',
    aggregateFrequencyTier: 'CORE',
    sourceProfileCount: 10,
    profileCoverage: 1,
    purchaseRate: 0.98,
    structuralPriority: 1,
    progressionNodes: [
      { itemId: A, rawFrequencyTier: 'CORE', progressionRole: 'ENTRY', sourceProfileCount: 10, profileCoverage: 1, purchaseRate: 0.98, timing: { medianBuyTimeS: 300, spreadS: 30, phase: 'EARLY' } },
      { itemId: B, rawFrequencyTier: 'CORE', progressionRole: 'INTERMEDIATE', sourceProfileCount: 10, profileCoverage: 1, purchaseRate: 0.92, timing: { medianBuyTimeS: 700, spreadS: 40, phase: 'MID' } },
      { itemId: C, rawFrequencyTier: 'FREQUENT', progressionRole: 'DEFAULT_TERMINAL', sourceProfileCount: 9, profileCoverage: 0.9, purchaseRate: 0.80, timing: { medianBuyTimeS: 1_200, spreadS: 60, phase: 'MID' } },
      { itemId: D, rawFrequencyTier: 'SOMETIMES', progressionRole: 'OPTIONAL_TERMINAL', sourceProfileCount: 2, profileCoverage: 0.2, purchaseRate: 0.08, timing: { medianBuyTimeS: 1_900, spreadS: 100, phase: 'LATE' } },
    ],
    progressionEdges: [
      observedEdge(A, B, 300, 700),
      observedEdge(B, C, 700, 1_200),
      observedEdge(C, D, 1_200, 1_900),
    ],
    terminalCandidates: [
      { itemId: C, kind: 'DEFAULT_TERMINAL', sourceProfileCount: 9, profileCoverage: 0.9, purchaseRate: 0.8, rawFrequencyTier: 'FREQUENT' },
      { itemId: D, kind: 'OPTIONAL_TERMINAL', sourceProfileCount: 2, profileCoverage: 0.2, purchaseRate: 0.08, rawFrequencyTier: 'SOMETIMES' },
    ],
  };
}

function archetype(families: readonly BuildArchetypeFamilyV2[] = [family()]): BuildArchetypeV2 {
  return {
    archetypeId: 'archetype:test',
    heroId: 72,
    rulesetVersion: 'r1',
    catalogSha256: 'a'.repeat(64),
    statlockerPatchId: 'p1',
    sourceProfileAccountIds: Array.from({ length: 10 }, (_, index) => `p${index + 1}`),
    families,
    items: [],
    groups: [],
    orderEdges: [],
    relationships: [],
    quality: { support: 1, coherence: 0.9, separation: 0.5, sourceProfileCount: 10 },
  };
}

function desired(terminalItemId: number, terminalKind: 'DEFAULT_TERMINAL' | 'OPTIONAL_TERMINAL'): DesiredBuildStateV2 {
  return {
    families: [{
      familyId: A,
      requirement: 'REQUIRED',
      goalKind: 'REQUIRED',
      selectedTerminalItemId: terminalItemId,
      selectedTerminalKind: terminalKind,
      score: 0.2,
      confidence: 0.9,
      reasonCodes: [],
    }],
    selectedChoiceFamilyIdsByGroup: {},
    reasonCodes: [],
  };
}

describe('FullBuildTransactionPlannerV2Service', () => {
  const planner = new FullBuildTransactionPlannerV2Service();

  it('allows an executable one-slot upgrade when inventory is already 12/12', () => {
    const filler = Array.from({ length: 11 }, (_, index) => 1_000 + index);
    const itemGraph = graph(filler);
    const result = planner.plan({
      archetype: archetype(),
      desiredState: desired(D, 'OPTIONAL_TERMINAL'),
      itemGraph,
      rulesetId: 'r1',
      capacity: 12,
      currentInventoryItemIds: [C, ...filler],
    });

    expect(result.actions[0]).toMatchObject({ action: 'UPGRADE', buyItemId: D, recipeId: 'C-to-D' });
    expect(result.actions.some((action) => action.action === 'REPLACE')).toBe(false);

    const simulation = simulateFullBuildInventoryV2({
      rulesetId: 'r1',
      itemGraph,
      capacity: 12,
      initialInventoryItemIds: [C, ...filler],
      actions: result.actions,
    });
    expect(simulation.steps[0].consumedItemIds).toEqual([C]);
    expect(simulation.steps[0].inventoryBefore).toHaveLength(12);
    expect(simulation.steps[0].inventoryAfter).toHaveLength(12);
  });

  it('builds a full confirmed lineage with one BUY followed by UPGRADE actions', () => {
    const result = planner.plan({
      archetype: archetype(),
      desiredState: desired(D, 'OPTIONAL_TERMINAL'),
      itemGraph: graph(),
      rulesetId: 'r1',
      capacity: 12,
      currentInventoryItemIds: [],
    });

    expect(result.actions.map((action) => [action.action, action.buyItemId])).toEqual([
      ['BUY', A],
      ['UPGRADE', B],
      ['UPGRADE', C],
      ['UPGRADE', D],
    ]);
  });

  it('does not invent a component chain from progression nodes when no Statlocker edge is confirmed', () => {
    const unconfirmedFamily = { ...family(), progressionEdges: [] };
    const result = planner.plan({
      archetype: archetype([unconfirmedFamily]),
      desiredState: desired(C, 'DEFAULT_TERMINAL'),
      itemGraph: graph(),
      rulesetId: 'r1',
      capacity: 12,
      currentInventoryItemIds: [],
    });

    expect(result.actions).toEqual([]);
    expect(result.reasonCodes).toContain('NO_LEGAL_OBSERVED_LINEAGE');
  });

  it('allows a strict standalone direct purchase when no progression edge is confirmed', () => {
    const standaloneFamily = {
      ...family(),
      progressionEdges: [],
      progressionNodes: family().progressionNodes.filter((node) => node.itemId === C),
      terminalCandidates: family().terminalCandidates.filter((candidate) => candidate.itemId === C),
    };
    const directC = { ...item(C), directPurchaseCost: 1_600, upgradeRecipes: [] };
    const result = planner.plan({
      archetype: archetype([standaloneFamily]),
      desiredState: desired(C, 'DEFAULT_TERMINAL'),
      itemGraph: createRecommendationItemGraph([directC]),
      rulesetId: 'r1',
      capacity: 12,
      currentInventoryItemIds: [],
    });

    expect(result.actions).toEqual([
      expect.objectContaining({ action: 'BUY', buyItemId: C }),
    ]);
  });

  it('executes a standalone terminal as an in-place upgrade when its recipe consumes a held component', () => {
    const heldComponentId = 900;
    const upgradeC = {
      ...item(C, { recipeId: 'component-to-C', consumedItemIds: [heldComponentId] }),
      directPurchaseCost: 1_600,
    };
    const standaloneFamily = {
      ...family(),
      progressionEdges: [],
      progressionNodes: family().progressionNodes.filter((node) => node.itemId === C),
      terminalCandidates: family().terminalCandidates.filter((candidate) => candidate.itemId === C),
    };
    const result = planner.plan({
      archetype: archetype([standaloneFamily]),
      desiredState: desired(C, 'DEFAULT_TERMINAL'),
      itemGraph: createRecommendationItemGraph([item(heldComponentId), upgradeC]),
      rulesetId: 'r1',
      capacity: 12,
      currentInventoryItemIds: [heldComponentId],
    });

    expect(result.actions).toEqual([
      expect.objectContaining({ action: 'UPGRADE', buyItemId: C, recipeId: 'component-to-C' }),
    ]);
  });

  it('does not drop the last build item when a held component occupies a slot at full capacity', () => {
    // 12/12 held with a component whose upgrade recipe completes a standalone
    // goal, plus one more pending standalone goal: the in-place upgrade must
    // free the component slot so the last goal still fits without replacement.
    const heldComponentId = 900;
    const lateGoalId = 901;
    const upgradeC = {
      ...item(C, { recipeId: 'component-to-C', consumedItemIds: [heldComponentId] }),
      directPurchaseCost: 1_600,
    };
    const standaloneC = {
      ...family(),
      familyId: 300,
      progressionEdges: [],
      progressionNodes: family().progressionNodes.filter((node) => node.itemId === C),
      terminalCandidates: family().terminalCandidates.filter((candidate) => candidate.itemId === C),
    };
    const standaloneLate = standaloneFamily(lateGoalId, lateGoalId, 1_500);
    const filler = fillerInventory(10, 1_000);
    const currentInventory = [heldComponentId, ...filler];

    const localDesired: DesiredBuildStateV2 = {
      families: [
        { ...desired(C, 'DEFAULT_TERMINAL').families[0], familyId: 300 },
        { ...desired(lateGoalId, 'DEFAULT_TERMINAL').families[0], familyId: lateGoalId },
      ],
      selectedChoiceFamilyIdsByGroup: {},
      reasonCodes: [],
    };
    const result = planner.plan({
      archetype: archetype([standaloneC, standaloneLate]),
      desiredState: localDesired,
      itemGraph: createRecommendationItemGraph([
        item(heldComponentId),
        item(lateGoalId),
        upgradeC,
        ...Array.from({ length: 10 }, (_, index) => item(1_000 + index)),
      ]),
      rulesetId: 'r1',
      capacity: 12,
      currentInventoryItemIds: currentInventory,
    });

    expect(result.actions).toEqual([
      expect.objectContaining({ action: 'UPGRADE', buyItemId: C }),
      expect.objectContaining({ action: 'BUY', buyItemId: lateGoalId }),
    ]);
  });

  it('fails closed when Statlocker confirms progression but the executable recipe is unavailable', () => {
    const confirmedFamily = {
      ...family(),
      progressionNodes: family().progressionNodes.filter((node) => node.itemId === A || node.itemId === C),
      progressionEdges: [observedEdge(A, C, 300, 1_200)],
      terminalCandidates: family().terminalCandidates.filter((candidate) => candidate.itemId === C),
    };
    const directC = { ...item(C), directPurchaseCost: 1_600, upgradeRecipes: [] };
    const itemGraph = createRecommendationItemGraph(
      [item(A), directC],
      [{ parentItemId: C, componentItemId: A }],
    );
    const result = planner.plan({
      archetype: archetype([confirmedFamily]),
      desiredState: desired(C, 'DEFAULT_TERMINAL'),
      itemGraph,
      rulesetId: 'r1',
      capacity: 12,
      currentInventoryItemIds: [],
    });

    expect(result.actions).toEqual([]);
    expect(result.reasonCodes).toContain('CONFIRMED_PROGRESSION_RECIPE_UNAVAILABLE');
  });

  it('interleaves family transactions by lineage-specific Statlocker timing instead of generic node timing', () => {
    const otherItemId = 999;
    const misleadingNodeTimingFamily: BuildArchetypeFamilyV2 = {
      ...family(),
      progressionNodes: family().progressionNodes.map((node) =>
        node.itemId === B
          ? { ...node, timing: { ...node.timing, medianBuyTimeS: 350 } }
          : node.itemId === C
            ? { ...node, timing: { ...node.timing, medianBuyTimeS: 400 } }
            : node,
      ),
    };
    const otherFamily: BuildArchetypeFamilyV2 = {
      familyId: otherItemId,
      requirement: 'REQUIRED',
      aggregateFrequencyTier: 'CORE',
      sourceProfileCount: 10,
      profileCoverage: 1,
      purchaseRate: 0.95,
      structuralPriority: 1,
      progressionNodes: [{
        itemId: otherItemId,
        rawFrequencyTier: 'CORE',
        progressionRole: 'DEFAULT_TERMINAL',
        sourceProfileCount: 10,
        profileCoverage: 1,
        purchaseRate: 0.95,
        timing: { medianBuyTimeS: 500, spreadS: 30, phase: 'EARLY' },
      }],
      progressionEdges: [],
      terminalCandidates: [{
        itemId: otherItemId,
        kind: 'DEFAULT_TERMINAL',
        sourceProfileCount: 10,
        profileCoverage: 1,
        purchaseRate: 0.95,
        rawFrequencyTier: 'CORE',
      }],
    };
    const value = archetype([misleadingNodeTimingFamily, otherFamily]);
    const target: DesiredBuildStateV2 = {
      families: [
        { familyId: A, requirement: 'REQUIRED', goalKind: 'REQUIRED', selectedTerminalItemId: C, selectedTerminalKind: 'DEFAULT_TERMINAL', score: 0.9, confidence: 1, reasonCodes: [] },
        { familyId: otherItemId, requirement: 'REQUIRED', goalKind: 'REQUIRED', selectedTerminalItemId: otherItemId, selectedTerminalKind: 'DEFAULT_TERMINAL', score: 0.1, confidence: 1, reasonCodes: [] },
      ],
      selectedChoiceFamilyIdsByGroup: {},
      reasonCodes: [],
    };

    const result = planner.plan({
      archetype: value,
      desiredState: target,
      itemGraph: graph([otherItemId]),
      rulesetId: 'r1',
      capacity: 12,
      currentInventoryItemIds: [],
    });

    expect(result.actions.map((action) => [action.action, action.buyItemId])).toEqual([
      ['BUY', A],
      ['BUY', otherItemId],
      ['UPGRADE', B],
      ['UPGRADE', C],
    ]);
  });

  it('stops at the selected default terminal instead of upgrading to an unselected optional terminal', () => {
    const result = planner.plan({
      archetype: archetype(),
      desiredState: desired(C, 'DEFAULT_TERMINAL'),
      itemGraph: graph(),
      rulesetId: 'r1',
      capacity: 12,
      currentInventoryItemIds: [],
    });

    expect(result.actions.map((action) => [action.action, action.buyItemId])).toEqual([
      ['BUY', A],
      ['UPGRADE', B],
      ['UPGRADE', C],
    ]);
    expect(result.actions.some((action) => action.buyItemId === D)).toBe(false);
  });

  it('does not replace a satisfied REQUIRED family merely to add another family at full capacity', () => {
    const requiredX = family();
    const optionalItemId = 999;
    const optionalFamily: BuildArchetypeFamilyV2 = {
      familyId: optionalItemId,
      requirement: 'OPTIONAL',
      aggregateFrequencyTier: 'FREQUENT',
      sourceProfileCount: 7,
      profileCoverage: 0.7,
      purchaseRate: 0.6,
      structuralPriority: 0.6,
      progressionNodes: [{ itemId: optionalItemId, rawFrequencyTier: 'FREQUENT', progressionRole: 'DEFAULT_TERMINAL', sourceProfileCount: 7, profileCoverage: 0.7, purchaseRate: 0.6, timing: { medianBuyTimeS: 1_200, spreadS: 60, phase: 'MID' } }],
      progressionEdges: [],
      terminalCandidates: [{ itemId: optionalItemId, kind: 'DEFAULT_TERMINAL', sourceProfileCount: 7, profileCoverage: 0.7, purchaseRate: 0.6, rawFrequencyTier: 'FREQUENT' }],
    };
    const filler = Array.from({ length: 11 }, (_, index) => 2_000 + index);
    const itemGraph = createRecommendationItemGraph([
      item(C),
      item(optionalItemId),
      ...filler.map((itemId) => item(itemId)),
    ]);
    const value = archetype([requiredX, optionalFamily]);
    const target: DesiredBuildStateV2 = {
      families: [
        { familyId: A, requirement: 'REQUIRED', goalKind: 'REQUIRED', selectedTerminalItemId: C, selectedTerminalKind: 'DEFAULT_TERMINAL', score: 0.2, confidence: 1, reasonCodes: [] },
        { familyId: optionalItemId, requirement: 'OPTIONAL', goalKind: 'OPTIONAL', selectedTerminalItemId: optionalItemId, selectedTerminalKind: 'DEFAULT_TERMINAL', score: 1, confidence: 1, reasonCodes: [] },
      ],
      selectedChoiceFamilyIdsByGroup: {},
      reasonCodes: [],
    };

    const result = planner.plan({
      archetype: value,
      desiredState: target,
      itemGraph,
      rulesetId: 'r1',
      capacity: 12,
      currentInventoryItemIds: [C, ...filler],
    });

    expect(result.actions).toEqual([]);
    expect(result.reasonCodes).toContain('REQUIRED_FAMILY_REGRESSION');
  });

  it('preserves each satisfied REQUIRED family when another REQUIRED family is missing', () => {
    const missingRequiredItemId = 999;
    const fillerItemId = 2_000;
    const missingRequiredFamily: BuildArchetypeFamilyV2 = {
      familyId: missingRequiredItemId,
      requirement: 'REQUIRED',
      aggregateFrequencyTier: 'CORE',
      sourceProfileCount: 10,
      profileCoverage: 1,
      purchaseRate: 0.95,
      structuralPriority: 1,
      progressionNodes: [{
        itemId: missingRequiredItemId,
        rawFrequencyTier: 'CORE',
        progressionRole: 'DEFAULT_TERMINAL',
        sourceProfileCount: 10,
        profileCoverage: 1,
        purchaseRate: 0.95,
        timing: { medianBuyTimeS: 1_200, spreadS: 60, phase: 'MID' },
      }],
      progressionEdges: [],
      terminalCandidates: [{
        itemId: missingRequiredItemId,
        kind: 'DEFAULT_TERMINAL',
        sourceProfileCount: 10,
        profileCoverage: 1,
        purchaseRate: 0.95,
        rawFrequencyTier: 'CORE',
      }],
    };
    const value = archetype([family(), missingRequiredFamily]);
    const target: DesiredBuildStateV2 = {
      families: [
        { familyId: A, requirement: 'REQUIRED', goalKind: 'REQUIRED', selectedTerminalItemId: C, selectedTerminalKind: 'DEFAULT_TERMINAL', score: 1, confidence: 1, reasonCodes: [] },
        { familyId: missingRequiredItemId, requirement: 'REQUIRED', goalKind: 'REQUIRED', selectedTerminalItemId: missingRequiredItemId, selectedTerminalKind: 'DEFAULT_TERMINAL', score: 1, confidence: 1, reasonCodes: [] },
      ],
      selectedChoiceFamilyIdsByGroup: {},
      reasonCodes: [],
    };

    const result = planner.plan({
      archetype: value,
      desiredState: target,
      itemGraph: createRecommendationItemGraph([
        item(C),
        item(missingRequiredItemId),
        item(fillerItemId),
      ]),
      rulesetId: 'r1',
      capacity: 2,
      currentInventoryItemIds: [C, fillerItemId],
    });

    expect(result.actions).toEqual([]);
    expect(result.reasonCodes).toContain('REQUIRED_FAMILY_REGRESSION');
  });

  class StubFullBuildReplacementV2Service {
    readonly calls: FullBuildReplacementV2Input[] = [];

    constructor(private readonly respond?: (input: FullBuildReplacementV2Input) => FullBuildReplacementV2Result) {}

    decide(input: FullBuildReplacementV2Input): FullBuildReplacementV2Result {
      this.calls.push(input);
      return this.respond
        ? this.respond(input)
        : { kind: 'BLOCKED', reasonCodes: ['STUB_BLOCKED'] };
    }
  }

  function fillerInventory(count: number, startItemId = 2_000): number[] {
    return Array.from({ length: count }, (_, index) => startItemId + index);
  }

  function standaloneFamily(
    familyId: number,
    itemId: number,
    medianBuyTimeS: number,
    requirement: 'REQUIRED' | 'OPTIONAL' = 'OPTIONAL',
  ): BuildArchetypeFamilyV2 {
    return {
      familyId,
      requirement,
      aggregateFrequencyTier: 'FREQUENT',
      sourceProfileCount: 5,
      profileCoverage: 0.5,
      purchaseRate: 0.5,
      structuralPriority: 0.5,
      progressionNodes: [{
        itemId,
        rawFrequencyTier: 'FREQUENT',
        progressionRole: 'DEFAULT_TERMINAL',
        sourceProfileCount: 5,
        profileCoverage: 0.5,
        purchaseRate: 0.5,
        timing: { medianBuyTimeS, spreadS: 30, phase: 'MID' },
      }],
      progressionEdges: [],
      terminalCandidates: [{
        itemId,
        kind: 'DEFAULT_TERMINAL',
        sourceProfileCount: 5,
        profileCoverage: 0.5,
        purchaseRate: 0.5,
        rawFrequencyTier: 'FREQUENT',
      }],
    };
  }

  function twoNodeFamily(
    familyId: number,
    fromItemId: number,
    toItemId: number,
    toMedianBuyTimeS: number,
  ): BuildArchetypeFamilyV2 {
    return {
      familyId,
      requirement: 'OPTIONAL',
      aggregateFrequencyTier: 'FREQUENT',
      sourceProfileCount: 5,
      profileCoverage: 0.5,
      purchaseRate: 0.5,
      structuralPriority: 0.5,
      progressionNodes: [
        {
          itemId: fromItemId,
          rawFrequencyTier: 'FREQUENT',
          progressionRole: 'ENTRY',
          sourceProfileCount: 5,
          profileCoverage: 0.5,
          purchaseRate: 0.5,
          timing: { medianBuyTimeS: 100, spreadS: 20, phase: 'EARLY' },
        },
        {
          itemId: toItemId,
          rawFrequencyTier: 'FREQUENT',
          progressionRole: 'DEFAULT_TERMINAL',
          sourceProfileCount: 5,
          profileCoverage: 0.5,
          purchaseRate: 0.5,
          timing: { medianBuyTimeS: toMedianBuyTimeS, spreadS: 20, phase: 'MID' },
        },
      ],
      progressionEdges: [observedEdge(fromItemId, toItemId, 100, toMedianBuyTimeS)],
      terminalCandidates: [{
        itemId: toItemId,
        kind: 'DEFAULT_TERMINAL',
        sourceProfileCount: 5,
        profileCoverage: 0.5,
        purchaseRate: 0.5,
        rawFrequencyTier: 'FREQUENT',
      }],
    };
  }

  function goalFor(
    family: BuildArchetypeFamilyV2,
    terminalItemId: number,
    requirement: 'REQUIRED' | 'OPTIONAL' = 'OPTIONAL',
  ): DesiredFamilyStateV2 {
    return {
      familyId: family.familyId,
      requirement,
      goalKind: requirement === 'REQUIRED' ? 'REQUIRED' : 'OPTIONAL',
      selectedTerminalItemId: terminalItemId,
      selectedTerminalKind: 'DEFAULT_TERMINAL',
      score: 0.5,
      confidence: 1,
      reasonCodes: [],
    };
  }

  function desiredStateOf(goals: readonly DesiredFamilyStateV2[]): DesiredBuildStateV2 {
    return { families: goals, selectedChoiceFamilyIdsByGroup: {}, reasonCodes: [] };
  }

  function purchasableGraph(itemIds: readonly number[]) {
    return createRecommendationItemGraph(itemIds.map((itemId) => item(itemId)));
  }

  function replacementContext(): FullBuildReplacementContextV2 {
    return {
      heroId: 72,
      gameTimeSec: 600,
      enemyHeroIds: [1, 2, 3, 4, 5, 6],
      enemyThreats: [],
      vsHeroRows: [],
      lifecycleEvidence: [],
    };
  }

  describe('full capacity replacement integration', () => {
    it('does not consult the replacement service for a family-entry BUY below capacity (11/12 + BUY)', () => {
      const stub = new StubFullBuildReplacementV2Service();
      const planner = new FullBuildTransactionPlannerV2Service(stub as unknown as FullBuildReplacementV2Service);
      const filler = fillerInventory(11);
      const extraItemId = 999;
      const families = [standaloneFamily(extraItemId, extraItemId, 300)];

      const result = planner.plan({
        archetype: archetype(families),
        desiredState: desiredStateOf([goalFor(families[0], extraItemId)]),
        itemGraph: purchasableGraph([...filler, extraItemId]),
        rulesetId: 'r1',
        capacity: 12,
        currentInventoryItemIds: filler,
        replacementContext: replacementContext(),
      });

      expect(stub.calls).toHaveLength(0);
      expect(result.actions).toEqual([
        expect.objectContaining({ action: 'BUY', buyItemId: extraItemId }),
      ]);
      expect(result.reasonCodes).not.toContain('CAPACITY_BLOCKED_NO_SAFE_REPLACEMENT');
      const simulation = simulateFullBuildInventoryV2({
        rulesetId: 'r1',
        itemGraph: purchasableGraph([...filler, extraItemId]),
        capacity: 12,
        initialInventoryItemIds: filler,
        actions: result.actions,
      });
      expect(simulation.finalInventoryItemIds).toHaveLength(12);
    });

    it('does not consult the replacement service for an UPGRADE of a held component at 12/12', () => {
      const stub = new StubFullBuildReplacementV2Service();
      const planner = new FullBuildTransactionPlannerV2Service(stub as unknown as FullBuildReplacementV2Service);
      const filler = fillerInventory(11);
      const itemGraph = graph(filler);

      const result = planner.plan({
        archetype: archetype(),
        desiredState: desired(D, 'OPTIONAL_TERMINAL'),
        itemGraph,
        rulesetId: 'r1',
        capacity: 12,
        currentInventoryItemIds: [C, ...filler],
        replacementContext: replacementContext(),
      });

      expect(stub.calls).toHaveLength(0);
      expect(result.actions[0]).toMatchObject({ action: 'UPGRADE', buyItemId: D, recipeId: 'C-to-D' });
      const simulation = simulateFullBuildInventoryV2({
        rulesetId: 'r1',
        itemGraph,
        capacity: 12,
        initialInventoryItemIds: [C, ...filler],
        actions: result.actions,
      });
      expect(simulation.finalInventoryItemIds).toHaveLength(12);
    });

    it('delegates exactly once to the replacement service for a new family-entry BUY at 12/12', () => {
      const stub = new StubFullBuildReplacementV2Service(() => ({
        kind: 'REPLACE',
        sellItemId: 2_000,
        reasonCodes: ['STUB_SELL'],
      }));
      const planner = new FullBuildTransactionPlannerV2Service(stub as unknown as FullBuildReplacementV2Service);
      const filler = fillerInventory(12);
      const extraItemId = 999;
      const families = [standaloneFamily(extraItemId, extraItemId, 300)];
      const context = replacementContext();

      const result = planner.plan({
        archetype: archetype(families),
        desiredState: desiredStateOf([goalFor(families[0], extraItemId)]),
        itemGraph: purchasableGraph([...filler, extraItemId]),
        rulesetId: 'r1',
        capacity: 12,
        currentInventoryItemIds: filler,
        replacementContext: context,
      });

      expect(stub.calls).toHaveLength(1);
      expect(stub.calls[0].buyItemId).toBe(extraItemId);
      expect(stub.calls[0].projectedInventoryItemIds).toEqual(filler);
      expect(stub.calls[0].rulesetId).toBe('r1');
      expect(stub.calls[0].context).toEqual(context);
      expect([...stub.calls[0].activeProgressionProtectedItemIds]).toEqual([]);
      expect(result.actions).toEqual([
        expect.objectContaining({ action: 'REPLACE', sellItemId: 2_000, buyItemId: extraItemId }),
      ]);
      expect(result.actions[0].reasonCodes).toContain('FAMILY_ENTRY_REPLACEMENT');
      const simulation = simulateFullBuildInventoryV2({
        rulesetId: 'r1',
        itemGraph: purchasableGraph([...filler, extraItemId]),
        capacity: 12,
        initialInventoryItemIds: filler,
        actions: result.actions,
      });
      expect(simulation.finalInventoryItemIds).toHaveLength(12);
      expect(simulation.finalInventoryItemIds).toContain(extraItemId);
      expect(simulation.finalInventoryItemIds).not.toContain(2_000);
    });

    it('protects only held items consumed by future accepted upgrades when replacing at 12/12', () => {
      const stub = new StubFullBuildReplacementV2Service(() => ({
        kind: 'REPLACE',
        sellItemId: 2_000,
        reasonCodes: ['STUB_SELL'],
      }));
      const planner = new FullBuildTransactionPlannerV2Service(stub as unknown as FullBuildReplacementV2Service);
      const filler = fillerInventory(10);
      const extraItemId = 999;
      const families = [family(), standaloneFamily(extraItemId, extraItemId, 300)];

      const result = planner.plan({
        archetype: archetype(families),
        desiredState: desiredStateOf([
          { ...goalFor(families[0], D), selectedTerminalKind: 'OPTIONAL_TERMINAL' },
          goalFor(families[1], extraItemId),
        ]),
        itemGraph: graph([...filler, extraItemId]),
        rulesetId: 'r1',
        capacity: 12,
        currentInventoryItemIds: [A, B, ...filler],
        replacementContext: replacementContext(),
      });

      expect(stub.calls).toHaveLength(1);
      expect(stub.calls[0].buyItemId).toBe(extraItemId);
      expect([...stub.calls[0].activeProgressionProtectedItemIds]).toEqual([B]);
      expect(result.actions[0]).toMatchObject({ action: 'REPLACE', sellItemId: 2_000, buyItemId: extraItemId });
      expect(result.actions.some((action) => action.action === 'UPGRADE' && action.buyItemId === C)).toBe(true);
    });

    it('keeps planning past capacity with a 13th goal: more than 12 rows and never more than 12 held items', () => {
      const stub = new StubFullBuildReplacementV2Service((input) => ({
        kind: 'REPLACE',
        sellItemId: input.projectedInventoryItemIds[0],
        reasonCodes: ['STUB_SELL'],
      }));
      const planner = new FullBuildTransactionPlannerV2Service(stub as unknown as FullBuildReplacementV2Service);
      const familyIds = Array.from({ length: 14 }, (_, index) => index + 1);
      const families = familyIds.map((familyId) => standaloneFamily(familyId, familyId, 300));
      const itemGraph = purchasableGraph(familyIds);

      const result = planner.plan({
        archetype: archetype(families),
        desiredState: desiredStateOf(families.map((family) => goalFor(family, family.progressionNodes[0].itemId))),
        itemGraph,
        rulesetId: 'r1',
        capacity: 12,
        currentInventoryItemIds: [],
        replacementContext: replacementContext(),
      });

      expect(result.actions.length).toBeGreaterThan(12);
      expect(stub.calls).toHaveLength(2);
      expect(result.reasonCodes).not.toContain('CAPACITY_BLOCKED_NO_SAFE_REPLACEMENT');
      for (let prefixLength = 1; prefixLength <= result.actions.length; prefixLength += 1) {
        const prefix = simulateFullBuildInventoryV2({
          rulesetId: 'r1',
          itemGraph,
          capacity: 12,
          initialInventoryItemIds: [],
          actions: result.actions.slice(0, prefixLength),
        });
        expect(prefix.validation.valid).toBe(true);
        expect(prefix.finalInventoryItemIds.length).toBeLessThanOrEqual(12);
      }
    });

    it('upgrades a REPLACE-introduced component in place after unrelated interleaved transactions', () => {
      const stub = new StubFullBuildReplacementV2Service(() => ({
        kind: 'REPLACE',
        sellItemId: 2_010,
        reasonCodes: ['STUB_SELL'],
      }));
      const planner = new FullBuildTransactionPlannerV2Service(stub as unknown as FullBuildReplacementV2Service);
      const filler = fillerInventory(11);
      const componentItemId = 300;
      const terminalItemId = 301;
      const otherComponentItemId = 400;
      const otherTerminalItemId = 401;
      const itemGraph = createRecommendationItemGraph([
        item(componentItemId),
        item(terminalItemId, { recipeId: '300-to-301', consumedItemIds: [componentItemId] }),
        item(otherComponentItemId),
        item(otherTerminalItemId, { recipeId: '400-to-401', consumedItemIds: [otherComponentItemId] }),
        ...filler.map((itemId) => item(itemId)),
      ]);
      const componentFamily = twoNodeFamily(componentItemId, componentItemId, terminalItemId, 900);
      const otherFamily = twoNodeFamily(otherTerminalItemId, otherComponentItemId, otherTerminalItemId, 500);

      const result = planner.plan({
        archetype: archetype([componentFamily, otherFamily]),
        desiredState: desiredStateOf([
          goalFor(componentFamily, terminalItemId),
          goalFor(otherFamily, otherTerminalItemId),
        ]),
        itemGraph,
        rulesetId: 'r1',
        capacity: 12,
        currentInventoryItemIds: [otherComponentItemId, ...filler],
        replacementContext: replacementContext(),
      });

      expect(stub.calls).toHaveLength(1);
      expect([...stub.calls[0].activeProgressionProtectedItemIds]).toEqual([otherComponentItemId]);
      expect(result.actions).toEqual([
        expect.objectContaining({ action: 'REPLACE', sellItemId: 2_010, buyItemId: componentItemId }),
        expect.objectContaining({ action: 'UPGRADE', buyItemId: otherTerminalItemId, recipeId: '400-to-401' }),
        expect.objectContaining({ action: 'UPGRADE', buyItemId: terminalItemId, recipeId: '300-to-301' }),
      ]);
      const simulation = simulateFullBuildInventoryV2({
        rulesetId: 'r1',
        itemGraph,
        capacity: 12,
        initialInventoryItemIds: [otherComponentItemId, ...filler],
        actions: result.actions,
      });
      expect(simulation.finalInventoryItemIds).toHaveLength(12);
      expect(simulation.finalInventoryItemIds).toContain(terminalItemId);
      expect(simulation.finalInventoryItemIds).toContain(otherTerminalItemId);
      expect(simulation.steps[2].consumedItemIds).toEqual([componentItemId]);
    });

    it('blocks the incoming goal without selling when the replacement service is blocked and continues independent goals', () => {
      const blockedItemId = 500;
      const independentItemId = 501;
      const stub = new StubFullBuildReplacementV2Service((input) =>
        input.buyItemId === blockedItemId
          ? { kind: 'BLOCKED', reasonCodes: ['STUB_NO_SAFE_SELL'] }
          : { kind: 'REPLACE', sellItemId: 2_000, reasonCodes: ['STUB_SELL'] });
      const planner = new FullBuildTransactionPlannerV2Service(stub as unknown as FullBuildReplacementV2Service);
      const filler = fillerInventory(12);
      const blockedFamily = standaloneFamily(blockedItemId, blockedItemId, 100, 'REQUIRED');
      const independentFamily = standaloneFamily(independentItemId, independentItemId, 500);

      const result = planner.plan({
        archetype: archetype([blockedFamily, independentFamily]),
        desiredState: desiredStateOf([
          goalFor(blockedFamily, blockedItemId, 'REQUIRED'),
          goalFor(independentFamily, independentItemId),
        ]),
        itemGraph: purchasableGraph([...filler, blockedItemId, independentItemId]),
        rulesetId: 'r1',
        capacity: 12,
        currentInventoryItemIds: filler,
        replacementContext: replacementContext(),
      });

      expect(stub.calls).toHaveLength(2);
      expect(result.reasonCodes).toContain('CAPACITY_BLOCKED_NO_SAFE_REPLACEMENT');
      expect(result.reasonCodes).toContain('STUB_NO_SAFE_SELL');
      expect(result.reasonCodes).not.toContain('REQUIRED_FAMILY_REGRESSION');
      expect(result.actions).toEqual([
        expect.objectContaining({ action: 'REPLACE', sellItemId: 2_000, buyItemId: independentItemId }),
      ]);
    });
  });
});
