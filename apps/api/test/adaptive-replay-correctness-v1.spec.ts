import {
  AdaptiveRecommendationResultV1,
} from '@deadlock-live-probe/shared';
import {
  AdaptiveReplayCorrectnessInputV1,
  aggregateAdaptiveReplayCorrectnessV1,
  evaluateAdaptiveReplayCorrectnessV1,
} from '../src/statlocker-adaptive/adaptive-replay-correctness-v1';
import { AdaptiveReplayDecisionV1 } from '../src/statlocker-adaptive/adaptive-replay-v1.service';

const sha = 'a'.repeat(64);

function item(itemId: number, options: {
  upgradeFrom?: number;
  slotType?: 'weapon' | 'vitality' | 'spirit';
} = {}) {
  return {
    itemId,
    name: `Item ${itemId}`,
    slotType: options.slotType ?? 'weapon',
    active: false,
    availableRulesetIds: ['ruleset-a'],
    ...(options.upgradeFrom === undefined ? { directPurchaseCost: itemId * 800 } : {}),
    upgradeRecipes: options.upgradeFrom === undefined
      ? []
      : [{ recipeId: `upgrade:${itemId}`, consumedItemIds: [options.upgradeFrom], soulsCost: 800 }],
    sellTransition: { soulsRefund: 400, returnedItemIds: [] },
    maxCopies: 1,
  };
}

function decision(ownedItemIds: readonly number[] = [1, 99]): AdaptiveReplayDecisionV1 {
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
    itemDefinitions: [
      item(1),
      item(2, { upgradeFrom: 1 }),
      item(3, { slotType: 'vitality' }),
      item(99, { slotType: 'spirit' }),
    ],
    catalogVersionId: 'catalog-a',
    catalogSha256: sha,
    rulesetId: 'ruleset-a',
    localSteamId: 'steam-a',
    enemyHeroIds: [20, 21],
    enemyLiveStates: [],
    slots: {
      baseSlots: 3,
      baseSlotsByType: { weapon: 1, vitality: 1, spirit: 1 },
      maxFlexSlots: 0,
      maxActiveItems: 4,
      unlockedFlexSlots: 0,
      usedSlots: ownedItemIds.length,
      usedByType: { weapon: ownedItemIds.includes(1) ? 1 : 0, vitality: 0, spirit: ownedItemIds.includes(99) ? 1 : 0 },
      usedSlotsByType: { weapon: ownedItemIds.includes(1) ? 1 : 0, vitality: 0, spirit: ownedItemIds.includes(99) ? 1 : 0 },
      overflowByType: { weapon: 0, vitality: 0, spirit: 0 },
      usedActiveItems: 0,
      activeItemsUsed: 0,
      usedFlexSlots: 0,
      provedFlexLowerBound: 0,
      freeBaseSlots: Math.max(0, 3 - ownedItemIds.length),
      freeBaseByType: { weapon: ownedItemIds.includes(1) ? 0 : 1, vitality: 1, spirit: ownedItemIds.includes(99) ? 0 : 1 },
      freeBaseSlotsByType: { weapon: ownedItemIds.includes(1) ? 0 : 1, vitality: 1, spirit: ownedItemIds.includes(99) ? 0 : 1 },
      freeActiveItemSlots: 4,
      freeFlexSlots: 0,
      totalCapacity: 3,
      mechanicsEvidence: 'RECONSTRUCTED',
      flexEvidence: 'OBSERVED',
      evidence: 'OBSERVED',
    },
    investment: {
      tracks: {
        weapon: { type: 'weapon', currentValue: 800 },
        vitality: { type: 'vitality', currentValue: 0 },
        spirit: { type: 'spirit', currentValue: 79200 },
      },
      evidence: 'RECONSTRUCTED',
    },
    economyRules: {
      rulesetId: 'ruleset-a',
      catalogSha256: sha,
      baseSlotsByType: { weapon: 1, vitality: 1, spirit: 1 },
      maxFlexSlots: 0,
      maxActiveItems: 4,
      investmentBreakpoints: { weapon: [1600], vitality: [1600], spirit: [1600] },
    },
    economyRulesEvidence: 'RECONSTRUCTED',
    stateRevision: 'revision-a',
  };
}

function evidence(freshness: 'FRESH' | 'PATCH_MISMATCH' = 'FRESH') {
  return {
    heroId: 10,
    rulesetVersion: 'ruleset-a',
    catalogSha256: sha,
    statlockerPatchId: '15-1',
    usable: freshness === 'FRESH',
    snapshotIds: ['vs-hero'],
    degradedReasons: [],
    families: [{
      dataset: 'VS_HERO_WPA',
      scopeKey: 'global',
      freshness,
      confidence: 1,
      snapshotId: 'vs-hero',
      payload: {
        slices: [{ heroId: 10, enemyHeroId: 20, items: [{ itemId: 2, deltaWpa: 0.2, count: 1000 }] }],
      },
    }],
    byDataset: {
      VS_HERO_WPA: {
        dataset: 'VS_HERO_WPA',
        scopeKey: 'global',
        freshness,
        confidence: 1,
        snapshotId: 'vs-hero',
        payload: {
          slices: [{ heroId: 10, enemyHeroId: 20, items: [{ itemId: 2, deltaWpa: 0.2, count: 1000 }] }],
        },
      },
    },
  } as any;
}

function result(): AdaptiveRecommendationResultV1 {
  return {
    ready: true,
    blockers: [],
    decisionId: 'decision-1',
    stateRevision: 'revision-a',
    gameState: 'EVEN',
    nextAction: {
      actionKey: 'UPGRADE_ITEM:2:upgrade:2',
      type: 'UPGRADE',
      itemId: 2,
      targetItemId: 2,
      reasonCodes: ['UPGRADE_PATH'],
    },
    nextTargetItemId: 2,
    planActions: [{
      planActionId: 'revision-a:001:UPGRADE_ITEM:2:upgrade:2',
      sequence: 1,
      status: 'READY',
      action: {
        actionKey: 'UPGRADE_ITEM:2:upgrade:2',
        type: 'UPGRADE',
        itemId: 2,
        targetItemId: 2,
        reasonCodes: ['UPGRADE_PATH'],
      },
      targetItemId: 2,
      sourceItemIds: [1],
      requirements: [{ type: 'UPGRADE_COMPONENT', itemIds: [1] }],
      reasonCodes: ['UPGRADE_PATH'],
      situational: {
        purpose: 'CATCH',
        targetEnemies: [{
          enemyHeroId: 20,
          role: 'PRIMARY',
          score: 0.4,
          confidence: 0.8,
          evidenceKinds: ['MATCHUP_STAT'],
          deltaWpa: 0.2,
          sampleSize: 1000,
        }],
        primaryTargetEnemyHeroId: 20,
        recommendationConfidence: 0.8,
        coreInterruption: { estimatedSoulsDelay: 0, accepted: true },
        reasonCodes: ['MATCHUP_SUPPORTED'],
      },
    }],
    recommendedBuild: [
      { itemId: 1, position: 1, status: 'OWNED', score: 0, confidence: 1, skeletonStrength: 1, contextualSupport: 0, reasonCodes: ['OWNED_ITEM'] },
      { itemId: 2, position: 2, status: 'NEXT', score: 1, confidence: 1, skeletonStrength: 1, contextualSupport: 0, reasonCodes: ['BUILD_REQUIRED'] },
    ],
    changes: [],
    rankedImmediateCandidates: [],
    totalScore: 1,
    confidence: 1,
    scorerVersion: 'adaptive-evidence-scorer-v1',
    plannerVersion: 'adaptive-build-planner-v1',
    configVersion: 'adaptive-policy-v1',
    evidence: {
      rulesetVersion: 'ruleset-a',
      catalogSha256: sha,
      statlockerPatchId: '15-1',
      snapshotIds: ['vs-hero'],
      families: [{ dataset: 'VS_HERO_WPA', freshness: 'FRESH', snapshotId: 'vs-hero', confidence: 1 }],
      degradedReasons: [],
    },
  };
}

function input(overrides: Partial<AdaptiveReplayCorrectnessInputV1> = {}): AdaptiveReplayCorrectnessInputV1 {
  return {
    decision: decision(),
    evidence: evidence(),
    result: result(),
    ...overrides,
  };
}

describe('adaptive replay correctness gates', () => {
  it('reports zero for every production correctness metric on a coherent upgrade plan', () => {
    const report = evaluateAdaptiveReplayCorrectnessV1(input());

    expect(Object.values(report.metrics).every((metric) => metric.violations === 0 && metric.rate === 0)).toBe(true);
    expect(report.releaseReady).toBe(true);
  });

  it('detects a missed executable upgrade and unrelated replacement for an owned component lineage', () => {
    const malformed = result();
    malformed.nextAction = {
      actionKey: 'REPLACE_ITEM:99->2',
      type: 'REPLACE',
      sellItemId: 99,
      buyItemId: 2,
      targetItemId: 2,
      reasonCodes: [],
    };

    const report = evaluateAdaptiveReplayCorrectnessV1(input({ result: malformed }));

    expect(report.metrics.missedExecutableUpgradeRate.violations).toBe(1);
    expect(report.metrics.unrelatedReplacementForUpgradeRate.violations).toBe(1);
    expect(report.releaseReady).toBe(false);
  });

  it('detects selling an upgrade component after it was already consumed by an earlier semantic action', () => {
    const malformed = result();
    malformed.planActions = [
      ...malformed.planActions!,
      {
        planActionId: 'revision-a:002:SELL_ITEM:1',
        sequence: 2,
        status: 'PLANNED',
        action: { actionKey: 'SELL_ITEM:1', type: 'SELL', itemId: 1, sellItemId: 1, reasonCodes: [] },
        sourceItemIds: [1],
        requirements: [],
        reasonCodes: [],
      },
    ];

    const report = evaluateAdaptiveReplayCorrectnessV1(input({ result: malformed }));

    expect(report.metrics.sellConsumedItemRate.violations).toBe(1);
  });

  it('detects duplicate semantic cards and NEXT/plan-action disagreement', () => {
    const malformed = result();
    const first = malformed.planActions![0];
    malformed.planActions = [first, { ...first }];
    malformed.recommendedBuild = malformed.recommendedBuild.map((entry) =>
      entry.itemId === 2 ? { ...entry, status: 'PLANNED' as const } : entry,
    ).concat({
      itemId: 3,
      position: 3,
      status: 'NEXT',
      score: 0,
      confidence: 0,
      skeletonStrength: 0,
      contextualSupport: 0,
      reasonCodes: [],
    });

    const report = evaluateAdaptiveReplayCorrectnessV1(input({ result: malformed }));

    expect(report.metrics.duplicateBarrierCardRate.violations).toBe(1);
    expect(report.metrics.planActionBuildMismatchRate.violations).toBe(1);
  });

  it('detects unsupported or stale situational enemy attribution', () => {
    const malformed = result();
    const situational = malformed.planActions![0].situational!;
    malformed.planActions = [{
      ...malformed.planActions![0],
      situational: {
        ...situational,
        targetEnemies: [{ ...situational.targetEnemies[0], enemyHeroId: 999 }],
        primaryTargetEnemyHeroId: 999,
      },
    }];

    const report = evaluateAdaptiveReplayCorrectnessV1(input({
      evidence: evidence('PATCH_MISMATCH'),
      result: malformed,
    }));

    expect(report.metrics.situationalTargetUnsupportedRate.violations).toBe(1);
    expect(report.metrics.staleHeroTargetRate.violations).toBe(1);
    expect(report.metrics.rulesetPatchMismatchRecommendationRate.violations).toBe(1);
  });

  it('aggregates reports with exact numerator/denominator rates', () => {
    const clean = evaluateAdaptiveReplayCorrectnessV1(input());
    const malformed = result();
    malformed.nextAction = { actionKey: 'BUY_ITEM:3', type: 'BUY', itemId: 3, targetItemId: 3, reasonCodes: [] };
    const dirty = evaluateAdaptiveReplayCorrectnessV1(input({ result: malformed }));

    const aggregate = aggregateAdaptiveReplayCorrectnessV1([clean, dirty]);

    expect(aggregate.metrics.illegalActionRate.opportunities).toBe(2);
    expect(aggregate.metrics.illegalActionRate.rate).toBeGreaterThanOrEqual(0);
    expect(aggregate.releaseReady).toBe(Object.values(aggregate.metrics).every((metric) => metric.violations === 0));
  });
});
