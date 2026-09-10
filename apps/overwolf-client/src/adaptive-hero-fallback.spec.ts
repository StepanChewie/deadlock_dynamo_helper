import { buildAdaptiveRecommendationPresentation } from './adaptive-recommendation-presentation';

describe('adaptive situational hero label fallback', () => {
  it('uses generated display metadata when live hero name is absent while keeping numeric id authoritative', () => {
    const view = buildAdaptiveRecommendationPresentation({
      ready: true,
      blockers: [],
      decisionId: 'decision-a',
      stateRevision: 'revision-a',
      gameState: 'EVEN',
      nextAction: { actionKey: 'BUY_ITEM:3862866912', type: 'BUY', itemId: 3862866912, reasonCodes: [] },
      nextTargetItemId: 3862866912,
      planActions: [{
        planActionId: 'situational-1',
        sequence: 1,
        status: 'READY',
        action: { actionKey: 'BUY_ITEM:3862866912', type: 'BUY', itemId: 3862866912, reasonCodes: [] },
        targetItemId: 3862866912,
        sourceItemIds: [],
        requirements: [],
        reasonCodes: [],
        situational: {
          purpose: 'CATCH',
          targetEnemies: [{
            enemyHeroId: 3,
            role: 'PRIMARY',
            score: 1,
            confidence: 1,
            evidenceKinds: ['MATCHUP_STAT'],
          }],
          primaryTargetEnemyHeroId: 3,
          recommendationConfidence: 1,
          coreInterruption: { accepted: true },
          reasonCodes: ['MATCHUP_SUPPORTED'],
        },
      }],
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
        catalogSha256: 'a'.repeat(64),
        snapshotIds: [],
        families: [],
        degradedReasons: [],
      },
    } as any);

    expect(view.againstLabel).toBe('vs Vindicta');
    expect(view.plan.items[0].againstLabel).toBe('vs Vindicta');
  });
});
