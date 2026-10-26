import { BadRequestException, Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AppUserV1Entity } from './entities/app-user-v1.entity';
import { MatchHistoryV1Entity } from './entities/match-history-v1.entity';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

@Controller('deadlock/match-history')
export class MatchHistoryController {
  constructor(
    @InjectRepository(AppUserV1Entity)
    private readonly users: Repository<AppUserV1Entity>,
    @InjectRepository(MatchHistoryV1Entity)
    private readonly matches: Repository<MatchHistoryV1Entity>,
  ) {}

  @Get('users')
  async listUsers(): Promise<{ users: unknown[] }> {
    const { raw } = await this.users
      .createQueryBuilder('u')
      .addSelect('(select count(*) from match_history_v1 m where m."localSteamId" = u."steamId")', 'matchCount')
      .orderBy('u."lastSeenAt"', 'DESC')
      .getRawAndEntities();
    return {
      users: raw.map((row) => ({
        steamId: row.steamId ?? row.u_steamId,
        playerName: row.playerName ?? row.u_playerName,
        lastClientId: row.lastClientId ?? row.u_lastClientId,
        firstSeenAt: row.firstSeenAt ?? row.u_firstSeenAt,
        lastSeenAt: row.lastSeenAt ?? row.u_lastSeenAt,
        matchCount: Number(row.matchCount ?? 0),
      })),
    };
  }

  @Get('users/:steamId/matches')
  async userMatches(
    @Param('steamId') steamId: string,
    @Query('limit') limit?: string,
  ): Promise<{ matches: MatchHistoryV1Entity[] }> {
    let take = DEFAULT_LIMIT;
    if (limit !== undefined) {
      const parsed = Number.parseInt(limit, 10);
      if (Number.isNaN(parsed) || parsed <= 0) throw new BadRequestException('limit must be a positive integer');
      take = Math.min(parsed, MAX_LIMIT);
    }
    const matches = await this.matches.find({
      where: { localSteamId: steamId },
      order: { startedAt: 'DESC' },
      take,
    });
    return { matches };
  }

  @Get(':matchId')
  async matchDetail(@Param('matchId') matchId: string): Promise<MatchHistoryV1Entity> {
    const match = await this.matches.findOne({ where: { matchId } });
    if (!match) throw new NotFoundException(`unknown match ${matchId}`);
    return match;
  }
}
