import { runGolden, STRONG_WILDCARD_ROWS, DEFAULT_ENEMY_LIVE, CORE_IDS, BRANCH_A_ITEM, BRANCH_B_ITEM, WEAK_FLEX_ITEM } from './threat-weighted-wpa-golden-replay-v1.spec';

describe('debug3b', () => {
  it('runs H verbatim', async () => {
    const result: any = await runGolden({
      ownedItemIds: [...CORE_IDS, BRANCH_A_ITEM, BRANCH_B_ITEM, WEAK_FLEX_ITEM],
      spendableSouls: 4000,
      wpaRows: STRONG_WILDCARD_ROWS,
      enemyLiveStates: DEFAULT_ENEMY_LIVE,
    });
    const payload = {
      next: result.nextAction,
      situ: result.strategy?.situationalDecision,
      valid: result.transactionPlanValidation,
      session: result.planSession && {
        state: result.planSession.state,
        rc: result.planSession.reasonCodes,
        steps: result.planSession.steps.map((s: any) => [s.stepId, s.kind, s.state, s.goalId, s.action?.type, s.action?.sellItemId, s.action?.buyItemId]),
      },
    };
    console.log('H3 ' + JSON.stringify(payload));
  });
});
