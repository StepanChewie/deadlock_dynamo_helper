import { ConsoleLogger, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OverwolfLiveBatchDto } from '@dynamo-lab/shared';
import { AppUserV1Entity } from './entities/app-user-v1.entity';
import { MatchHistoryV1Entity } from './entities/match-history-v1.entity';
import { MatchHistoryProjection, projectMatchHistoryBatch } from './match-history-projection';

// ponytail: one in-memory accumulation per live match; a restart mid-match
// rebuilds from the next full roster snapshot GEP re-sends anyway.
const MAX_TRACKED_MATCHES = 200;

const MATCH_UPDATE_COLUMNS = [
  'localSteamId', 'localHeroId', 'kills', 'deaths', 'assists', 'souls', 'durationSec',
  'players', 'lastEventAt', 'updatedAt',
] as const;

@Injectable()
export class MatchHistoryService {
  private readonly logger = new Logger('MatchHistoryService');
  private readonly projections = new Map<string, { projection: MatchHistoryProjection; startedAt: Date }>();

  constructor(
    @InjectRepository(AppUserV1Entity)
    private readonly users: Repository<AppUserV1Entity>,
    @InjectRepository(MatchHistoryV1Entity)
    private readonly matches: Repository<MatchHistoryV1Entity>,
  ) {}

  async applyBatch(batch: OverwolfLiveBatchDto): Promise<void> {
    try {
      const previous = this.lastProjection(batch);
      const projection = projectMatchHistoryBatch(batch, previous);
      if (!projection) return;

      const existing = this.projections.get(projection.matchId);
      const startedAt = existing?.startedAt ?? new Date();
      const lastEventAt = new Date();
      this.remember(projection, startedAt);

      const local = projection.players.find((player) => player.steamId === projection.localSteamId);

      await this.users
        .createQueryBuilder()
        .insert()
        .into(AppUserV1Entity)
        .values({
          steamId: projection.localSteamId,
          playerName: local?.name ?? null,
          lastClientId: projection.clientId,
          // Brief's shorthand `firstSeenAt`/`lastSeenAt` had no matching
          // bindings in scope; bound to the two dates computed above.
          firstSeenAt: startedAt,
          lastSeenAt: lastEventAt,
        })
        .orUpdate(['playerName', 'lastClientId', 'lastSeenAt'], ['steamId'])
        .execute();

      await this.matches
        .createQueryBuilder()
        .insert()
        .into(MatchHistoryV1Entity)
        .values({
          matchId: projection.matchId,
          localSteamId: projection.localSteamId,
          localHeroId: local?.heroId ?? null,
          kills: local?.kills ?? null,
          deaths: local?.deaths ?? null,
          assists: local?.assists ?? null,
          souls: local?.souls !== undefined ? String(local.souls) : null,
          durationSec: projection.durationSec ?? null,
          players: projection.players,
          startedAt,
          lastEventAt,
          enrichmentStatus: 'PENDING',
          enrichmentAttempts: 0,
          createdAt: startedAt,
          updatedAt: lastEventAt,
        })
        .orUpdate([...MATCH_UPDATE_COLUMNS], ['matchId'])
        .execute();
    } catch (error) {
      this.logger.warn(`Match history projection failed: ${String(error)}`);
    }
  }

  private lastProjection(batch: OverwolfLiveBatchDto): MatchHistoryProjection | undefined {
    const matchId = batch.events.find((event) => event.matchId)?.matchId;
    if (!matchId) return undefined;
    return this.projections.get(matchId)?.projection;
  }

  private remember(projection: MatchHistoryProjection, startedAt: Date): void {
    if (this.projections.size >= MAX_TRACKED_MATCHES && !this.projections.has(projection.matchId)) {
      const oldest = this.projections.keys().next().value;
      if (oldest !== undefined) this.projections.delete(oldest);
    }
    this.projections.set(projection.matchId, { projection, startedAt });
  }
}
