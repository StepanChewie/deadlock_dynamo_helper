import {
  buildRecommendationRulesetCatalogV1,
  compileStrictRecommendationCatalogV1,
  generateRecommendationCandidates,
  observedFact,
} from '../src';

function baseInput() {
  return {
    version: {
      catalogVersionId: 'catalog-1',
      clientVersion: 'client-1',
      rulesetKey: 'ruleset-1',
      source: 'TEST',
      payloadSha256: 'a'.repeat(64),
    },
    items: [
      {
        itemId: 1,
        name: 'Component',
        slotType: 'weapon',
        cost: 800,
        shopable: true,
        disabled: false,
        active: true,
        isActiveItem: false,
      },
      {
        itemId: 2,
        name: 'Upgrade',
        slotType: 'weapon',
        cost: 1600,
        shopable: true,
        disabled: false,
        active: true,
        isActiveItem: false,
      },
    ],
    recipeEdges: [{ parentItemId: 2, componentItemId: 1, componentOrder: 0 }],
  } as const;
}

describe('recommendation ruleset catalog', () => {
  it('preserves version provenance and compiles known direct purchase costs', () => {
    const catalog = buildRecommendationRulesetCatalogV1(baseInput());
    const compiled = compileStrictRecommendationCatalogV1(catalog);

    expect(catalog.catalogVersionId).toBe('catalog-1');
    expect(catalog.rulesetId).toBe('ruleset-1');
    expect(catalog.payloadSha256).toBe('a'.repeat(64));
    expect(compiled.graph.getItem(1)?.directPurchaseCost).toBe(800);
    expect(compiled.graph.getItem(1)?.availableRulesetIds).toEqual(['ruleset-1']);
  });

  it('treats direct purchase as legal only for verified shopable enabled items with known cost', () => {
    const input = baseInput();
    const verified = compileStrictRecommendationCatalogV1(buildRecommendationRulesetCatalogV1(input));
    const blocked = compileStrictRecommendationCatalogV1(buildRecommendationRulesetCatalogV1({
      ...input,
      items: [
        { ...input.items[0], shopable: false },
        { ...input.items[1], disabled: true },
      ],
    }));

    expect(verified.graph.getItem(1)?.directPurchaseCost).toBe(800);
    expect(blocked.graph.getItem(1)?.directPurchaseCost).toBeUndefined();
    expect(blocked.graph.getItem(2)?.directPurchaseCost).toBeUndefined();
  });

  it('does not confuse catalog availability with active-item behavior', () => {
    const input = baseInput();
    const catalog = buildRecommendationRulesetCatalogV1({
      ...input,
      items: [{ ...input.items[0], active: false, isActiveItem: true }, input.items[1]],
    });
    const first = catalog.items.find((item) => item.itemId === 1)!;

    expect(first.activeItem.value).toBe(true);
    expect(first.rulesetAvailable.value).toBe(false);
  });

  it('excludes items when slot semantics are unknown', () => {
    const input = baseInput();
    const catalog = buildRecommendationRulesetCatalogV1({
      ...input,
      items: [{ ...input.items[0], slotType: undefined }, input.items[1]],
    });
    const compiled = compileStrictRecommendationCatalogV1(catalog);

    expect(compiled.excludedItemIds).toContain(1);
    expect(compiled.graph.getItem(1)).toBeUndefined();
  });

  it('keeps recipe topology for lineage while omitting executable UPGRADE when transaction cost is unverified', () => {
    const catalog = buildRecommendationRulesetCatalogV1(baseInput());
    expect(catalog.items.find((item) => item.itemId === 2)?.upgradeRecipes).toHaveLength(1);
    expect(catalog.items.find((item) => item.itemId === 2)?.upgradeRecipes[0].soulsCost.evidence).toBe('UNKNOWN');

    const compiled = compileStrictRecommendationCatalogV1(catalog);
    expect(compiled.graph.getItem(2)?.upgradeRecipes).toEqual([]);
    expect(compiled.graph.getDirectComponentIds(2)).toEqual([1]);
    expect(compiled.graph.getDirectUpgradeIds(1)).toEqual([2]);
    expect(compiled.graph.getTransitiveComponentIds(2)).toEqual([1]);
    expect(compiled.graph.isTargetSatisfied(1, [2])).toBe(true);
  });

  it('does not create an executable upgrade action from topology-only recipe data', () => {
    const compiled = compileStrictRecommendationCatalogV1(buildRecommendationRulesetCatalogV1(baseInput()));
    const state = {
      decisionId: 'd1',
      matchId: 'm1',
      playerSlot: 0,
      gameTimeSec: 100,
      rulesetId: compiled.rulesetId,
      heroId: 1,
      inventory: {
        initializedFromSnapshot: true,
        heldByItemId: new Map([[1, {
          itemId: 1,
          instanceId: '1:1',
          lifecycle: 1,
          acquiredBy: 'RECONCILE' as const,
          acquiredAtMs: 0,
        }]]),
        lifecycleCountByItemId: new Map([[1, 1]]),
        nextInstanceSequence: 2,
      },
      economy: {
        spendableSouls: observedFact(5_000, 'test'),
        shopOpportunity: observedFact('AVAILABLE' as const, 'test'),
      },
    };

    const candidates = generateRecommendationCandidates({ state, itemGraph: compiled.graph });
    expect(candidates.some((candidate) => candidate.action.type === 'UPGRADE_ITEM' && candidate.action.itemId === 2)).toBe(false);
    const directBuy = candidates.find((candidate) => candidate.action.type === 'BUY_ITEM' && candidate.action.itemId === 2);
    expect(directBuy?.recommendationEligible).toBe(false);
    expect(directBuy?.recommendationSuppressionReasons).toContain('UPGRADE_TRANSACTION_MECHANICS_UNKNOWN');
  });

  it('compiles exact upgrade and sell mechanics only when enriched with provenance', () => {
    const input = baseInput();
    const catalog = buildRecommendationRulesetCatalogV1({
      ...input,
      mechanics: [
        {
          itemId: 2,
          upgradeRecipeCosts: [
            {
              recipeId: 'upgrade:2',
              soulsCost: observedFact(800, 'controlled-ruleset-extractor'),
            },
          ],
          sellTransition: {
            soulsRefund: observedFact(800, 'controlled-ruleset-extractor'),
            returnedItemIds: observedFact([1], 'controlled-ruleset-extractor'),
          },
          maxCopies: observedFact(1, 'controlled-ruleset-extractor'),
        },
      ],
    });
    const compiled = compileStrictRecommendationCatalogV1(catalog);

    expect(catalog.items.find((item) => item.itemId === 2)?.upgradeRecipes[0].costSource)
      .toBe('MECHANICS_ENRICHMENT');
    expect(compiled.graph.getItem(2)?.upgradeRecipes).toEqual([
      { recipeId: 'upgrade:2', consumedItemIds: [1], soulsCost: 800 },
    ]);
    expect(compiled.graph.getDirectComponentIds(2)).toEqual([1]);
    expect(compiled.graph.getItem(2)?.sellTransition).toEqual({ soulsRefund: 800, returnedItemIds: [1] });
    expect(compiled.graph.getItem(2)?.maxCopies).toBe(1);
  });

  it('derives upgrade cost only under a verified pinned pricing policy', () => {
    const input = baseInput();
    const catalog = buildRecommendationRulesetCatalogV1({
      ...input,
      upgradePricingPolicy: {
        mode: 'TARGET_COST_MINUS_VERIFIED_COMPONENT_CREDIT',
        componentCreditRatio: 1,
        evidence: 'RECONSTRUCTED',
        source: 'ruleset-fixture:r1',
      },
    });
    const recipe = catalog.items.find((item) => item.itemId === 2)?.upgradeRecipes[0];
    const compiled = compileStrictRecommendationCatalogV1(catalog);

    expect(recipe?.soulsCost).toMatchObject({
      value: 800,
      evidence: 'RECONSTRUCTED',
      source: 'upgrade-pricing:ruleset-fixture:r1',
    });
    expect(recipe?.costSource).toBe('RULESET_DERIVED_COMPONENT_CREDIT');
    expect(compiled.graph.getItem(2)?.upgradeRecipes).toEqual([
      { recipeId: 'upgrade:2', consumedItemIds: [1], soulsCost: 800 },
    ]);
  });

  it('never derives upgrade price without a verified policy', () => {
    const catalog = buildRecommendationRulesetCatalogV1(baseInput());
    expect(catalog.items.find((item) => item.itemId === 2)?.upgradeRecipes[0].soulsCost.evidence).toBe('UNKNOWN');
    expect(catalog.items.find((item) => item.itemId === 2)?.upgradeRecipes[0].costSource).toBeUndefined();
  });

  it('rejects an inconsistent negative derived upgrade price instead of clamping it', () => {
    const input = baseInput();
    expect(() => buildRecommendationRulesetCatalogV1({
      ...input,
      items: [input.items[0], { ...input.items[1], cost: 400 }],
      upgradePricingPolicy: {
        mode: 'TARGET_COST_MINUS_VERIFIED_COMPONENT_CREDIT',
        componentCreditRatio: 1,
        evidence: 'OBSERVED',
        source: 'bad-ruleset-fixture',
      },
    })).toThrow('Derived upgrade cost for item 2 is invalid');
  });

  it('reports mechanic coverage without pretending unknown facts are known', () => {
    const catalog = buildRecommendationRulesetCatalogV1(baseInput());

    expect(catalog.coverage).toMatchObject({
      totalItems: 2,
      candidateItems: 2,
      slotTypeKnown: 2,
      activeItemKnown: 2,
      directPurchaseCostKnown: 2,
      upgradeRecipeTopologyKnown: 1,
      upgradeTransactionCostKnown: 0,
      sellTransitionKnown: 0,
      rulesetAvailabilityKnown: 2,
      strictCompilableItems: 2,
    });
  });

  it('rejects recipe references to missing catalog items', () => {
    const input = baseInput();
    expect(() => buildRecommendationRulesetCatalogV1({
      ...input,
      recipeEdges: [{ parentItemId: 2, componentItemId: 999, componentOrder: 0 }],
    })).toThrow('Recipe component 999 does not exist');
  });

  it('is deterministic when source item and recipe order changes', () => {
    const input = baseInput();
    const a = buildRecommendationRulesetCatalogV1(input);
    const b = buildRecommendationRulesetCatalogV1({
      ...input,
      items: [...input.items].reverse(),
      recipeEdges: [...input.recipeEdges].reverse(),
    });

    expect(b).toEqual(a);
  });
});
