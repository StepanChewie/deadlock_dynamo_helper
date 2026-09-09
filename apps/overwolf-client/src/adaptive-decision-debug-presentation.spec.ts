import { buildAdaptiveDecisionDebugPresentation } from './adaptive-decision-debug-presentation';

function recommendation(): any {
  return {
    ready: true,
    blockers: [],
    decisionId: 'debug-d1',
    stateRevision: 'debug-r1',
    gameState: 'EVEN',
    nextAction: {
      actionKey: 'REPLACE:1437614329:3862866912',
      type: 'REPLACE',
      sellItemId: 1437614329,
      buyItemId: 3862866912,
      targetItemId: 3862866912,
      reasonCodes: ['WHOLE_BUILD_REPLACEMENT_ACCEPTED'],
    },
    recommendedBuild: [],
    changes: [],
    rankedImmediateCandidates: [],
    totalScore: 0.8,
    confidence: 0.9,
    scorerVersion: 'adaptive-evidence-scorer-v1',
    plannerVersion: 'adaptive-build-planner-v1',
    configVersion: 'statlocker-adaptive-v1.4.0',
    evidence: { rulesetVersion: 'r1', catalogSha256: 'a'.repeat(64), snapshotIds: [], families: [], degradedReasons: [] },
    decisionTrace: {
      version: 'adaptive-decision-trace-v1',
      decisionId: 'debug-d1',
      stateRevision: 'debug-r1',
      stages: ['SKELETON_BASELINE', 'MATCHUP_DISCOVERY', 'WHOLE_BUILD_VALIDATION', 'SELL_SOURCE_EVALUATION', 'FINAL_SELECTION'],
      baseline: {
        strategyId: 's1',
        inventoryItemIds: [1437614329],
        recommendedBuild: [{ itemId: 1437614329, position: 1, status: 'OWNED', score: 0, confidence: 1, skeletonStrength: 0.6, contextualSupport: 0.5, reasonCodes: ['OWNED_ITEM'] }],
      },
      branchChoices: { branch: 'anti-spirit' },
      candidates: [
        {
          action: { actionKey: 'REPLACE:1437614329:3862866912', type: 'REPLACE', sellItemId: 1437614329, buyItemId: 3862866912, targetItemId: 3862866912, reasonCodes: ['WHOLE_BUILD_REPLACEMENT_ACCEPTED'] },
          source: 'DISCOVERED',
          selected: true,
          score: 0.83,
          confidence: 0.87,
          scoreComponents: [{ key: 'draftMatchupFit', raw: 0.4, normalized: 0.4, confidence: 0.8, weight: 0.9, weighted: 0.36 }],
          rejectionReasonCodes: [],
          matchup: { score: 0.36, confidence: 0.8, reasonCodes: ['MATCHUP_SUPPORTED'] },
          requiredThreshold: 0.2,
        },
        {
          action: { actionKey: 'BUY:968099481', type: 'BUY', buyItemId: 968099481, targetItemId: 968099481, reasonCodes: [] },
          source: 'SKELETON',
          selected: false,
          score: 0.61,
          confidence: 0.7,
          scoreComponents: [],
          rejectionReasonCodes: ['NOT_SELECTED_HIGHER_UTILITY'],
          matchup: { score: 0.05, confidence: 0.6, reasonCodes: [] },
        },
      ],
      replacements: [{
        sellItemId: 1437614329,
        buyItemId: 3862866912,
        selected: true,
        accepted: true,
        inventoryCount: 12,
        maxItemCount: 12,
        utilityBefore: 3.1,
        utilityAfter: 3.52,
        rawImprovement: 0.42,
        matchupGain: 0.3,
        skeletonDelta: -0.04,
        synergyDelta: 0.08,
        timingDelta: 0.02,
        economicLoss: 0.03,
        transactionPenalty: 0.01,
        churnPenalty: 0.02,
        netImprovement: 0.36,
        requiredThreshold: 0.2,
        utilityDeltas: {
          skeletonAdherence: -0.04,
          coreIntegrity: 0,
          branchCoherence: 0.02,
          threatMatchup: 0.3,
          synergy: 0.08,
          timing: 0.02,
          slotEfficiency: 0,
          economyOpportunityCost: -0.03,
          investmentContinuity: 0,
        },
        reasonCodes: ['WHOLE_BUILD_REPLACEMENT_ACCEPTED'],
      }],
      finalSelection: {
        action: { actionKey: 'REPLACE:1437614329:3862866912', type: 'REPLACE', sellItemId: 1437614329, buyItemId: 3862866912, targetItemId: 3862866912, reasonCodes: ['WHOLE_BUILD_REPLACEMENT_ACCEPTED'] },
        legalityRecheckChanged: false,
        reasonCodes: ['WHOLE_BUILD_REPLACEMENT_ACCEPTED'],
      },
      policy: {
        policyVersion: 'statlocker-adaptive-v1.4.0',
        heldItemCapacity: 12,
        threatWeights: { souls: 0.35, heroDamage: 0.3, killsAssists: 0.2, level: 0.1, deaths: -0.05 },
        threatClamp: { min: 0.75, max: 1.5 },
        shrinkK: { baseWpa: 200, gameState: 250, exactEnemy: 500, chain: 200, proProfile: 50 },
        thresholds: { planSwitch: 0.08, sellBuy: 0.2, softCoreReplace: 0.25, wildcardReplace: 0.3, matchupConfidence: 0.35 },
        recentPurchaseProtectionMs: 120000,
        soldItemRebuyPenaltyMs: 180000,
      },
    },
  };
}

describe('adaptive decision debug presentation', () => {
  it('builds the required item-centric sections and preserves decision-critical numbers', () => {
    const view = buildAdaptiveDecisionDebugPresentation(recommendation());

    expect(view.visible).toBe(true);
    expect(view.sections.map((section) => section.title)).toEqual([
      'Было',
      'Рассматривали',
      'Выбрали',
      'Откинули',
    ]);
    expect(view.sections[0].rows[0].headline).toBe('Melee Lifesteal');
    expect(view.sections[1].rows.map((row) => row.headline)).toEqual(expect.arrayContaining([
      'Sell Melee Lifesteal - Buy Restorative Shot',
      'Buy Extra Spirit',
    ]));
    expect(view.sections[2].rows[0]).toMatchObject({
      headline: 'Sell Melee Lifesteal - Buy Restorative Shot',
      selected: true,
    });
    expect(view.sections[3].rows[0].reason).toBe('NOT_SELECTED_HIGHER_UTILITY');

    expect(view.replacements[0]).toMatchObject({
      inventory: '12/12',
      utilityBefore: 3.1,
      utilityAfter: 3.52,
      rawImprovement: 0.42,
      matchupGain: 0.3,
      economicLoss: 0.03,
      netImprovement: 0.36,
      requiredThreshold: 0.2,
      verdict: 'ACCEPT',
    });
    expect(view.policy).toMatchObject({
      version: 'statlocker-adaptive-v1.4.0',
      heldItemCapacity: 12,
      planSwitchThreshold: 0.08,
      sellBuyThreshold: 0.2,
      softCoreReplaceThreshold: 0.25,
      wildcardReplaceThreshold: 0.3,
      matchupConfidenceThreshold: 0.35,
      recentPurchaseProtectionMs: 120000,
      soldItemRebuyPenaltyMs: 180000,
    });
  });

  it('stays hidden for legacy payloads without a decision trace', () => {
    const value = recommendation();
    delete value.decisionTrace;
    const view = buildAdaptiveDecisionDebugPresentation(value);

    expect(view.visible).toBe(false);
    expect(view.sections).toEqual([]);
  });
});
