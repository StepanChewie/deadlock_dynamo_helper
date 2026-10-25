import { OverwolfLiveBatchDto } from '@dynamo-lab/shared';
import { projectMatchHistoryBatch } from '../src/match-history/match-history-projection';

function batch(events: OverwolfLiveBatchDto['events'], clientId = 'client-1'): OverwolfLiveBatchDto {
  return { clientId, events };
}

function rosterEvent(matchId: string, payload: Record<string, unknown>, receivedAt = 1) {
  return { receivedAt, source: 'onInfoUpdates2' as const, key: 'roster_0', payload, matchId };
}

describe('projectMatchHistoryBatch', () => {
  it('projects the local player and the roster', () => {
    const result = projectMatchHistoryBatch(batch([
      rosterEvent('m1', {
        steam_id: '765', player_name: 'me', is_local: true, hero_id: 5, hero_name: 'Ivy',
        team: 1, lane: 2, level: 22, souls: 48000, kills: 11, deaths: 3, assists: 9,
        hero_damage: 51000, object_damage: 8000, healing: 1200,
      }),
      rosterEvent('m1', { steam_id: '999', player_name: 'foe', is_local: false, hero_id: 8, kills: 2, deaths: 9 }),
    ]));

    expect(result?.matchId).toBe('m1');
    expect(result?.localSteamId).toBe('765');
    expect(result?.players).toHaveLength(2);
    expect(result?.players[0]).toMatchObject({ steamId: '765', name: 'me', isLocal: true, heroId: 5, souls: 48000 });
    expect(result?.players[1]).toMatchObject({ steamId: '999', isLocal: false });
  });

  it('returns null when the batch has no roster and no local player', () => {
    expect(projectMatchHistoryBatch(batch([
      { receivedAt: 1, source: 'onInfoUpdates2', key: 'match_clock', payload: '10:00', matchId: 'm2' },
    ], 'c'))).toBeNull();
  });

  it('maxes match_clock across batch and previous, parsing mm:ss and h:mm:ss', () => {
    const first = projectMatchHistoryBatch(batch([
      rosterEvent('m3', { steam_id: '1', is_local: true }),
      { receivedAt: 2, source: 'onInfoUpdates2', key: 'match_clock', payload: '31:04', matchId: 'm3' },
    ]));
    const second = projectMatchHistoryBatch(batch([
      { receivedAt: 3, source: 'onInfoUpdates2', key: 'match_clock', payload: '30:59', matchId: 'm3' },
      { receivedAt: 4, source: 'onInfoUpdates2', key: 'match_clock', payload: '1:00:01', matchId: 'm3' },
    ]), first ?? undefined);

    expect(first?.durationSec).toBe(31 * 60 + 4);
    expect(second?.durationSec).toBe(3600 + 1);
  });

  it('merges partial roster snapshots field-level: defined fields win, undefined never clobbers', () => {
    const first = projectMatchHistoryBatch(batch([
      rosterEvent('m4', { steam_id: '765', is_local: true, hero_id: 5, kills: 3 }),
    ]));
    const second = projectMatchHistoryBatch(batch([
      rosterEvent('m4', { steam_id: '765', is_local: true, kills: 7 }),
    ]), first ?? undefined);

    expect(second?.players[0]).toMatchObject({ heroId: 5, kills: 7 });
  });

  it('sanitizes a hostile matchId to a single path segment', () => {
    const result = projectMatchHistoryBatch(batch([
      rosterEvent('../evil', { steam_id: '765', is_local: true }),
    ]));
    expect(result?.matchId).toBe('..evil');
  });

  it('ignores events for other matches when one batch carries several match ids', () => {
    const result = projectMatchHistoryBatch(batch([
      rosterEvent('m5', { steam_id: '765', is_local: true }),
      rosterEvent('other', { steam_id: '999', is_local: true }),
    ]));
    expect(result?.matchId).toBe('m5');
    expect(result?.players).toHaveLength(1);
  });
});
