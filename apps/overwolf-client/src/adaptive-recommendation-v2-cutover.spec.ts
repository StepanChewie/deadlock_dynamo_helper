import type { AdaptiveFullBuildStepV2, AdaptiveRecommendationResultV2 } from '@deadlock-live-probe/shared';
import { AdaptiveRecommendationClient } from './adaptive-recommendation-client';
import { buildAdaptiveRecommendationPresentation } from './adaptive-recommendation-presentation';

const buildItemIds = [
  1009965641,
  1342610602,
  98582110,
  3190916303,
  112198670,
  1235347618,
  3731635960,
  3791587546,
  1193964439,
  2463960640,
  2417568017,
  1250307611,
  3862866912,
  968099481,
  1437614329,
] as const;

function steps(): AdaptiveFullBuildStepV2[] {
  const rows: AdaptiveFullBuildStepV2[] = buildItemIds.map((itemId, index) => ({
    sequence: index + 1,
    action: 'BUY',
    buyItemId: itemId,
    consumedItemIds: [],
    inventoryBefore: buildItemIds.slice(0, index),
    inventoryAfter: buildItemIds.slice(0, index + 1),
    reasonCodes: [],
  }));

  rows[3] = {
    ...rows[3],
    action: 'UPGRADE',
    recipeId: 'recipe-spirit-snatch',
    consumedItemIds: [465043967],
    inventoryBefore: [465043967, ...buildItemIds.slice(0, 3)],
  };
  rows[12] = {
    ...rows[12],
    action: 'REPLACE',
    sellItemId: 1813726886,
    inventoryBefore: [1813726886, ...buildItemIds.slice(0, 12)],
  };
  return rows;
}

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
    steps: steps(),
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

  it('uses only V2, preserves the full 15-step lifetime path, and keeps nextAction separate', async () => {
    const fetcher = jest.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: jest.fn().mockResolvedValue(result),
    } as any);
    let received: AdaptiveRecommendationResultV2 | undefined;
    let presentation: ReturnType<typeof buildAdaptiveRecommendationPresentation> | undefined;
    const client = new AdaptiveRecommendationClient('https://api.example', fetcher, 10);

    client.schedule({ matchId: 'match-a', localSteamId: 'steam-a' }, {
      onResult: (value) => {
        received = value;
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
    expect(received?.nextAction).toMatchObject({ type: 'BUY', buyItemId: 1009965641 });
    expect(received?.fullBuild?.steps).toHaveLength(15);
    expect(received?.fullBuild?.steps.map((entry) => entry.action)).toEqual([
      'BUY', 'BUY', 'BUY', 'UPGRADE', 'BUY',
      'BUY', 'BUY', 'BUY', 'BUY', 'BUY',
      'BUY', 'BUY', 'REPLACE', 'BUY', 'BUY',
    ]);
    expect(received?.fullBuild?.steps[3]).toMatchObject({
      action: 'UPGRADE',
      buyItemId: 3190916303,
      recipeId: 'recipe-spirit-snatch',
      consumedItemIds: [465043967],
    });
    expect(received?.fullBuild?.steps[12]).toMatchObject({
      action: 'REPLACE',
      sellItemId: 1813726886,
      buyItemId: 3862866912,
    });
    expect(presentation?.plan.items.map((entry) => entry.item.id)).toEqual([...buildItemIds]);
    expect(presentation?.plan.items).toHaveLength(15);
    expect(presentation?.plan.items.map((entry) => entry.position)).toEqual(
      Array.from({ length: 15 }, (_, index) => index + 1),
    );
    expect(presentation?.actionLabel).toBe('Buy now');
  });
});
