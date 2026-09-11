import type { AdaptiveRecommendationResultV2 } from '@deadlock-live-probe/shared';
import { AdaptiveRecommendationClient } from './adaptive-recommendation-client';
import { buildAdaptiveRecommendationPresentation } from './adaptive-recommendation-presentation';

const result: AdaptiveRecommendationResultV2 = {
  ready: true,
  blockers: [],
  decisionId: 'decision-v2-cutover',
  stateRevision: 'revision-v2-cutover',
  heroId: 72,
  nextAction: {
    type: 'BUY',
    buyItemId: 1009965641,
    reasonCodes: ['FAMILY_FIRST_FULL_BUILD'],
  },
  fullBuild: {
    planRevision: 'plan-v2-cutover',
    steps: [
      {
        sequence: 1,
        action: 'BUY',
        buyItemId: 1009965641,
        consumedItemIds: [],
        inventoryBefore: [],
        inventoryAfter: [1009965641],
        reasonCodes: [],
      },
      {
        sequence: 2,
        action: 'BUY',
        buyItemId: 1342610602,
        consumedItemIds: [],
        inventoryBefore: [1009965641],
        inventoryAfter: [1009965641, 1342610602],
        reasonCodes: [],
      },
      {
        sequence: 3,
        action: 'BUY',
        buyItemId: 98582110,
        consumedItemIds: [],
        inventoryBefore: [1009965641, 1342610602],
        inventoryAfter: [1009965641, 1342610602, 98582110],
        reasonCodes: [],
      },
    ],
    degradedReasons: [],
    validation: { valid: true, reasonCodes: [] },
    mechanicalValidation: { valid: true, reasonCodes: [] },
    semanticValidation: { valid: true, reasonCodes: [], finalFamilyStates: [] },
  },
  score: { total: 0.7, confidence: 0.6 },
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

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('Overwolf adaptive recommendation V2 cutover', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('requests only the V2 endpoint and renders the V2 full build in purchase order', async () => {
    const fetcher = jest.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: jest.fn().mockResolvedValue(result),
    } as any);
    let presentation: ReturnType<typeof buildAdaptiveRecommendationPresentation> | undefined;
    const client = new AdaptiveRecommendationClient('https://api.example', fetcher, 10);

    client.schedule({ matchId: 'match-a', localSteamId: 'steam-a' }, {
      onResult: (value) => {
        presentation = buildAdaptiveRecommendationPresentation(value as any);
      },
    });
    jest.advanceTimersByTime(10);
    await flush();

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.example/deadlock/adaptive/v2/recommend',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetcher.mock.calls[0][0]).not.toContain('/deadlock/adaptive/v1/');
    expect(presentation?.plan.items.map((entry) => entry.item.id)).toEqual([
      1009965641,
      1342610602,
      98582110,
    ]);
    expect(presentation?.plan.items.map((entry) => entry.position)).toEqual([1, 2, 3]);
    expect(presentation?.actionLabel).toBe('Buy now');
  });
});
