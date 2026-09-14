import { AdaptiveRecommendationV2Controller } from '../src/statlocker-adaptive/adaptive-recommendation-v2.controller';
import { AdaptiveLiveStateNotReadyError } from '../src/statlocker-adaptive/adaptive-decision-state-v1.service';

function controllerWith(recommend: jest.Mock, record: jest.Mock, liveState: any = { getState: () => undefined }) {
  return new AdaptiveRecommendationV2Controller({ recommend } as any, { record } as any, liveState as any);
}

describe('AdaptiveRecommendationV2Controller history hook', () => {
  it('records the iteration with the steamId resolved by the service', async () => {
    const record = jest.fn().mockResolvedValue(undefined);
    const controller = controllerWith(
      jest.fn(async (_request: any, capture: any) => {
        capture.steamId = 'steam-222';
        return { ready: true, blockers: [], stateRevision: 'rev-1', score: { total: 1, confidence: 1 }, nextAction: { type: 'BUY', reasonCodes: [] } };
      }),
      record,
    );

    await controller.recommend({ matchId: 'match-1' });

    expect(record).toHaveBeenCalledWith(expect.objectContaining({ matchId: 'match-1', steamId: 'steam-222' }));
  });

  it('records a not-ready answer and still returns it', async () => {
    const record = jest.fn().mockResolvedValue(undefined);
    const controller = controllerWith(
      jest.fn().mockRejectedValue(new AdaptiveLiveStateNotReadyError('match-1', 'LIVE_MATCH_STATE_UNAVAILABLE')),
      record,
    );

    const result = await controller.recommend({ matchId: 'match-1' });

    expect(result.ready).toBe(false);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ matchId: 'match-1', steamId: 'unknown' }));
  });
});
