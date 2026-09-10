import { AdaptiveRecommendationClient } from './adaptive-recommendation-client';
import { buildAdaptiveRecommendationPresentation } from './adaptive-recommendation-presentation';

const itemIds = [1342610602, 3862866912, 968099481, 1437614329, 7409189];

function plannedItem(itemId: number, position: number, status: 'NEXT' | 'PLANNED') {
  return {
    itemId,
    position,
    status,
    score: 0.5,
    confidence: 0.5,
    skeletonStrength: 0.5,
    contextualSupport: 0.5,
    reasonCodes: [],
  };
}

function payload(): any {
  return {
    ready: true,
    blockers: [],
    decisionId: 'decision-client-full-build',
    stateRevision: 'revision-client-full-build',
    gameState: 'BEHIND',
    nextAction: {
      actionKey: 'HOLD:1342610602',
      type: 'HOLD',
      targetItemId: 1342610602,
      reasonCodes: ['PLAN_REQUIREMENTS_BLOCKED'],
    },
    nextTargetItemId: 1342610602,
    planActions: [
      {
        planActionId: 'close-quarters:wait-current',
        sequence: 1,
        status: 'BLOCKED',
        action: {
          actionKey: 'WAIT:1342610602',
          type: 'WAIT',
          targetItemId: 1342610602,
          reasonCodes: ['WAIT_FOR_REQUIREMENTS'],
        },
        targetItemId: 1342610602,
        sourceItemIds: [],
        requirements: [
          {
            type: 'SOULS',
            requiredSouls: 800,
            currentSouls: 650,
            shortfallSouls: 150,
            evidence: 'OBSERVED',
          },
        ],
        goalId: 'close-quarters-goal',
        reasonCodes: [],
      },
      {
        planActionId: 'close-quarters:wait-for-souls',
        sequence: 2,
        status: 'PLANNED',
        action: {
          actionKey: 'WAIT_FOR_SOULS:1342610602',
          type: 'WAIT',
          targetItemId: 1342610602,
          reasonCodes: [],
        },
        targetItemId: 1342610602,
        sourceItemIds: [],
        requirements: [
          {
            type: 'SOULS',
            requiredSouls: 800,
            evidence: 'UNKNOWN',
          },
        ],
        goalId: 'close-quarters-goal',
        reasonCodes: [],
      },
      {
        planActionId: 'close-quarters:buy',
        sequence: 3,
        status: 'PLANNED',
        action: {
          actionKey: 'BUY:1342610602',
          type: 'BUY',
          buyItemId: 1342610602,
          targetItemId: 1342610602,
          reasonCodes: [],
        },
        targetItemId: 1342610602,
        sourceItemIds: [],
        requirements: [],
        goalId: 'close-quarters-goal',
        reasonCodes: [],
      },
    ],
    recommendedBuild: itemIds.map((itemId, index) => plannedItem(
      itemId,
      index + 1,
      index === 0 ? 'NEXT' : 'PLANNED',
    )),
    changes: [],
    rankedImmediateCandidates: [],
    totalScore: 0.72,
    confidence: 0.56,
    scorerVersion: 'adaptive-evidence-scorer-v1',
    plannerVersion: 'adaptive-build-planner-v1',
    configVersion: 'statlocker-adaptive-v1.3.0',
    evidence: {
      rulesetVersion: 'ruleset-a',
      catalogSha256: 'a'.repeat(64),
      statlockerPatchId: '15-1',
      snapshotIds: ['snapshot-a'],
      families: [],
      degradedReasons: [],
    },
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('adaptive recommendation full-build client pipeline', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('renders the complete semantic build received from the recommendation endpoint', async () => {
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
          presented = buildAdaptiveRecommendationPresentation(result);
        },
      },
    );
    jest.advanceTimersByTime(10);
    await flush();

    expect(fetcher).toHaveBeenCalledWith(
      'https://api.example/deadlock/adaptive/v1/recommend',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(presented?.plan.items.map((row) => row.item.id)).toEqual(itemIds);
    expect(presented?.plan.items).toHaveLength(5);
    expect(presented?.plan.items[0]).toMatchObject({
      statusLabel: 'Next',
      actionLabel: 'Hold',
      requirements: ['Save until 800 souls'],
    });
    expect(presented?.plan.items.slice(1).every((row) => row.actionLabel === 'Planned')).toBe(true);
  });
});
