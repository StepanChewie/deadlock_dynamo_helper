import { evaluateAdaptiveReplayCorrectnessV1 } from '../src/statlocker-adaptive/adaptive-replay-correctness-v1';

const sha = 'a'.repeat(64);

function item(
  itemId: number,
  options: { upgradeFrom?: number; directCost?: number } = {},
): any {
  return {
    itemId,
    name: `Item ${itemId}`,
    slotType: 'weapon',
    active: false,
    availableRulesetIds: ['ruleset-a'],
    ...(options.upgradeFrom === undefined
      ? { directPurchaseCost: options.directCost ?? 800 }
      : {}),
    upgradeRecipes: options.upgradeFrom === undefined
      ? []
      : [{
          recipeId: `upgrade:${itemId}`,
          consumedItemIds: [options.upgradeFrom],
          soulsCost: 800,
        }],
    sellTransition: { soulsRefund: 400, returnedItemIds: [] },
    maxCopies: 1,
  };
}

function decision(itemDefinitions: readonly any[], ownedItemIds: readonly number[]): any {
  return {
    state: {
      decisionId: 'decision-1',
      matchId: 'match-1',
      playerSlot: 0,
      gameTimeSec: 600,
      rulesetId: 'ruleset-a',
      heroId: 10,
      ownedItemIds,
      spendableSouls: { value: 5000, evidence: 'OBSERVED', source: 'test' },
      shopOpportunity: { value: 'AVAILABLE', evidence: 'OBSERVED', source: 'test' },
    },
    itemDefinitions,
    catalogVersionId: 'catalog-a',
    catalogSha256: sha,
    rulesetId: 'ruleset-a',
    localSteamId: 'steam-a',
    enemyHeroIds: [],
    enemyLiveStates: [],
    slots: {
      baseSlots: 1,
      baseSlotsByType: { weapon: 1, vitality: 0, spirit: 0 },
      maxFlexSlots: 0,
      maxActiveItems: 1,
      unlockedFlexSlots: 0,
      usedSlots: ownedItemIds.length,
      usedByType: { weapon: ownedItemIds.length, vitality: 0, spirit: 0 },
      usedActiveItems: 0,
      usedFlexSlots: 0,
      provedFlexLowerBound: 0,
      freeBaseSlots: Math.max(0, 1 - ownedItemIds.length),
      freeBaseByType: { weapon: Math.max(0, 1 - ownedItemIds.length), vitality: 0, spirit: 0 },
      freeFlexSlots: 0,
      totalCapacity: 1,
      mechanicsEvidence: 'RECONSTRUCTED',
      flexEvidence: 'OBSERVED',
      evidence: 'OBSERVED',
    },
    investment: {
      tracks: {
        weapon: { type: 'weapon', currentValue: 800 },
        vitality: { type: 'vitality', currentValue: 0 },
        spirit: { type: 'spirit', currentValue: 0 },
      },
      evidence: 'RECONSTRUCTED',
    },
    economyRulesEvidence: 'RECONSTRUCTED',
    stateRevision: 'revision-a',
  };
}

function evidence(): any {
  return {
    heroId: 10,
    rulesetVersion: 'ruleset-a',
    catalogSha256: sha,
    statlockerPatchId: 'patch-a',
    usable: true,
    snapshotIds: [],
    degradedReasons: [],
    families: [],
    byDataset: {},
  };
}

function result(overrides: Record<string, unknown>): any {
  return {
    ready: true,
    blockers: [],
    decisionId: 'decision-1',
    stateRevision: 'revision-a',
    gameState: 'EVEN',
    recommendedBuild: [],
    changes: [],
    rankedImmediateCandidates: [],
    totalScore: 1,
    confidence: 1,
    scorerVersion: 'adaptive-evidence-scorer-v1',
    plannerVersion: 'adaptive-build-planner-v1',
    configVersion: 'statlocker-adaptive-v1.3.0',
    evidence: {
      rulesetVersion: 'ruleset-a',
      catalogSha256: sha,
      statlockerPatchId: 'patch-a',
      snapshotIds: [],
      families: [],
      degradedReasons: [],
    },
    ...overrides,
  };
}

describe('adaptive replay correctness semantic paths', () => {
  it('treats the first legal intermediate upgrade as coherent with a later NEXT build target', () => {
    const replayDecision = decision([
      item(1),
      item(2, { upgradeFrom: 1 }),
      item(3, { upgradeFrom: 2 }),
    ], [1]);
    const replayResult = result({
      nextAction: {
        actionKey: 'UPGRADE_ITEM:2:upgrade:2',
        type: 'UPGRADE',
        itemId: 2,
        targetItemId: 2,
        reasonCodes: ['MULTI_STEP_UPGRADE_PATH'],
      },
      nextTargetItemId: 3,
      planActions: [{
        planActionId: 'revision-a:001:UPGRADE_ITEM:2:upgrade:2',
        sequence: 1,
        status: 'READY',
        action: {
          actionKey: 'UPGRADE_ITEM:2:upgrade:2',
          type: 'UPGRADE',
          itemId: 2,
          targetItemId: 2,
          reasonCodes: ['MULTI_STEP_UPGRADE_PATH'],
        },
        targetItemId: 2,
        sourceItemIds: [1],
        requirements: [{ type: 'UPGRADE_COMPONENT', itemIds: [1] }],
        reasonCodes: ['MULTI_STEP_UPGRADE_PATH'],
      }],
      recommendedBuild: [{
        itemId: 3,
        position: 1,
        status: 'NEXT',
        score: 1,
        confidence: 1,
        skeletonStrength: 1,
        contextualSupport: 0,
        reasonCodes: [],
      }],
    });

    const report = evaluateAdaptiveReplayCorrectnessV1({
      decision: replayDecision,
      evidence: evidence(),
      result: replayResult,
    });

    expect(report.metrics.planActionBuildMismatchRate.violations).toBe(0);
    expect(report.metrics.missedExecutableUpgradeRate.violations).toBe(0);
    expect(report.metrics.projectedInventoryDriftRate.violations).toBe(0);
  });

  it('allows a preparatory sell to carry the future core target without treating it as transaction projection drift', () => {
    const replayDecision = decision([item(1), item(2, { directCost: 1000 })], [1]);
    const replayResult = result({
      nextAction: {
        actionKey: 'SELL_ITEM:1',
        type: 'SELL',
        itemId: 1,
        sellItemId: 1,
        targetItemId: 2,
        reasonCodes: ['CAPACITY_EXIT'],
      },
      nextTargetItemId: 2,
      planActions: [
        {
          planActionId: 'revision-a:001:SELL_ITEM:1',
          sequence: 1,
          status: 'READY',
          action: {
            actionKey: 'SELL_ITEM:1',
            type: 'SELL',
            itemId: 1,
            sellItemId: 1,
            targetItemId: 2,
            reasonCodes: ['CAPACITY_EXIT'],
          },
          targetItemId: 2,
          sourceItemIds: [1],
          requirements: [],
          reasonCodes: ['CAPACITY_EXIT'],
        },
        {
          planActionId: 'revision-a:002:BUY_ITEM:2',
          sequence: 2,
          status: 'READY',
          action: {
            actionKey: 'BUY_ITEM:2',
            type: 'BUY',
            itemId: 2,
            targetItemId: 2,
            reasonCodes: ['LEGAL_BUY'],
          },
          targetItemId: 2,
          sourceItemIds: [],
          requirements: [],
          reasonCodes: ['LEGAL_BUY'],
        },
      ],
      recommendedBuild: [{
        itemId: 2,
        position: 1,
        status: 'NEXT',
        score: 1,
        confidence: 1,
        skeletonStrength: 1,
        contextualSupport: 0,
        reasonCodes: [],
      }],
    });

    const report = evaluateAdaptiveReplayCorrectnessV1({
      decision: replayDecision,
      evidence: evidence(),
      result: replayResult,
    });

    expect(report.metrics.projectedInventoryDriftRate.violations).toBe(0);
    expect(report.metrics.planActionBuildMismatchRate.violations).toBe(0);
  });
});
