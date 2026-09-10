import { BuildSituationalResolverV1Service } from '../src/statlocker-adaptive/build-situational-resolver-v1.service';
import { BuildContractV1, BuildStrategySpecV1 } from '../src/statlocker-adaptive/build-strategy-v1';

const strategy: BuildStrategySpecV1 = {
  schemaVersion: 1, strategyId: 's', heroId: 1, rulesetId: 'r1', sourcePatchId: 'p', support: 1, stability: 1,
  representativeTraceId: 't', goals: [], branchGroups: [],
  situationalWindows: [{
    windowId: 'defense-window', afterGoalIds: [], beforeGoalIds: [], maxSlots: 1, maxSouls: 3200,
    maxCoreDelaySouls: 1600, allowedPurposes: ['ANTI_CC', 'ANTI_BURST'],
  }],
  investmentPolicy: { objectives: [], preferredWeights: { weapon: 1, vitality: 0, spirit: 0 } },
  slotPolicy: { reservedSituationalSlots: 1, maxTemporarySlots: 0 },
  terminalPolicy: { requiredGoalIds: [], allowWaiveSoftGoals: true },
};

const contract: BuildContractV1 = {
  strategyId: 's', status: 'IN_PROGRESS', commitment: 'COMMITTED', goalStates: {}, selectedBranches: {}, committedBranches: {},
  temporaryItemIds: [], reservedSituationalWindowIds: ['defense-window'], remainingHardGoalIds: [], completionReasonCodes: [],
};

describe('build situational resolver v1', () => {
  const service = new BuildSituationalResolverV1Service();

  it('does not fill a situational reservation without a contextual trigger', () => {
    expect(service.resolve({
      strategy,
      contract,
      candidates: [],
      continueCoreScore: 0.6,
      minOverrideImprovement: 0.10,
    })).toBeUndefined();
  });

  it('selects a supported counter only when it beats continue-core by the window threshold', () => {
    const result = service.resolve({
      strategy, contract, continueCoreScore: 0.55, minOverrideImprovement: 0.10,
      candidates: [{
        targetItemId: 100, purpose: 'ANTI_CC', enemyHeroIds: [7], enemyItemIds: [], contextualScore: 0.78,
        statisticalSupport: 0.64, confidence: 0.8, effectiveCostSouls: 1600, slotImpact: 1,
        investmentImpact: -0.05, coreInterruptionSouls: 800, reasonCodes: ['ENEMY_CC_THREAT'],
      }],
    });

    expect(result).toMatchObject({ targetItemId: 100, purpose: 'ANTI_CC', enemyHeroIds: [7] });
    expect(result?.reasonCodes).toContain('SITUATIONAL_OVERRIDE_BEATS_CONTINUE_CORE');
  });

  it('continues core when the counter evidence is too weak', () => {
    const result = service.resolve({
      strategy, contract, continueCoreScore: 0.70, minOverrideImprovement: 0.10,
      candidates: [{
        targetItemId: 100, purpose: 'ANTI_CC', enemyHeroIds: [7], enemyItemIds: [], contextualScore: 0.74,
        statisticalSupport: 0.2, confidence: 0.3, effectiveCostSouls: 1600, slotImpact: 1,
        investmentImpact: 0, coreInterruptionSouls: 800, reasonCodes: ['WEAK_MATCHUP_SIGNAL'],
      }],
    });

    expect(result).toBeUndefined();
  });

  it('honors a stricter candidate-specific improvement threshold', () => {
    const result = service.resolve({
      strategy,
      contract,
      continueCoreScore: 0.60,
      minOverrideImprovement: 0.08,
      candidates: [{
        targetItemId: 101,
        purpose: 'ANTI_CC',
        enemyHeroIds: [7],
        enemyLiveStates: [],
        enemyItemIds: [],
        contextualScore: 0.89,
        statisticalSupport: 0.8,
        confidence: 0.8,
        effectiveCostSouls: 1600,
        slotImpact: 1,
        investmentImpact: 0,
        coreInterruptionSouls: 800,
        requiredImprovement: 0.30,
        reasonCodes: ['MATCHUP_DISCOVERY_OUTSIDE_SKELETON'],
      } as any],
    });

    expect(result).toBeUndefined();
  });

  it('accepts a candidate once it clears its stricter improvement threshold', () => {
    const result = service.resolve({
      strategy,
      contract,
      continueCoreScore: 0.60,
      minOverrideImprovement: 0.08,
      candidates: [{
        targetItemId: 101,
        purpose: 'ANTI_CC',
        enemyHeroIds: [7],
        enemyLiveStates: [],
        enemyItemIds: [],
        contextualScore: 0.91,
        statisticalSupport: 0.8,
        confidence: 0.8,
        effectiveCostSouls: 1600,
        slotImpact: 1,
        investmentImpact: 0,
        coreInterruptionSouls: 800,
        requiredImprovement: 0.30,
        reasonCodes: ['MATCHUP_DISCOVERY_OUTSIDE_SKELETON'],
      } as any],
    });

    expect(result).toMatchObject({ targetItemId: 101 });
  });
});
