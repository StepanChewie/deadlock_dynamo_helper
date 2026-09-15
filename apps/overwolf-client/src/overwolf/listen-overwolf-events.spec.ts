jest.mock('../diagnostics/diagnostic-capture', () => ({
  DiagnosticCapture: class {
    initialize(): void {}
    captureRaw(): void {}
  },
}));

import { listenOverwolfEvents } from './listen-overwolf-events';

describe('listenOverwolfEvents', () => {
  it('reconciles active state and ignores a later terminal safety snapshot', () => {
    jest.useFakeTimers();
    const onEvent = jest.fn();
    let pollCount = 0;
    const getInfo = jest.fn((callback: (result: unknown) => void) => {
      pollCount += 1;
      const terminal = pollCount > 1;
      callback({
        success: true,
        res: {
          match_info: {
            match_id: '"93946399"',
            ...(terminal
              ? {
                match_outcome: JSON.stringify({ winning_team: 'SAPPHIRE' }),
                match_state: 'ended',
                match_end: true,
              }
              : {}),
          },
          roster: {
            roster_12: JSON.stringify({
              steam_id: '76561198000000001',
              hero_id: 15,
              team_id: 2,
            }),
          },
          items: {
            items_12: JSON.stringify({
              steam_id: '76561198000000001',
              items: [
                {
                  id: 100,
                  name: 'Extra Regen',
                  class_name: 'extra_regen',
                },
              ],
            }),
          },
          unsupported: {
            ignored: 'value',
          },
        },
      });
    });

    (globalThis as any).overwolf = {
      games: {
        events: {
          onInfoUpdates2: { addListener: jest.fn() },
          onNewEvents: { addListener: jest.fn() },
          getInfo,
        },
      },
    };

    listenOverwolfEvents(onEvent);

    expect(getInfo).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledTimes(3);
    expect(onEvent.mock.calls.map(([event]) => event.key)).toEqual([
      'match_id',
      'roster_12',
      'items_12',
    ]);
    expect(onEvent.mock.calls.map(([event]) => event.category)).toEqual([
      'match_info',
      'roster',
      'items',
    ]);
    expect(onEvent).toHaveBeenCalledWith({
      matchId: '93946399',
      receivedAt: expect.any(Number),
      source: 'onInfoUpdates2',
      feature: 'state_safety_poll',
      category: 'roster',
      key: 'roster_12',
      payload: {
        steam_id: '76561198000000001',
        hero_id: 15,
        team_id: 2,
      },
    });
    expect(onEvent.mock.calls.every(([event]) => event.matchId === '93946399')).toBe(true);

    jest.advanceTimersByTime(3_000);

    expect(getInfo).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenCalledTimes(3);

    jest.clearAllTimers();
    jest.useRealTimers();
    delete (globalThis as any).overwolf;
  });

  it('records the snapshot shape and phase for the diagnostics block', () => {
    // The listener keeps module-level timer and snapshot state, so this test
    // needs its own registry rather than whatever an earlier test left behind.
    jest.resetModules();
    const mod = require('./listen-overwolf-events');
    jest.useFakeTimers();

    const getInfo = jest.fn((callback: (result: unknown) => void) => {
      callback({
        success: true,
        res: {
          game_info: {
            phase: 'GameInProgress',
            steam_id: '76561198000000001',
          },
          gep_internal: {
            version_info: JSON.stringify({
              local_version: '244.0.0',
              public_version: '260.0.0',
              is_updated: true,
            }),
          },
        },
      });
    });

    (globalThis as any).overwolf = {
      games: {
        events: {
          onInfoUpdates2: { addListener: jest.fn() },
          onNewEvents: { addListener: jest.fn() },
          getInfo,
        },
      },
    };

    mod.listenOverwolfEvents(jest.fn());

    expect(mod.readGepSnapshotShape()).toBe('game_info(phase,steam_id) gep_internal(version_info)');
    expect(mod.readGepPhase()).toBe('GameInProgress');
    expect(mod.readGepVersion()).toBe('local 244.0.0 / public 260.0.0');

    jest.clearAllTimers();
    jest.useRealTimers();
    delete (globalThis as any).overwolf;
  });

  it('makes a missing match_info visible instead of silently doing nothing', () => {
    jest.resetModules();
    const mod = require('./listen-overwolf-events');
    jest.useFakeTimers();

    const onEvent = jest.fn();
    const getInfo = jest.fn((callback: (result: unknown) => void) => {
      callback({ success: true, res: { game_info: { steam_id: '76561198000000001' } } });
    });

    (globalThis as any).overwolf = {
      games: {
        events: {
          onInfoUpdates2: { addListener: jest.fn() },
          onNewEvents: { addListener: jest.fn() },
          getInfo,
        },
      },
    };

    mod.listenOverwolfEvents(onEvent);

    // No match id anywhere, which is exactly the state that leaves the overlay
    // down and the build stuck on "waiting".
    expect(onEvent.mock.calls.every(([event]: any[]) => event.matchId === undefined)).toBe(true);
    expect(mod.readGepSnapshotShape()).toBe('game_info(steam_id)');

    jest.clearAllTimers();
    jest.useRealTimers();
    delete (globalThis as any).overwolf;
  });
});
