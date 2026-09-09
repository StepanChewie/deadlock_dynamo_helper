import { createRecommendationItemGraph } from '@deadlock-live-probe/build-domain';
import { BuildStrategyCompilerV1Service } from '../src/statlocker-adaptive/build-strategy-compiler-v1.service';
import {
  compileStructuredConsensusStrategyV1,
  filterRecommendationCandidatesForActiveGoalsV1,
} from '../src/statlocker-adaptive/build-strategy-v1';
import { createPlannerTrajectoryV2 } from '../src/statlocker-adaptive/planner-trajectory-v2';

const graph = createRecommendationItemGraph([1, 2, 3, 4].map((itemId) => ({
  itemId,
  name: `Item ${itemId}`,
  slotType: 'weapon' as const,
  active: false,
  availableRulesetIds: ['r1'],
  directPurchaseCost: 800,
  upgradeRecipes: [],
  sellTransition: { soulsRefund: 400, returnedItemIds: [] },
  maxCopies: 1,
})));

function trace(traceId: string, itemId: number) {
  return createPlannerTrajectoryV2({
    matchId: traceId,
    playerKey: 'player',
    heroId: 1,
    patchId: 'patch-1',
    rulesetId: 'r1',
    catalogSha256: 'a'.repeat(64),
    rankCohort: 'top',
    allyHeroIds: [],
    enemyHeroIds: [],
    transactions: [{
      actionType: 'BUY',
      gameTimeSec: 300,
      targetItemId: itemId,
      consumedItemIds: [],
      inventoryBefore: [],
      inventoryAfter: [itemId],
      slotUsedBefore: 0,
      slotUsedAfter: 1,
      investmentBefore: { weapon: 0, vitality: 0, spirit: 0 },
      investmentAfter: { weapon: 800, vitality: 0, spirit: 0 },
    }],
  }, graph);
}

function compile(itemIds: readonly number[]) {
  const trajectories = itemIds.map((itemId, index) => trace(`trace-${index}`, itemId));
  return new BuildStrategyCompilerV1Service().compile({
    archetype: {
      archetypeId: 'archetype-1',
      heroId: 1,
      patchId: 'patch-1',
      rulesetId: 'r1',
      memberTraceIds: trajectories.map((entry) => entry.traceId),
      representativeTraceId: trajectories[0].traceId,
      support: 1,
      stability: 1,
    } as any,
    trajectories,
    itemGraph: graph,
  });
}

function goal(options: {
  goalId: string;
  itemId: number;
  rigidity: 'HARD_CORE' | 'SOFT_CORE' | 'FLEX';
  type?: 'CORE' | 'SITUATIONAL_RESERVATION';
}) {
  return {
    goalId: options.goalId,
    type: options.type ?? 'CORE',
    phase: 'EARLY',
    targetItemIds: [options.itemId],
    minSelect: options.rigidity === 'HARD_CORE' ? 1 : 0,
    maxSelect: 1,
    prerequisiteGoalIds: [],
    hard: options.rigidity === 'HARD_CORE',
    rigidity: options.rigidity,
    lifecycleByItemId: { [options.itemId]: options.rigidity === 'FLEX' ? 'SITUATIONAL' : 'PERMANENT_CORE' },
    rationaleCodes: [],
  } as any;
}

describe('Build goal rigidity V1', () => {
  it('emits HARD_CORE, SOFT_CORE, and FLEX from mined strategy evidence', () => {
    const hard = compile([1, 1, 1, 2]);
    const soft = compile([1, 1, 2, 3]);
    const branch = compile([1, 1, 2, 2]);

    expect((hard.goals.find((entry) => entry.targetItemIds.includes(1)) as any)?.rigidity).toBe('HARD_CORE');
    expect((soft.goals.find((entry) => entry.targetItemIds.includes(1)) as any)?.rigidity).toBe('SOFT_CORE');
    expect(branch.goals).toHaveLength(2);
    expect(branch.goals.map((entry) => (entry as any).rigidity)).toEqual(['FLEX', 'FLEX']);
  });

  it('maps consensus required core to HARD_CORE while choice and situational goals stay FLEX', () => {
    const strategy = compileStructuredConsensusStrategyV1({
      skeleton: {
        heroId: 1,
        profileCount: 10,
        groups: [
          {
            groupId: 'required:1',
            phase: 'EARLY',
            type: 'REQUIRED',
            minSelect: 1,
            maxSelect: 1,
            candidates: [{ itemId: 1 }],
          },
          {
            groupId: 'choice:2,3',
            phase: 'MID',
            type: 'CHOICE',
            minSelect: 1,
            maxSelect: 1,
            candidates: [{ itemId: 2 }, { itemId: 3 }],
          },
        ],
      } as any,
      itemGraph: graph,
      rulesetId: 'r1',
      situationalWindows: [{ windowId: 'utility', targetItemIds: [4] }],
    });

    expect((strategy.goals.find((entry) => entry.goalId === 'required:1') as any)?.rigidity).toBe('HARD_CORE');
    expect((strategy.goals.find((entry) => entry.goalId === 'choice:2,3') as any)?.rigidity).toBe('FLEX');
    expect((strategy.goals.find((entry) => entry.goalId === 'situational:utility') as any)?.rigidity).toBe('FLEX');
  });

  it('rejects hard-core sell and replacement candidates before scoring', () => {
    const activeGoals = [
      goal({ goalId: 'hard-core:1', itemId: 1, rigidity: 'HARD_CORE' }),
      goal({ goalId: 'flex:4', itemId: 4, rigidity: 'FLEX', type: 'SITUATIONAL_RESERVATION' }),
    ];
    const candidates = [
      { action: { type: 'REPLACE_ITEM', sellItemId: 1, buyItemId: 4 } },
      { action: { type: 'REPLACE_ITEM', sellItemId: 2, buyItemId: 4 } },
      { action: { type: 'SELL_ITEM', itemId: 1 } },
      { action: { type: 'SELL_ITEM', itemId: 2 } },
    ] as any;

    const filtered = filterRecommendationCandidatesForActiveGoalsV1(
      candidates,
      activeGoals,
      graph,
      { capacityExitItemIds: new Set([1, 2]) },
    );

    expect(filtered.map((candidate) => candidate.action)).toEqual([
      { type: 'REPLACE_ITEM', sellItemId: 2, buyItemId: 4 },
      { type: 'SELL_ITEM', itemId: 2 },
    ]);
  });

  it('keeps satisfied hard core protected even when only a flex goal remains active', () => {
    const hardCoreGoal = goal({ goalId: 'hard-core:1', itemId: 1, rigidity: 'HARD_CORE' });
    const activeFlexGoal = goal({
      goalId: 'flex:4',
      itemId: 4,
      rigidity: 'FLEX',
      type: 'SITUATIONAL_RESERVATION',
    });
    const candidates = [
      { action: { type: 'REPLACE_ITEM', sellItemId: 1, buyItemId: 4 } },
      { action: { type: 'REPLACE_ITEM', sellItemId: 2, buyItemId: 4 } },
      { action: { type: 'SELL_ITEM', itemId: 1 } },
      { action: { type: 'SELL_ITEM', itemId: 2 } },
    ] as any;

    const filtered = (filterRecommendationCandidatesForActiveGoalsV1 as any)(
      candidates,
      [activeFlexGoal],
      graph,
      {
        capacityExitItemIds: new Set([1, 2]),
        protectedGoals: [hardCoreGoal],
      },
    );

    expect(filtered.map((candidate: any) => candidate.action)).toEqual([
      { type: 'REPLACE_ITEM', sellItemId: 2, buyItemId: 4 },
      { type: 'SELL_ITEM', itemId: 2 },
    ]);
  });
});
