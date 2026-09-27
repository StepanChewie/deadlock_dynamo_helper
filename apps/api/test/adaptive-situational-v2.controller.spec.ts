import { BadRequestException } from '@nestjs/common';
import { AdaptiveSituationalV2Controller } from '../src/statlocker-adaptive/adaptive-situational-v2.controller';

function controllerWith(recommend = jest.fn(async () => readyResult())) {
  return {
    controller: new AdaptiveSituationalV2Controller(
      { recommend } as never,
      { getAvailability: jest.fn(() => ({ recommendationsEnabled: true })) } as never,
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

  it('fails closed while recommendations are disabled', async () => {
    const { controller, recommend } = controllerWith();
    (controller as unknown as { availability: { getAvailability: jest.Mock } }).availability = {
      getAvailability: jest.fn(() => ({ recommendationsEnabled: false, maintenanceMessage: 'down' })),
    };

    const result = await controller.recommend({ matchId: 'match-1' });

    expect(recommend).not.toHaveBeenCalled();
    expect(result.ready).toBe(false);
    expect(result.blockers).toContain('RECOMMENDATIONS_DISABLED');
  });
});
