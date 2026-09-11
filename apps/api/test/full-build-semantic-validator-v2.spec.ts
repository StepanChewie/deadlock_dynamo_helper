import { RecommendationItemDefinition, createRecommendationItemGraph } from '@deadlock-live-probe/build-domain';
import { BuildArchetypeFamilyV2, BuildArchetypeV2 } from '../src/statlocker-adaptive/build-archetype-v2';
import { DesiredBuildStateV2 } from '../src/statlocker-adaptive/build-desired-state-v2.service';
import { FullBuildStepV2 } from '../src/statlocker-adaptive/full-build-plan-v2';
import { FullBuildSemanticValidatorV2Service } from '../src/statlocker-adaptive/full-build-semantic-validator-v2.service';

function family(familyId: number, terminalItemId: number): BuildArchetypeFamilyV2 {
  return {
    familyId,
    requirement: 'REQUIRED',
    aggregateFrequencyTier: 'CORE',
    sourceProfileCount: 2,
    profileCoverage: 1,
    purchaseRate: 0.95,
    structuralPriority: 1,
    progressionNodes: [{
      itemId: terminalItemId,
      rawFrequencyTier: 'CORE',
      progressionRole: 'DEFAULT_TERMINAL',
      sourceProfileCount: 2,
      profileCoverage: 1,
      purchaseRate: 0.95,
      timing: { medianBuyTimeS: 900, spreadS: 30, phase: 'MID' },
    }],
    terminalCandidates: [{
      itemId: terminalItemId,
      kind: 'DEFAULT_TERMINAL',
      sourceProfileCount: 2,
      profileCoverage: 1,
      purchaseRate: 0.95,
      rawFrequencyTier: 'CORE',
    }],
  };
}

function upgradeFamily(familyId: number, entryItemId: number, terminalItemId: number): BuildArchetypeFamilyV2 {
  return {
    ...family(familyId, terminalItemId),
    progressionNodes: [
      {
        itemId: entryItemId,
        rawFrequencyTier: 'CORE',
        progressionRole: 'ENTRY',
        sourceProfileCount: 2,
        profileCoverage: 1,
        purchaseRate: 0.98,
        timing: { medianBuyTimeS: 300, spreadS: 20, phase: 'EARLY' },
      },
      {
        itemId: terminalItemId,
        rawFrequencyTier: 'FREQUENT',
        progressionRole: 'DEFAULT_TERMINAL',
        sourceProfileCount: 2,
        profileCoverage: 1,
        purchaseRate: 0.85,
        timing: { medianBuyTimeS: 900, spreadS: 30, phase: 'MID' },
      },
    ],
    terminalCandidates: [{
      itemId: terminalItemId,
      kind: 'DEFAULT_TERMINAL',
      sourceProfileCount: 2,
      profileCoverage: 1,
      purchaseRate: 0.85,
      rawFrequencyTier: 'FREQUENT',
    }],
  };
}

function archetype(families: readonly BuildArchetypeFamilyV2[]): BuildArchetypeV2 {
  return {
    archetypeId: 'archetype:test',
    heroId: 72,
    rulesetVersion: 'r1',
    catalogSha256: 'a'.repeat(64),
    statlockerPatchId: 'p1',
    sourceProfileAccountIds: ['p1', 'p2'],
    families,
    items: [],
    groups: [],
    orderEdges: [],
    relationships: [],
    quality: { support: 1, coherence: 0.9, separation: 0.5, sourceProfileCount: 2 },
  };
}

function desired(families: readonly BuildArchetypeFamilyV2[]): DesiredBuildStateV2 {
  return {
    families: families.map((entry) => ({
      familyId: entry.familyId,
      requirement: 'REQUIRED' as const,
      selectedTerminalItemId: entry.terminalCandidates[0].itemId,
      selectedTerminalKind: 'DEFAULT_TERMINAL' as const,
      score: 0,
      confidence: 0,
      reasonCodes: ['DEFAULT_TERMINAL_SELECTED'],
    })),
    selectedChoiceFamilyIdsByGroup: {},
    reasonCodes: [],
  };
}

function item(itemId: number, upgradeRecipes: RecommendationItemDefinition['upgradeRecipes'] = []): RecommendationItemDefinition {
  return {
    itemId,
    name: `item-${itemId}`,
    slotType: 'weapon',
    active: true,
    availableRulesetIds: ['r1'],
    directPurchaseCost: upgradeRecipes.length === 0 ? 500 : undefined,
    upgradeRecipes,
    sellTransition: { soulsRefund: 250, returnedItemIds: [] },
    maxCopies: 1,
  };
}

describe('FullBuildSemanticValidatorV2Service', () => {
  const validator = new FullBuildSemanticValidatorV2Service();

  it('marks a required family unsatisfied again when its terminal is replaced', () => {
    const x = family(1000, 101);
    const y = family(2000, 201);
    const graph = createRecommendationItemGraph([item(101), item(201)]);
    const steps: FullBuildStepV2[] = [{
      sequence: 1,
      action: 'REPLACE',
      sellItemId: 101,
      buyItemId: 201,
      consumedItemIds: [],
      inventoryBefore: [101],
      inventoryAfter: [201],
      reasonCodes: [],
    }];

    const result = validator.validate({
      archetype: archetype([x, y]),
      desiredState: desired([x, y]),
      initialInventoryItemIds: [101],
      steps,
      itemGraph: graph,
    });

    expect(result.valid).toBe(false);
    expect(result.reasonCodes).toContain('REQUIRED_FAMILY_UNSATISFIED');
    expect(result.reasonCodes).toContain('REQUIRED_FAMILY_REGRESSION');
    expect(result.finalFamilyStates.find((entry) => entry.familyId === 1000)?.status).toBe('UNSATISFIED');
  });

  it('rejects immediate buy-replace churn', () => {
    const target = family(3000, 302);
    const graph = createRecommendationItemGraph([item(301), item(302)]);
    const steps: FullBuildStepV2[] = [
      {
        sequence: 1,
        action: 'BUY',
        buyItemId: 301,
        consumedItemIds: [],
        inventoryBefore: [],
        inventoryAfter: [301],
        reasonCodes: [],
      },
      {
        sequence: 2,
        action: 'REPLACE',
        sellItemId: 301,
        buyItemId: 302,
        consumedItemIds: [],
        inventoryBefore: [301],
        inventoryAfter: [302],
        reasonCodes: [],
      },
    ];

    const result = validator.validate({
      archetype: archetype([target]),
      desiredState: desired([target]),
      initialInventoryItemIds: [],
      steps,
      itemGraph: graph,
    });

    expect(result.valid).toBe(false);
    expect(result.reasonCodes).toContain('IMMEDIATE_BUY_REPLACE_CHURN');
  });

  it('allows an acquired entry item to disappear through a legal upgrade', () => {
    const entryItemId = 401;
    const terminalItemId = 402;
    const target = upgradeFamily(4000, entryItemId, terminalItemId);
    const graph = createRecommendationItemGraph([
      item(entryItemId),
      item(terminalItemId, [{ recipeId: '401-to-402', consumedItemIds: [entryItemId], soulsCost: 1250 }]),
    ], [{ parentItemId: terminalItemId, componentItemId: entryItemId }]);
    const steps: FullBuildStepV2[] = [
      {
        sequence: 1,
        action: 'BUY',
        buyItemId: entryItemId,
        consumedItemIds: [],
        inventoryBefore: [],
        inventoryAfter: [entryItemId],
        reasonCodes: [],
      },
      {
        sequence: 2,
        action: 'UPGRADE',
        buyItemId: terminalItemId,
        recipeId: '401-to-402',
        consumedItemIds: [entryItemId],
        inventoryBefore: [entryItemId],
        inventoryAfter: [terminalItemId],
        reasonCodes: [],
      },
    ];

    const result = validator.validate({
      archetype: archetype([target]),
      desiredState: desired([target]),
      initialInventoryItemIds: [],
      steps,
      itemGraph: graph,
    });

    expect(result.valid).toBe(true);
    expect(result.reasonCodes).not.toContain('IMMEDIATE_BUY_REPLACE_CHURN');
    expect(result.reasonCodes).not.toContain('POINTLESS_PURCHASE_CHURN');
  });
});
