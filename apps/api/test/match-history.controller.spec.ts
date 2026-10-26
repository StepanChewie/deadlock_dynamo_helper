import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { MatchHistoryController } from '../src/match-history/match-history.controller';
import { AppUserV1Entity } from '../src/match-history/entities/app-user-v1.entity';
import { MatchHistoryV1Entity } from '../src/match-history/entities/match-history-v1.entity';

function makeController() {
  const users = {
    createQueryBuilder: jest.fn().mockReturnThis(),
    query: jest.fn().mockReturnThis(),
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getRawAndEntities: jest.fn().mockResolvedValue({ raw: [], entities: [] }),
  };
  const matches = {
    findOne: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
  };
  const controller = new MatchHistoryController(
    users as unknown as Repository<AppUserV1Entity>,
    matches as unknown as Repository<MatchHistoryV1Entity>,
  );
  return { controller, users, matches };
}

describe('MatchHistoryController', () => {
  it('lists users with match counts, newest activity first', async () => {
    const { controller, users } = makeController();
    users.getRawAndEntities.mockResolvedValue({
      raw: [{ steamId: '765', playerName: 'me', matchCount: '3' }],
      entities: [{ steamId: '765', playerName: 'me' } as AppUserV1Entity],
    });
    const result = await controller.listUsers();
    expect(result.users).toEqual([{ steamId: '765', playerName: 'me', matchCount: 3 }]);
  });

  it('lists a user\'s matches newest first with a clamped limit', async () => {
    const { controller, matches } = makeController();
    await controller.userMatches('765', '9999');
    expect(matches.find).toHaveBeenCalledWith({
      where: { localSteamId: '765' },
      order: { startedAt: 'DESC' },
      take: 200,
    });
  });

  it('rejects a non-numeric limit with 400', async () => {
    const { controller } = makeController();
    await expect(controller.userMatches('765', 'abc')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('404s an unknown match', async () => {
    const { controller, matches } = makeController();
    matches.findOne.mockResolvedValue(null);
    await expect(controller.matchDetail('nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});
