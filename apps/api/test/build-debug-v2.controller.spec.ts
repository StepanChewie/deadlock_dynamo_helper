import { BuildDebugV2Controller } from '../src/build-debug-v2/build-debug-v2.controller';

describe('BuildDebugV2Controller player dimension', () => {
  it('requires the player when reading a match trace', async () => {
    const traces = {
      listActive: jest.fn().mockReturnValue([
        { matchId: 'm-1', steamId: 'steam-111', revision: 3, stateRevision: 'rev-1', generatedAt: '2026-09-14T00:00:00.000Z' },
      ]),
      get: jest.fn().mockReturnValue({
        matchId: 'm-1',
        steamId: 'steam-111',
        revision: 3,
        stateRevision: 'rev-1',
        generatedAt: '2026-09-14T00:00:00.000Z',
        stages: [],
      }),
    };
    const controller = new BuildDebugV2Controller({} as any, traces as any);

    expect(() => controller.snapshot('m-1', '')).toThrow('steamId is required');
    controller.snapshot('m-1', 'steam-111');
    expect(traces.get).toHaveBeenCalledWith('m-1', 'steam-111');
  });
});
