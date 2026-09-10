import { ResolvedFullBuildPlanV2 } from '../src/statlocker-adaptive/full-build-plan-v2';
import { FullBuildHysteresisV2Service } from '../src/statlocker-adaptive/full-build-hysteresis-v2.service';

function plan(planRevision: string, buyItemId: number): ResolvedFullBuildPlanV2 {
  return {
    planRevision,
    matchId: 'match-1',
    heroId: 72,
    archetypeId: 'archetype-1',
    stateRevision: 'state-1',
    steps: [{
      sequence: 1,
      action: 'BUY',
      buyItemId,
      consumedItemIds: [],
      inventoryBefore: [],
      inventoryAfter: [buyItemId],
      reasonCodes: [],
    }],
    degradedReasons: [],
    validation: { valid: true, reasonCodes: [] },
  };
}

describe('FullBuildHysteresisV2Service', () => {
  const service = new FullBuildHysteresisV2Service();
  const previous = plan('previous', 1);
  const candidate = plan('candidate', 2);

  it('keeps the previous plan when the challenger improvement is below the plan switch margin', () => {
    const result = service.choose(previous, candidate, {
      improvement: 0.05,
      coreReplacement: false,
      recentPurchaseProtected: false,
    });

    expect(result.action).toBe('KEEP_PREVIOUS');
    expect(result.selected.planRevision).toBe('previous');
    expect(result.reasonCodes).toContain('PLAN_HYSTERESIS_MARGIN_NOT_CLEARED');
  });

  it('switches when a normal challenger clears the plan switch margin', () => {
    const result = service.choose(previous, candidate, {
      improvement: 0.20,
      coreReplacement: false,
      recentPurchaseProtected: false,
    });

    expect(result.action).toBe('SWITCH_TO_CANDIDATE');
    expect(result.selected.planRevision).toBe('candidate');
  });

  it('uses the higher CORE replacement threshold instead of making CORE an absolute lock', () => {
    const below = service.choose(previous, candidate, {
      improvement: 0.30,
      coreReplacement: true,
      recentPurchaseProtected: false,
    });
    const above = service.choose(previous, candidate, {
      improvement: 0.50,
      coreReplacement: true,
      recentPurchaseProtected: false,
    });

    expect(below.action).toBe('KEEP_PREVIOUS');
    expect(below.reasonCodes).toContain('CORE_REPLACEMENT_HIGHER_THRESHOLD');
    expect(above.action).toBe('SWITCH_TO_CANDIDATE');
    expect(above.reasonCodes).toContain('CORE_REPLACEMENT_HIGHER_THRESHOLD');
  });

  it('never churns a recent purchase solely because a new plan scores higher', () => {
    const result = service.choose(previous, candidate, {
      improvement: 10,
      coreReplacement: false,
      recentPurchaseProtected: true,
    });

    expect(result.action).toBe('KEEP_PREVIOUS');
    expect(result.reasonCodes).toContain('RECENT_PURCHASE_PROTECTED');
  });
});
