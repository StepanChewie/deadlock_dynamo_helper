import type { AdaptiveRecommendationResultV2 } from '@deadlock-live-probe/shared';
import {
  projectAdaptiveRecommendationV2ForPresentation,
} from './adaptive-recommendation-client';
import { buildAdaptiveRecommendationPresentation } from './adaptive-recommendation-presentation';

function recommendation(): AdaptiveRecommendationResultV2 {
  return {
    ready: true,
    blockers: [],
    decisionId: 'decision-full-build-v2',
    stateRevision: 'revision-full-build-v2',
    heroId: 72,
    nextAction: {
      type: 'HOLD',
      buyItemId: 1342610602,
      reasonCodes: ['PLAN_REQUIREMENTS_BLOCKED'],
    },
    fullBuild: {
      planRevision: 'plan-full-build-v2',
      steps: [
        {
          sequence: 1,
          action: 'BUY',
          buyItemId: 1342610602,
          consumedItemIds: [],
          inventoryBefore: [],
          inventoryAfter: [1342610602],
          reasonCodes: [],
        },
        {
          sequence: 2,
          action: 'UPGRADE',
          buyItemId: 3190916303,
          recipeId: 'recipe-spirit-snatch',
          consumedItemIds: [465043967],
          inventoryBefore: [1342610602, 465043967],
          inventoryAfter: [1342610602, 3190916303],
          reasonCodes: [],
        },
        {
          sequence: 3,
          action: 'REPLACE',
          sellItemId: 1813726886,
          buyItemId: 3862866912,
          consumedItemIds: [],
          inventoryBefore: [1342610602, 3190916303, 1813726886],
          inventoryAfter: [1342610602, 3190916303, 3862866912],
          reasonCodes: [],
        },
      ],
      degradedReasons: [],
      validation: { valid: true, reasonCodes: [] },
      mechanicalValidation: { valid: true, reasonCodes: [] },
      semanticValidation: { valid: true, reasonCodes: [], finalFamilyStates: [] },
    },
    score: { total: 0.72, confidence: 0.56 },
    evidence: {
      rulesetVersion: 'ruleset-a',
      catalogSha256: 'a'.repeat(64),
      statlockerPatchId: '15-1',
      sourceProfileCount: 10,
      sourceProfileAccountIds: [],
      families: [],
      degradedReasons: [],
    },
    degradedReasons: [],
  };
}

describe('adaptive recommendation V2 full build path', () => {
  it('projects the lifetime transaction path without replacing it with the immediate action', () => {
    const source = recommendation();
    const projected = projectAdaptiveRecommendationV2ForPresentation(source);
    const view = buildAdaptiveRecommendationPresentation(projected as any);

    expect(source.nextAction.type).toBe('HOLD');
    expect(source.fullBuild?.steps.map((step) => step.action)).toEqual([
      'BUY',
      'UPGRADE',
      'REPLACE',
    ]);
    expect(source.fullBuild?.steps[2]).toMatchObject({
      sellItemId: 1813726886,
      buyItemId: 3862866912,
    });
    expect(view.plan.items.map((entry) => entry.item.id)).toEqual([
      1342610602,
      3190916303,
      3862866912,
    ]);
    expect(view.plan.items.map((entry) => entry.position)).toEqual([1, 2, 3]);
    expect(view.actionLabel).toBe('Hold');
  });
});
