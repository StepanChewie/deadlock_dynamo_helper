import { buildAdaptiveRecommendationPresentation } from './adaptive-recommendation-presentation';

function recommendation(overrides: Record<string, unknown> = {}): any {
  return {
    ready: true,
    blockers: [],
    decisionId: 'decision-a',
    stateRevision: 'revision-a',
    gameState: 'EVEN',
    nextAction: {
      actionKey: 'BUY:3862866912',
      type: 'BUY',
      buyItemId: 3862866912,
      reasonCodes: ['CORE_TARGET_PENDING'],
    },
    nextTargetItemId: 3862866912,
    recommendedBuild: [],
    changes: [],
    rankedImmediateCandidates: [],
    totalScore: 0.72,
    confidence: 0.82,
    scorerVersion: 'adaptive-evidence-scorer-v1',
    plannerVersion: 'adaptive-build-planner-v1',
    configVersion: 'statlocker-adaptive-v1.4.0',
    evidence: {
      rulesetVersion: 'ruleset-a',
      catalogSha256: 'a'.repeat(64),
      statlockerPatchId: '15-1',
      snapshotIds: ['one', 'two'],
      families: [
        { dataset: 'hero_builds', freshness: 'FRESH', confidence: 0.9 },
        { dataset: 'matchups', freshness: 'FRESH', confidence: 0.8 },
      ],
      degradedReasons: [],
    },
    ...overrides,
  };
}

describe('adaptive recommendation presentation', () => {
  it('turns a known Statlocker action into a readable item card', () => {
    const view = buildAdaptiveRecommendationPresentation(recommendation());

    expect(view.sourceLabel).toBe('Statlocker Adaptive');
    expect(view.stateLabel).toBe('Even game');
    expect(view.headline).toBe('Buy Restorative Shot');
    expect(view.primaryItem).toMatchObject({
      id: 3862866912,
      name: 'Restorative Shot',
      slot: 'weapon',
      costLabel: '800 souls',
      tierLabel: 'Tier 1',
      known: true,
    });
    expect(view.confidence).toEqual({ label: '82% confidence', value: 82 });
    expect(view.reasons).toContain('Keep saving for the next core item');
    expect(view.evidenceLabel).toBe('2 fresh Statlocker signals');
  });

  it('renders the full recommended build when planActions are absent', () => {
    const itemIds = [3862866912, 968099481, 1342610602, 1437614329, 7409189, 26002154, 84321454, 98582110];
    const recommendedBuild = itemIds.map((itemId, index) => ({
      itemId,
      position: itemIds.length - index,
      status: index === 6 ? 'NEXT' : index % 2 === 0 ? 'OWNED' : 'PLANNED',
      score: 0.5,
      confidence: 0.5,
      skeletonStrength: 0.5,
      contextualSupport: 0.5,
      reasonCodes: [],
    }));

    const view = buildAdaptiveRecommendationPresentation(recommendation({ recommendedBuild }));

    expect(view.plan.items).toHaveLength(8);
    expect(view.plan.items.map((item) => item.item.id)).toEqual([98582110, 84321454, 26002154, 7409189, 1437614329, 1342610602, 968099481, 3862866912]);
    expect(view.plan.remainingCount).toBe(0);
  });

  it('renders one card per semantic plan action instead of one card per barrier', () => {
    const view = buildAdaptiveRecommendationPresentation(recommendation({
      planActions: [{
        planActionId: 'revision-a:001:BUY_ITEM:3862866912',
        sequence: 1,
        status: 'BLOCKED',
        action: { actionKey: 'BUY_ITEM:3862866912', type: 'BUY', itemId: 3862866912, targetItemId: 3862866912, reasonCodes: ['WAIT_FOR_REQUIREMENTS'] },
        targetItemId: 3862866912,
        sourceItemIds: [],
        requirements: [
          { type: 'FLEX_SLOT', requiredFlexSlots: 1, evidence: 'UNKNOWN' },
          { type: 'SOULS', requiredSouls: 3200, currentSouls: 1600, shortfallSouls: 1600, evidence: 'OBSERVED' },
        ],
        reasonCodes: [],
      }],
      recommendedBuild: [{ itemId: 3862866912, position: 1, status: 'NEXT', score: 1, confidence: 1, skeletonStrength: 1, contextualSupport: 1, reasonCodes: [] }],
    }));

    expect(view.plan.items).toHaveLength(1);
    expect(view.plan.items[0].requirements).toEqual(['Requires flex slot - unlock state unknown', 'Save until 3,200 souls']);
  });

  it('does not collapse two legitimate transactions that use the same item id', () => {
    const action = (id: string, sequence: number, type: string) => ({
      planActionId: id,
      sequence,
      status: 'PLANNED',
      action: { actionKey: id, type, itemId: 3862866912, targetItemId: 3862866912, reasonCodes: [] },
      targetItemId: 3862866912,
      sourceItemIds: [],
      requirements: [],
      reasonCodes: [],
    });
    const view = buildAdaptiveRecommendationPresentation(recommendation({ planActions: [action('buy-first', 1, 'BUY'), action('buy-again', 2, 'BUY')] }));

    expect(view.plan.items).toHaveLength(2);
    expect(view.plan.items.map((item) => item.planActionId)).toEqual(['buy-first', 'buy-again']);
  });

  it('shows upgrade source components inside the target item card', () => {
    const view = buildAdaptiveRecommendationPresentation(recommendation({
      planActions: [{
        planActionId: 'upgrade-point-blank',
        sequence: 1,
        status: 'READY',
        action: { actionKey: 'UPGRADE_ITEM:999:upgrade:999', type: 'UPGRADE', itemId: 3862866912, targetItemId: 3862866912, reasonCodes: ['UPGRADE_PATH'] },
        targetItemId: 3862866912,
        sourceItemIds: [1437614329],
        requirements: [{ type: 'UPGRADE_COMPONENT', itemIds: [1437614329] }],
        reasonCodes: [],
      }],
    }));

    expect(view.plan.items[0].sourceItems[0].name).toBe('Melee Lifesteal');
    expect(view.plan.items[0].requirements).toEqual(['Upgrade Melee Lifesteal']);
  });

  it('shows situational purpose and only named supported enemy targets', () => {
    const view = buildAdaptiveRecommendationPresentation(recommendation({
      planActions: [{
        planActionId: 'knockdown-situational',
        sequence: 1,
        status: 'READY',
        action: { actionKey: 'BUY_ITEM:3862866912', type: 'BUY', itemId: 3862866912, targetItemId: 3862866912, reasonCodes: [] },
        targetItemId: 3862866912,
        sourceItemIds: [],
        requirements: [],
        reasonCodes: [],
        situational: {
          purpose: 'CATCH',
          targetEnemies: [
            { enemyHeroId: 1, enemyHeroName: 'Vindicta', role: 'PRIMARY', score: 0.7, confidence: 0.8, evidenceKinds: ['MATCHUP_STAT'] },
            { enemyHeroId: 2, enemyHeroName: 'Grey Talon', role: 'SECONDARY', score: 0.5, confidence: 0.7, evidenceKinds: ['MATCHUP_STAT'] },
            { enemyHeroId: 3, role: 'SECONDARY', score: 0.4, confidence: 0.6, evidenceKinds: ['MATCHUP_STAT'] },
          ],
          primaryTargetEnemyHeroId: 1,
          recommendationConfidence: 0.75,
          coreInterruption: { accepted: true },
          reasonCodes: ['MATCHUP_SUPPORTED'],
        },
      }],
    }));

    expect(view.situationalPurposeLabel).toBe('Catch');
    expect(view.againstLabel).toBe('vs Vindicta, Grey Talon');
    expect(view.plan.items[0].againstLabel).toBe('vs Vindicta, Grey Talon');
  });

  it('does not show numeric enemy ids as names when hero metadata is absent', () => {
    const view = buildAdaptiveRecommendationPresentation(recommendation({
      planActions: [{
        planActionId: 'unnamed-target',
        sequence: 1,
        status: 'READY',
        action: { actionKey: 'x', type: 'BUY', itemId: 3862866912, reasonCodes: [] },
        targetItemId: 3862866912,
        sourceItemIds: [],
        requirements: [],
        reasonCodes: [],
        situational: {
          purpose: 'CATCH',
          targetEnemies: [{ enemyHeroId: 999, role: 'PRIMARY', score: 1, confidence: 1, evidenceKinds: ['MATCHUP_STAT'] }],
          recommendationConfidence: 1,
          coreInterruption: { accepted: true },
          reasonCodes: [],
        },
      }],
    }));

    expect(view.againstLabel).toBeUndefined();
  });

  it('limits alternatives to three and omits the primary action', () => {
    const rankedImmediateCandidates = [
      { action: { actionKey: 'UPGRADE:3862866912', type: 'UPGRADE', itemId: 3862866912, reasonCodes: [] }, score: 0.95, confidence: 0.9 },
      { action: { actionKey: 'BUY:968099481', type: 'BUY', buyItemId: 968099481, reasonCodes: [] }, score: 0.84, confidence: 0.8 },
      { action: { actionKey: 'REPLACE:1:968099481', type: 'REPLACE', sellItemId: 1437614329, buyItemId: 968099481, reasonCodes: [] }, score: 0.8, confidence: 0.75 },
      { action: { actionKey: 'BUY:1342610602', type: 'BUY', buyItemId: 1342610602, reasonCodes: [] }, score: 0.74, confidence: 0.7 },
      { action: { actionKey: 'BUY:1437614329', type: 'BUY', buyItemId: 1437614329, reasonCodes: [] }, score: 0.64, confidence: 0.6 },
      { action: { actionKey: 'BUY:7409189', type: 'BUY', buyItemId: 7409189, reasonCodes: [] }, score: 0.54, confidence: 0.5 },
    ];

    const view = buildAdaptiveRecommendationPresentation(recommendation({ rankedImmediateCandidates }));

    expect(view.alternatives).toHaveLength(3);
    expect(view.alternatives.map((item) => item.item?.name)).toEqual(['Extra Spirit', 'Close Quarters', 'Melee Lifesteal']);
  });

  it('shows both sides of an exact replacement transaction', () => {
    const view = buildAdaptiveRecommendationPresentation(recommendation({
      nextAction: {
        actionKey: 'REPLACE:1437614329:3862866912',
        type: 'REPLACE',
        sellItemId: 1437614329,
        buyItemId: 3862866912,
        reasonCodes: ['FRESH_LEGALITY_FALLBACK'],
      },
    }));

    expect(view.headline).toBe('Sell Melee Lifesteal - Buy Restorative Shot');
    expect(view.primaryItem?.name).toBe('Restorative Shot');
    expect(view.replacedItem?.name).toBe('Melee Lifesteal');
  });

  it('labels a zero-confidence hold as a safe hold instead of misleading confidence', () => {
    const view = buildAdaptiveRecommendationPresentation(recommendation({
      confidence: 0,
      nextAction: { actionKey: 'HOLD:3862866912', type: 'HOLD', targetItemId: 3862866912, reasonCodes: ['PLAN_HYSTERESIS', 'STATLOCKER_UNAVAILABLE_PRESERVE_PLAN'] },
    }));

    expect(view.headline).toBe('Hold for Restorative Shot');
    expect(view.confidence).toEqual({ label: 'Safe hold', value: 0 });
  });

  it('uses a quiet fallback for unknown item ids and humanizes unknown reasons', () => {
    const view = buildAdaptiveRecommendationPresentation(recommendation({
      nextTargetItemId: 999999999,
      nextAction: { actionKey: 'WAIT:999999999', type: 'WAIT', targetItemId: 999999999, reasonCodes: ['NO_USABLE_STATLOCKER_EVIDENCE', 'CUSTOM_REASON_CODE'] },
    }));

    expect(view.headline).toBe('Wait before buying');
    expect(view.primaryItem).toMatchObject({ id: 999999999, name: 'Unknown item', diagnosticLabel: '#999999999', known: false });
    expect(view.reasons).toEqual(['Waiting for reliable Statlocker data', 'Custom reason code']);
  });
});
