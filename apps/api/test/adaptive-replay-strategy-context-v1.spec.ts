import { AdaptiveReplayInputV1, AdaptiveReplayV1Service } from '../src/statlocker-adaptive/adaptive-replay-v1.service';
import { ADAPTIVE_POLICY_V1_CONFIG } from '../src/statlocker-adaptive/statlocker-adaptive.config';

function input(): AdaptiveReplayInputV1 {
  return {
    decision: {
      state: {
        decisionId: 'd',
        matchId: 'm',
        playerSlot: 0,
        gameTimeSec: 500,
        rulesetId: 'r1',
        heroId: 1,
        ownedItemIds: [],
        spendableSouls: { value: 4000, evidence: 'OBSERVED', source: 'test' },
        shopOpportunity: { value: 'AVAILABLE', evidence: 'OBSERVED', source: 'test' },
      },
      itemDefinitions: [{
        itemId: 1,
        name: 'Core',
        slotType: 'weapon',
        active: false,
        availableRulesetIds: ['r1'],
        directPurchaseCost: 800,
        upgradeRecipes: [],
        sellTransition: { soulsRefund: 400, returnedItemIds: [] },
      }],
      catalogVersionId: 'catalog',
      catalogSha256: 'a'.repeat(64),
      rulesetId: 'r1',
      localSteamId: 'player',
      allyHeroIds: [2, 3],
      enemyHeroIds: [4, 5],
      enemyLiveStates: [],
      allyItemIds: [101, 102],
      enemyItemIds: [201, 202],
      slots: {
        baseSlots: 12,
        baseSlotsByType: { weapon: 4, vitality: 4, spirit: 4 },
        maxFlexSlots: 4,
        maxActiveItems: 4,
        unlockedFlexSlots: 2,
        usedSlots: 0,
        usedSlotsByType: { weapon: 0, vitality: 0, spirit: 0 },
        overflowByType: { weapon: 0, vitality: 0, spirit: 0 },
        usedFlexSlots: 0,
        provedFlexLowerBound: 0,
        freeBaseSlots: 12,
        freeBaseSlotsByType: { weapon: 4, vitality: 4, spirit: 4 },
        freeFlexSlots: 2,
        totalCapacity: 14,
        activeItemsUsed: 0,
        freeActiveItemSlots: 4,
        evidence: 'OBSERVED',
      },
      economyRules: {
        rulesetId: 'r1',
        catalogSha256: 'a'.repeat(64),
        baseSlots: 12,
        baseSlotsByType: { weapon: 4, vitality: 4, spirit: 4 },
        maxFlexSlots: 4,
        maxActiveItems: 4,
        investmentBreakpoints: {
          weapon: [1600, 3200],
          vitality: [1600, 3200],
          spirit: [1600, 3200],
        },
      },
      economyRulesEvidence: 'RECONSTRUCTED',
      stateRevision: 'revision-context',
    } as any,
    evidence: {
      heroId: 1,
      rulesetVersion: 'r1',
      catalogSha256: 'a'.repeat(64),
      statlockerPatchId: 'p',
      usable: true,
      snapshotIds: [],
      degradedReasons: [],
      families: [],
      byDataset: {} as any,
    },
    previousResult: {
      recommendedBuild: [],
      totalScore: 1,
      nextAction: { actionKey: 'HOLD', type: 'HOLD', reasonCodes: [] },
      confidence: 0.8,
      strategy: {
        strategyId: 's1',
        commitment: 'COMMITTED',
        selectedAtGameTimeSec: 120,
        posterior: 0.9,
        reasonCodes: ['STICKY'],
        selectedBranches: { branch: 'a' },
        committedBranches: { branch: 'a' },
        buildStatus: 'IN_PROGRESS',
        progress: { satisfiedHardGoals: 1, totalHardGoals: 2 },
        remainingGoalIds: ['g2'],
        slotPlan: {
          currentUsedSlots: 0,
          currentFlexUsed: 0,
          reservedSituationalSlots: 0,
          feasible: true,
          reasonCodes: [],
        },
        investmentObjectives: [],
      },
    } as any,
    recentPurchasedItemIds: [],
    recentSoldItemIds: [],
    configVersion: ADAPTIVE_POLICY_V1_CONFIG.version,
    scorerVersion: 'adaptive-evidence-scorer-v1',
    plannerVersion: 'adaptive-build-planner-v1',
    snapshotIds: [],
  };
}

describe('adaptive replay strategy context v1', () => {
  it('reconstructs ally/enemy context, exact slot rules and previous strategy state', () => {
    const planner = {
      version: 'adaptive-build-planner-v1',
      plan: jest.fn(() => ({
        gameState: 'EVEN',
        nextAction: { actionKey: 'HOLD', type: 'HOLD', reasonCodes: [] },
        recommendedBuild: [],
        changes: [],
        rankedImmediateCandidates: [],
        totalScore: 0,
        confidence: 0,
      })),
    } as any;
    const replay = new AdaptiveReplayV1Service({} as any, planner);
    const replayInput = input();

    replay.run(replayInput);

    const plannerInput = planner.plan.mock.calls[0][0];
    expect(plannerInput.decision).toMatchObject({
      allyHeroIds: [2, 3],
      enemyHeroIds: [4, 5],
      enemyLiveStates: [],
      allyItemIds: [101, 102],
      enemyItemIds: [201, 202],
      economyRulesEvidence: 'RECONSTRUCTED',
    });
    expect(plannerInput.decision.economyRules).toMatchObject({
      baseSlotsByType: { weapon: 4, vitality: 4, spirit: 4 },
      maxFlexSlots: 4,
      maxActiveItems: 4,
    });
    expect(plannerInput.previousResult.strategy).toMatchObject({
      strategyId: 's1',
      commitment: 'COMMITTED',
      committedBranches: { branch: 'a' },
    });
  });
});
