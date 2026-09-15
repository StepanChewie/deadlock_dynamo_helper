import type { AdaptiveRecommendationResultV2 } from '@deadlock-live-probe/shared';
import { AdaptiveRecommendationClient } from './adaptive-recommendation-client';
import { buildAdaptiveRecommendationPresentation } from './adaptive-recommendation-presentation';

const itemIds = [1342610602, 3862866912, 968099481, 1437614329, 7409189];

function payload(): AdaptiveRecommendationResultV2 {
  return {
    ready: true,
    blockers: [],
    decisionId: 'decision-client-full-build-v2',
    stateRevision: 'revision-client-full-build-v2',
    heroId: 72,
    nextAction: {
      type: 'HOLD',
      buyItemId: itemIds[0],
      reasonCodes: ['PLAN_REQUIREMENTS_BLOCKED'],
    },
    fullBuild: {
      planRevision: 'plan-client-full-build-v2',
      steps: itemIds.map((itemId, index) => ({
        sequence: index + 1,
        action: 'BUY' as const,
        buyItemId: itemId,
        consumedItemIds: [],
        inventoryBefore: itemIds.slice(0, index),
        inventoryAfter: itemIds.slice(0, index + 1),
        reasonCodes: [],
      })),
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

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('adaptive recommendation full-build V2 client pipeline', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('renders the complete V2 full build received from the recommendation endpoint', async () => {
    const fetcher = jest.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: jest.fn().mockResolvedValue(payload()),
    } as any);
    let presented: ReturnType<typeof buildAdaptiveRecommendationPresentation> | undefined;
    const client = new AdaptiveRecommendationClient('https://api.example', fetcher, 10);

    client.schedule(
      { matchId: 'match-a', localSteamId: 'steam-a' },
      {
        onResult: (result) => {
          presented = buildAdaptiveRecommendationPresentation(result as any);
        },
      },
    );
    jest.advanceTimersByTime(10);
    await flush();

    expect(fetcher).toHaveBeenCalledWith(
      'https://api.example/deadlock/adaptive/v2/recommend',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(presented?.plan.items.map((row) => row.item.id)).toEqual(itemIds);
    expect(presented?.plan.items.map((row) => row.position)).toEqual([1, 2, 3, 4, 5]);
    expect(presented?.plan.items).toHaveLength(5);
    expect(presented?.plan.items[0]).toMatchObject({
      statusLabel: 'Ready',
      actionLabel: 'Buy now',
    });
    expect(presented?.plan.items.slice(1).every((row) => row.actionLabel === 'Planned')).toBe(true);
  });
});
