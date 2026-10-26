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
const INTER_REQUEST_DELAY_MS = 250;

function httpStatus(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'response' in error) {
    const response = (error as { response?: { status?: number } }).response;
    return response?.status;
  }
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

      for (const match of candidates) {
        await this.fetchAndStore(match);
        await new Promise((resolve) => setTimeout(resolve, INTER_REQUEST_DELAY_MS));
      }
    } catch (error) {
      this.logger.warn(`Match enrichment tick failed: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }

  async fetchAndStore(match: MatchHistoryV1Entity): Promise<void> {
    const url = `${API_BASE}/v1/matches/${encodeURIComponent(match.matchId)}`;
    const keyConfig = getDeadlockApiRequestConfig();
    try {
      const response = await axios.get(url, { ...keyConfig, timeout: FETCH_TIMEOUT_MS });
      await this.store(match, 'DONE', response.data);
    } catch (error) {
      const status = httpStatus(error);
      if ((status === 401 || status === 403) && keyConfig.headers) {
        try {
          const response = await axios.get(url, { timeout: FETCH_TIMEOUT_MS });
          await this.store(match, 'DONE', response.data);
          return;
        } catch (fallbackError) {
          return this.storeFailure(match, httpStatus(fallbackError));
        }
      }
      await this.storeFailure(match, status);
    }
  }

  private async store(match: MatchHistoryV1Entity, status: 'DONE', enrichment: unknown): Promise<void> {
    await this.matches.update(match.matchId, {
      enrichmentStatus: status,
      enrichmentFetchedAt: new Date(),
      enrichment: enrichment as Record<string, unknown>,
      updatedAt: new Date(),
    } as QueryDeepPartialEntity<MatchHistoryV1Entity>);
  }

  private async storeFailure(match: MatchHistoryV1Entity, status: number | undefined): Promise<void> {
    if (status === 404) {
      await this.matches.update(match.matchId, { enrichmentStatus: 'NOT_FOUND', updatedAt: new Date() });
      return;
    }
    await this.matches.update(match.matchId, {
      enrichmentStatus: 'FAILED',
      enrichmentAttempts: match.enrichmentAttempts + 1,
      updatedAt: new Date(),
    });
    this.logger.warn(`Match enrichment ${match.matchId} failed with status ${status ?? 'network'}`);
  }
}
