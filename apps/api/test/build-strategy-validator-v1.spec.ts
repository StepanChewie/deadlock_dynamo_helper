import { createRecommendationItemGraph } from '@deadlock-live-probe/build-domain';
import { BuildStrategyValidatorV1Service } from '../src/statlocker-adaptive/build-strategy-validator-v1.service';
import { BuildStrategySpecV1 } from '../src/statlocker-adaptive/build-strategy-v1';

const graph = createRecommendationItemGraph([
  {
    itemId: 1,
    name: 'Component',
    slotType: 'weapon',
    active: false,
    availableRulesetIds: ['r1'],
    directPurchaseCost: 800,
    upgradeRecipes: [],
  },
  {
    itemId: 2,
    name: 'Upgrade',
    slotType: 'weapon',
    active: false,
    availableRulesetIds: ['r1'],
    upgradeRecipes: [{ recipeId: 'u2', consumedItemIds: [1], soulsCost: 800 }],
  },
]);

function strategy(): BuildStrategySpecV1 {
  return {
    schemaVersion: 1,
    strategyId: 's1',
    heroId: 1,
    rulesetId: 'r1',
    sourcePatchId: 'p1',
    support: 0.5,
    stability: 0.8,
    representativeTraceId: 't1',
    goals: [
      {
        goalId: 'g1',
        type: 'CORE',
        phase: 'EARLY',
        targetItemIds: [1],
        minSelect: 1,
        maxSelect: 1,
        prerequisiteGoalIds: [],
        hard: true,
        lifecycleByItemId: { 1: 'UPGRADE_COMPONENT' },
        rationaleCodes: ['CORE'],
      },
      {
        goalId: 'g2',
        type: 'UPGRADE',
        phase: 'MID',
        targetItemIds: [2],
        minSelect: 1,
        maxSelect: 1,
        prerequisiteGoalIds: ['g1'],
        hard: true,
        lifecycleByItemId: { 2: 'PERMANENT_CORE' },
        rationaleCodes: ['UPGRADE'],
      },
    ],
    branchGroups: [],
    situationalWindows: [],
    investmentPolicy: { objectives: [], preferredWeights: { weapon: 1, vitality: 0, spirit: 0 } },
    slotPolicy: { reservedSituationalSlots: 0, maxTemporarySlots: 1 },
    terminalPolicy: { requiredGoalIds: ['g1', 'g2'], allowWaiveSoftGoals: true },
  };
}

describe('build strategy validator v1', () => {
  const validator = new BuildStrategyValidatorV1Service();

  it('accepts a coherent acyclic legacy strategy whose items exist in the ruleset', () => {
    expect(validator.validate(strategy(), graph)).toEqual({ valid: true, errors: [] });
  });

  it('accepts coherent explicit rigidity semantics', () => {
    const value = strategy();
    const explicit: BuildStrategySpecV1 = {
      ...value,
      goals: value.goals.map((goal) => ({ ...goal, rigidity: 'HARD_CORE' as const })),
    };

    expect(validator.validate(explicit, graph)).toEqual({ valid: true, errors: [] });
  });

  it('rejects contradictory explicit rigidity semantics', () => {
    const value = strategy();
    const invalid = {
      ...value,
      goals: value.goals.map((goal) => goal.goalId === 'g1'
        ? { ...goal, rigidity: 'SOFT_CORE' as const }
        : goal),
    } satisfies BuildStrategySpecV1;

    expect(validator.validate(invalid, graph).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'GOAL_RIGIDITY_INVALID', goalId: 'g1' }),
    ]));
  });

  it('rejects unknown runtime rigidity values instead of silently accepting them', () => {
    const value = strategy();
    const invalid = {
      ...value,
      goals: value.goals.map((goal) => goal.goalId === 'g1'
        ? { ...goal, rigidity: 'IMMOVABLE' }
        : goal),
    } as unknown as BuildStrategySpecV1;

    expect(validator.validate(invalid, graph).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'GOAL_RIGIDITY_INVALID', goalId: 'g1' }),
    ]));
  });

  it('rejects prerequisite cycles', () => {
    const value = strategy();
    const cyclic: BuildStrategySpecV1 = {
      ...value,
      goals: value.goals.map((goal) => goal.goalId === 'g1'
        ? { ...goal, prerequisiteGoalIds: ['g2'] }
        : goal),
    };

    expect(validator.validate(cyclic, graph).errors.map((error) => error.code))
      .toContain('PREREQUISITE_CYCLE');
  });

  it('rejects unknown target items instead of silently dropping them', () => {
    const value = strategy();
    const invalid: BuildStrategySpecV1 = {
      ...value,
      goals: value.goals.map((goal) => goal.goalId === 'g2'
        ? { ...goal, targetItemIds: [999] }
        : goal),
    };

    expect(validator.validate(invalid, graph).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'UNKNOWN_ITEM', goalId: 'g2', itemId: 999 }),
    ]));
  });

  it('rejects branch groups that reference missing goals', () => {
    const value = strategy();
    const invalid: BuildStrategySpecV1 = {
      ...value,
      branchGroups: [{ branchGroupId: 'b1', optionGoalIds: ['g1', 'missing'], minSelect: 1, maxSelect: 1 }],
    };

    expect(validator.validate(invalid, graph).errors.map((error) => error.code))
      .toContain('BRANCH_UNKNOWN_GOAL');
  });
});
