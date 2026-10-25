import { Repository } from 'typeorm';
import { OverwolfLiveBatchDto } from '@dynamo-lab/shared';
import { MatchHistoryService } from '../src/match-history/match-history.service';
import { AppUserV1Entity } from '../src/match-history/entities/app-user-v1.entity';
import { MatchHistoryV1Entity } from '../src/match-history/entities/match-history-v1.entity';

function rosterBatch(matchId: string, steamId: string, name = 'me'): OverwolfLiveBatchDto {
  return {
    clientId: 'client-9',
    events: [{
      receivedAt: 1, source: 'onInfoUpdates2', key: 'roster_0', matchId,
      payload: { steam_id: steamId, player_name: name, is_local: true, hero_id: 5, kills: 4, souls: 41000 },
    }],
  };
}

describe('MatchHistoryService', () => {
  function makeService() {
    const users = { createQueryBuilder: jest.fn() };
    const matches = { createQueryBuilder: jest.fn() };
    const service = new MatchHistoryService(
      users as unknown as Repository<AppUserV1Entity>,
      matches as unknown as Repository<MatchHistoryV1Entity>,
    );
    return { service, users, matches };
  }

  it('upserts the user and the match row', async () => {
    const { service, users, matches } = makeService();
    const chain = () => ({
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orUpdate: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue(undefined),
    });
    const userInsert = chain();
    const matchInsert = chain();
    users.createQueryBuilder.mockReturnValue(userInsert);
    matches.createQueryBuilder.mockReturnValue(matchInsert);

    await service.applyBatch(rosterBatch('m1', '765'));

    expect(userInsert.values).toHaveBeenCalledWith(expect.objectContaining({
      steamId: '765', playerName: 'me', lastClientId: 'client-9',
    }));
    expect(userInsert.orUpdate).toHaveBeenCalledWith(
      ['playerName', 'lastClientId', 'lastSeenAt'], ['steamId'],
    );
    expect(matchInsert.values).toHaveBeenCalledWith(expect.objectContaining({
      matchId: 'm1', localSteamId: '765', localHeroId: 5, kills: 4,
    }));
    expect(matchInsert.orUpdate).toHaveBeenCalledWith(
      ['localSteamId', 'localHeroId', 'kills', 'deaths', 'assists', 'souls', 'durationSec',
        'players', 'lastEventAt', 'updatedAt'],
      ['matchId'],
    );
  });

  it('keeps startedAt from the first batch and advances lastEventAt on later batches', async () => {
    const { service, users, matches } = makeService();
    // The service upserts the user row before the match row, so the users
    // repository needs a working chain for the match insert to be reached.
    users.createQueryBuilder.mockReturnValue({
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orUpdate: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue(undefined),
    });
    const insert = {
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orUpdate: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue(undefined),
    };
    matches.createQueryBuilder.mockReturnValue(insert);

    await service.applyBatch(rosterBatch('m2', '765'));
    const first = insert.values.mock.calls[0][0];
    await new Promise((resolve) => setTimeout(resolve, 5));
    await service.applyBatch(rosterBatch('m2', '765'));
    const second = insert.values.mock.calls[1][0];

    expect(second.startedAt.getTime()).toBe(first.startedAt.getTime());
    expect(second.lastEventAt.getTime()).toBeGreaterThan(first.lastEventAt.getTime());
  });

  it('swallows projection misses (no local player) without touching the DB', async () => {
    const { service, users, matches } = makeService();
    await service.applyBatch({ clientId: 'c', events: [{ receivedAt: 1, source: 'onInfoUpdates2', key: 'x', payload: 1 }] });
    expect(users.createQueryBuilder).not.toHaveBeenCalled();
    expect(matches.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('never throws when the DB fails — resolves instead', async () => {
    const { service, users, matches } = makeService();
    // The DB failure surfaces at `execute` — the step that actually hits the DB.
    matches.createQueryBuilder.mockReturnValue({
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orUpdate: jest.fn().mockReturnThis(),
      execute: jest.fn().mockRejectedValue(new Error('db down')),
    });
    users.createQueryBuilder.mockReturnValue({
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orUpdate: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue(undefined),
    });
    await expect(service.applyBatch(rosterBatch('m3', '765'))).resolves.toBeUndefined();
  });
});
