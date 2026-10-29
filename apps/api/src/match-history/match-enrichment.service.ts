import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import axios from 'axios';
import { Brackets, QueryDeepPartialEntity, Repository } from 'typeorm';
import { getDeadlockApiRequestConfig } from '../deadlock-live/deadlock-api-request';
import { MatchHistoryV1Entity } from './entities/match-history-v1.entity';

const API_BASE = 'https://api.deadlock-api.com';
const MAX_PER_TICK = 20;
const MAX_ATTEMPTS = 8;
const NOT_FOUND_WINDOW_MS = 7 * 24 * 3600 * 1000;
const MIN_AGE_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;

function httpStatus(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'response' in error) {
    const response = (error as { response?: { status?: number } }).response;
    return response?.status;
  }
  return undefined;
}

/** Metadata ids come back as JSON numbers; candidate ids are stored strings. */
function metadataMatchId(entry: unknown): string | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const id = (entry as { match_id?: unknown }).match_id;
  if (typeof id === 'number') return String(id);
  if (typeof id === 'string') return id;
  return undefined;
}

@Injectable()
export class MatchEnrichmentService {
  private readonly logger = new Logger('MatchEnrichmentService');
  private running = false;

  constructor(
    @InjectRepository(MatchHistoryV1Entity)
    private readonly matches: Repository<MatchHistoryV1Entity>,
  ) {}

  @Cron('*/15 * * * *')
  async enrichPending(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const candidates = await this.matches
        .createQueryBuilder('m')
        .where(new Brackets((qb) => {
          qb.where('m."enrichmentStatus" = :pending', { pending: 'PENDING' })
            .orWhere('(m."enrichmentStatus" = :failed and m."enrichmentAttempts" < :maxAttempts)', {
              failed: 'FAILED', maxAttempts: MAX_ATTEMPTS,
            })
            .orWhere('(m."enrichmentStatus" = :notFound and m."lastEventAt" > :cutoff)', {
              notFound: 'NOT_FOUND', cutoff: new Date(Date.now() - NOT_FOUND_WINDOW_MS),
            });
        }))
        .andWhere('m."lastEventAt" < :minAge', { minAge: new Date(Date.now() - MIN_AGE_MS) })
        .orderBy('m."lastEventAt"', 'ASC')
        .take(MAX_PER_TICK)
        .getMany();

      if (candidates.length > 0) {
        await this.enrichBatch(candidates);
      }
    } catch (error) {
      this.logger.warn(`Match enrichment tick failed: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * One batched request per tick against the metadata endpoint. The per-match
   * `/v1/matches/{matchId}` endpoint 404s for regular GEP matches (probe
   * verified in production), so it is not usable here; `/v1/matches/metadata`
   * answers for the ids it knows and 404s as a whole when it knows none.
   */
  private async enrichBatch(candidates: MatchHistoryV1Entity[]): Promise<void> {
    const ids = candidates.map((match) => encodeURIComponent(match.matchId)).join(',');
    const url = `${API_BASE}/v1/matches/metadata?match_ids=${ids}`;
    const keyConfig = getDeadlockApiRequestConfig();
    let entries: unknown;
    try {
      const response = await axios.get(url, { ...keyConfig, timeout: FETCH_TIMEOUT_MS });
      entries = response.data;
    } catch (error) {
      const status = httpStatus(error);
      if ((status === 401 || status === 403) && keyConfig.headers) {
        try {
          const response = await axios.get(url, { timeout: FETCH_TIMEOUT_MS });
          entries = response.data;
        } catch (fallbackError) {
          return this.storeBatchFailure(candidates, httpStatus(fallbackError));
        }
      } else {
        return this.storeBatchFailure(candidates, status);
      }
    }
    if (!Array.isArray(entries)) {
      return this.storeBatchFailure(candidates, undefined);
    }
    await this.storeBatchResults(candidates, entries);
  }

  private async storeBatchResults(candidates: MatchHistoryV1Entity[], entries: unknown[]): Promise<void> {
    const metadata = new Map(entries.map((entry) => [metadataMatchId(entry), entry]));
    for (const match of candidates) {
      const entry = metadata.get(match.matchId);
      try {
        if (entry) {
          await this.store(match, 'DONE', entry);
        } else {
          // Absent from the answer (including sanitized non-digit ids sent
          // as-is) means the official API does not know the match yet.
          await this.matches.update(match.matchId, { enrichmentStatus: 'NOT_FOUND', updatedAt: new Date() });
        }
      } catch (error) {
        this.logger.warn(`Match enrichment ${match.matchId} update failed: ${String(error)}`);
      }
    }
  }

  private async storeBatchFailure(candidates: MatchHistoryV1Entity[], status: number | undefined): Promise<void> {
    if (status === 404) {
      // Whole-request 404 ("No matches found") means none of the ids exist
      // upstream yet — NOT_FOUND keeps the 7-day re-try window per match.
      for (const match of candidates) {
        try {
          await this.matches.update(match.matchId, { enrichmentStatus: 'NOT_FOUND', updatedAt: new Date() });
        } catch (error) {
          this.logger.warn(`Match enrichment ${match.matchId} update failed: ${String(error)}`);
        }
      }
      return;
    }
    for (const match of candidates) {
      try {
        await this.matches.update(match.matchId, {
          enrichmentStatus: 'FAILED',
          enrichmentAttempts: match.enrichmentAttempts + 1,
          updatedAt: new Date(),
        });
      } catch (error) {
        this.logger.warn(`Match enrichment ${match.matchId} update failed: ${String(error)}`);
      }
    }
    this.logger.warn(
      `Match enrichment batch failed with status ${status ?? 'network'} (${candidates.length} candidates)`,
    );
  }

  private async store(match: MatchHistoryV1Entity, status: 'DONE', enrichment: unknown): Promise<void> {
    await this.matches.update(match.matchId, {
      enrichmentStatus: status,
      enrichmentFetchedAt: new Date(),
      enrichment: enrichment as Record<string, unknown>,
      updatedAt: new Date(),
    } as QueryDeepPartialEntity<MatchHistoryV1Entity>);
  }
}
