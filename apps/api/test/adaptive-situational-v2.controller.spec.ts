import { BadRequestException } from '@nestjs/common';
import { AdaptiveSituationalV2Controller } from '../src/statlocker-adaptive/adaptive-situational-v2.controller';
import { AdaptiveLiveStateNotReadyError } from '../src/statlocker-adaptive/adaptive-decision-state-v1.service';

function controllerWith(
  recommend: jest.Mock = jest.fn(async () => readyResult()),
  availability: unknown = {
    getAvailability: jest.fn(() => ({ recommendationsEnabled: true })),
  },
) {
  return {
    controller: new AdaptiveSituationalV2Controller(
      { recommend } as never,
      availability as never,
    ),
    recommend,
  };
}

function readyResult() {
  return {
    mode: 'situational' as const,
    ready: true,
    blockers: [],
    decisionId: 'decision-1',
    stateRevision: 'rev-1',
    situationalItems: [],
    degradedReasons: [],
  };
}

describe('AdaptiveSituationalV2Controller', () => {
  it('rejects a missing matchId', async () => {
    const { controller } = controllerWith();
    await expect(controller.recommend({} as never)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a blank localSteamId', async () => {
    const { controller } = controllerWith();
    await expect(
      controller.recommend({ matchId: 'match-1', localSteamId: '  ' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('trims the values it passes on', async () => {
    const { controller, recommend } = controllerWith();
    await controller.recommend({ matchId: '  match-1  ', localSteamId: ' steam-1 ' });

    expect(recommend).toHaveBeenCalledWith({ matchId: 'match-1', localSteamId: 'steam-1' });
  });

  it('fails closed when the live state is not ready', async () => {
    const recommend = jest.fn(async () => {
      throw new AdaptiveLiveStateNotReadyError('match-1', 'LIVE_MATCH_STATE_UNAVAILABLE');
    });
    const { controller } = controllerWith(recommend);

    const result = await controller.recommend({ matchId: 'match-1' });

    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual(['LIVE_STATE_NOT_READY', 'LIVE_MATCH_STATE_UNAVAILABLE']);
    expect(result.degradedReasons).toEqual(['LIVE_STATE_NOT_READY', 'LIVE_MATCH_STATE_UNAVAILABLE']);
    expect(result.situationalItems).toEqual([]);
  });

  it('fails closed while recommendations are disabled', async () => {
    const availability = {
      getAvailability: jest.fn(() => ({
        recommendationsEnabled: false,
        maintenanceMessage: 'Deadlock patch in progress',
      })),
    };
    const { controller, recommend } = controllerWith(undefined, availability);

    const result = await controller.recommend({ matchId: 'match-1' });

    expect(recommend).not.toHaveBeenCalled();
    expect(result.ready).toBe(false);
    expect(result.blockers).toContain('RECOMMENDATIONS_DISABLED');
    expect(result.degradedReasons).toContain('Deadlock patch in progress');
  });
});
