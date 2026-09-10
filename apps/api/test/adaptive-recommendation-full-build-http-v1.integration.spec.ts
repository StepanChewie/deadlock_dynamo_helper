import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdaptiveRecommendationV1Controller } from '../src/statlocker-adaptive/adaptive-recommendation-v1.controller';
import { AdaptiveRecommendationV1Service } from '../src/statlocker-adaptive/adaptive-recommendation-v1.service';
import { AdaptiveRecommendationObservabilityV1Service } from '../src/statlocker-adaptive/adaptive-recommendation-observability-v1.service';
import { StatlockerEvidenceService } from '../src/statlocker-adaptive/statlocker-evidence.service';
import { StatlockerRefreshService } from '../src/statlocker-adaptive/statlocker-refresh.service';
import { StrategyFirstOperationsV1Service } from '../src/statlocker-adaptive/strategy-first-operations-v1.service';
import { StrategyFirstPromotionGateV1Service } from '../src/statlocker-adaptive/strategy-first-promotion-gate-v1.service';

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

function recommendation() {
  return {
    ready: true,
    blockers: [],
    decisionId: 'decision-http-full-build',
    stateRevision: 'revision-http-full-build',
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

describe('adaptive recommendation full-build HTTP contract', () => {
  let app: INestApplication | undefined;
  const service = { recommend: jest.fn() };

  beforeEach(async () => {
    service.recommend.mockResolvedValue(recommendation());
    const moduleRef = await Test.createTestingModule({
      controllers: [AdaptiveRecommendationV1Controller],
      providers: [
        { provide: AdaptiveRecommendationV1Service, useValue: service },
        { provide: StatlockerRefreshService, useValue: {} },
        { provide: StatlockerEvidenceService, useValue: {} },
        { provide: AdaptiveRecommendationObservabilityV1Service, useValue: {} },
        { provide: StrategyFirstPromotionGateV1Service, useValue: {} },
        { provide: StrategyFirstOperationsV1Service, useValue: {} },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    jest.clearAllMocks();
  });

  it('returns the complete semantic build without converting barrier rows into build rows', async () => {
    const baseUrl = await app!.getUrl();
    const response = await fetch(`${baseUrl}/deadlock/adaptive/v1/recommend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matchId: 'match-a', localSteamId: 'steam-a' }),
    });
    const body = await response.json() as any;

    expect(response.status).toBe(201);
    expect(service.recommend).toHaveBeenCalledWith({ matchId: 'match-a', localSteamId: 'steam-a' });
    expect(body.recommendedBuild.map((row: any) => row.itemId)).toEqual(itemIds);
    expect(body.recommendedBuild.map((row: any) => row.status)).toEqual([
      'NEXT',
      'PLANNED',
      'PLANNED',
      'PLANNED',
      'PLANNED',
    ]);
    expect(body.planActions).toHaveLength(3);
    expect(body.planActions.every((row: any) => row.targetItemId === 1342610602)).toBe(true);
  });
});
