import { buildAdaptiveRecommendationPresentation } from './adaptive-recommendation-presentation';

function recommendation(overrides: Record<string, unknown> = {}): any {
  return {
    ready: true,
    blockers: [],
    decisionId: 'presentation-roadmap',
    stateRevision: 'presentation-roadmap-r1',
    gameState: 'EVEN',
    nextAction: {
      actionKey: 'BUY:3862866912',
      type: 'BUY',
      buyItemId: 3862866912,
      targetItemId: 3862866912,
      reasonCodes: [],
    },
    nextTargetItemId: 3862866912,
    recommendedBuild: [{ itemId: 3862866912, position: 1, status: 'NEXT', score: 0.8, confidence: 0.8, skeletonStrength: 0.7, contextualSupport: 0.7, reasonCodes: [] }],
    changes: [],
    rankedImmediateCandidates: [],
    totalScore: 0.8,
    confidence: 0.8,
    scorerVersion: 'adaptive-evidence-scorer-v1',
    plannerVersion: 'adaptive-build-planner-v1',
    configVersion: 'statlocker-adaptive-v1.4.0',
    evidence: { rulesetVersion: 'r1', catalogSha256: 'a'.repeat(64), snapshotIds: [], families: [], degradedReasons: [] },
    ...overrides,
  };
}

function situational(targetEnemies: any[]): any {
  return {
    planActionId: 'situational-action',
    sequence: 1,
    status: 'READY',
    action: { actionKey: 'BUY:3862866912', type: 'BUY', buyItemId: 3862866912, targetItemId: 3862866912, reasonCodes: [] },
    targetItemId: 3862866912,
    sourceItemIds: [],
    requirements: [],
    reasonCodes: [],
    situational: {
      purpose: 'CATCH',
      targetEnemies,
      recommendationConfidence: 0.8,
      coreInterruption: { accepted: true },
      reasonCodes: ['MATCHUP_SUPPORTED'],
    },
  };
}

describe('roadmap Overwolf action presentation', () => {
  it('renders normal buy as Buy X', () => {
    const view = buildAdaptiveRecommendationPresentation(recommendation());
    expect(view.headline).toBe('Buy Restorative Shot');
  });

  it('renders replacement as an explicit sell and buy instruction', () => {
    const view = buildAdaptiveRecommendationPresentation(recommendation({
      nextAction: {
        actionKey: 'REPLACE:1437614329:3862866912',
        type: 'REPLACE',
        sellItemId: 1437614329,
        buyItemId: 3862866912,
        targetItemId: 3862866912,
        reasonCodes: [],
      },
    }));
    expect(view.headline).toBe('Sell Melee Lifesteal - Buy Restorative Shot');
  });

  it('orders two material targets stably with the primary threat first', () => {
    const view = buildAdaptiveRecommendationPresentation(recommendation({
      planActions: [situational([
        { enemyHeroId: 2, enemyHeroName: 'Grey Talon', role: 'SECONDARY', score: 0.8, confidence: 0.8, evidenceKinds: ['MATCHUP_STAT'] },
        { enemyHeroId: 1, enemyHeroName: 'Vindicta', role: 'PRIMARY', score: 0.6, confidence: 0.9, evidenceKinds: ['MATCHUP_STAT'] },
        { enemyHeroId: 3, enemyHeroName: 'Negligible', role: 'SECONDARY', score: 0, confidence: 0.9, evidenceKinds: ['MATCHUP_STAT'] },
      ])],
    }));
    expect(view.againstLabel).toBe('vs Vindicta, Grey Talon');
  });

  it('omits the vs label when there is no causal matchup context', () => {
    const view = buildAdaptiveRecommendationPresentation(recommendation({ planActions: [] }));
    expect(view.againstLabel).toBeUndefined();
  });

  it('deduplicates repeated target names', () => {
    const view = buildAdaptiveRecommendationPresentation(recommendation({
      planActions: [situational([
        { enemyHeroId: 1, enemyHeroName: 'Vindicta', role: 'PRIMARY', score: 0.7, confidence: 0.9, evidenceKinds: ['MATCHUP_STAT'] },
        { enemyHeroId: 4, enemyHeroName: 'Vindicta', role: 'SECONDARY', score: 0.6, confidence: 0.8, evidenceKinds: ['LIVE_THREAT'] },
      ])],
    }));
    expect(view.againstLabel).toBe('vs Vindicta');
  });

  it('keeps replacement transaction type explicit when item metadata is unknown', () => {
    const view = buildAdaptiveRecommendationPresentation(recommendation({
      nextAction: {
        actionKey: 'REPLACE:999999998:999999999',
        type: 'REPLACE',
        sellItemId: 999999998,
        buyItemId: 999999999,
        targetItemId: 999999999,
        reasonCodes: [],
      },
      nextTargetItemId: 999999999,
    }));
    expect(view.headline).toBe('Sell item #999999998 - Buy item #999999999');
    expect(view.actionLabel).toBe('Replace');
  });
});
