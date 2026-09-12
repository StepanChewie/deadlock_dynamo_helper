import { RecommendationItemDefinition, createRecommendationItemGraph } from '@deadlock-live-probe/build-domain';
import { BuildArchetypeFamilyV2, BuildArchetypeV2, BuildObservedProgressionEdgeV2 } from '../src/statlocker-adaptive/build-archetype-v2';
import { DesiredBuildStateV2 } from '../src/statlocker-adaptive/build-desired-state-v2.service';
import { simulateFullBuildInventoryV2 } from '../src/statlocker-adaptive/full-build-inventory-simulator-v2';
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
        { familyId: A, requirement: 'REQUIRED', selectedTerminalItemId: C, selectedTerminalKind: 'DEFAULT_TERMINAL', score: 0.9, confidence: 1, reasonCodes: [] },
        { familyId: otherItemId, requirement: 'REQUIRED', selectedTerminalItemId: otherItemId, selectedTerminalKind: 'DEFAULT_TERMINAL', score: 0.1, confidence: 1, reasonCodes: [] },
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
        { familyId: A, requirement: 'REQUIRED', selectedTerminalItemId: C, selectedTerminalKind: 'DEFAULT_TERMINAL', score: 0.2, confidence: 1, reasonCodes: [] },
        { familyId: optionalItemId, requirement: 'OPTIONAL', selectedTerminalItemId: optionalItemId, selectedTerminalKind: 'DEFAULT_TERMINAL', score: 1, confidence: 1, reasonCodes: [] },
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
        { familyId: A, requirement: 'REQUIRED', selectedTerminalItemId: C, selectedTerminalKind: 'DEFAULT_TERMINAL', score: 1, confidence: 1, reasonCodes: [] },
        { familyId: missingRequiredItemId, requirement: 'REQUIRED', selectedTerminalItemId: missingRequiredItemId, selectedTerminalKind: 'DEFAULT_TERMINAL', score: 1, confidence: 1, reasonCodes: [] },
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
});
