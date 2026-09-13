import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { RawMatchMetadata } from './entities/raw-match-metadata.entity';
import {
  RAW_MATCH_METADATA_NORMALIZATION_VERSION,
  RawMatchMetadataNormalizationResult,
  RawMatchMetadataNormalizerService,
} from './raw-match-metadata-normalizer.service';
import {
  MATCH_METADATA_PROCESSING_VERSION,
  StoredMatchReprocessingResult,
  StoredMatchReprocessingService,
} from './stored-match-reprocessing.service';

const DEFAULT_REPLAY_LIMIT = 25;
const MAX_REPLAY_LIMIT = 250;

export class ReplayHistoricalMatchesDto {
  limit?: number;
  afterMatchId?: number;
  force?: boolean;
  resolveRuleset?: boolean;
}

export interface HistoricalMatchReplayEntry {
  status: 'replayed' | 'skipped' | 'failed';
  matchId: number;
  rawMetadataId: number;
  normalization?: RawMatchMetadataNormalizationResult;
  reprocessing?: StoredMatchReprocessingResult;
  error?: string;
}

@Injectable()
export class HistoricalMatchReplayService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(RawMatchMetadata)
    private readonly rawMetadataRepository: Repository<RawMatchMetadata>,
    private readonly rawMatchMetadataNormalizerService: RawMatchMetadataNormalizerService,
    private readonly storedMatchReprocessingService: StoredMatchReprocessingService,
  ) {}

  async replayPending(dto: ReplayHistoricalMatchesDto = {}) {
    const limit = normalizeReplayLimit(dto.limit);
    const afterMatchId = normalizeReplayCursor(dto.afterMatchId);
    const query = this.rawMetadataRepository
      .createQueryBuilder('raw')
      .distinctOn(['raw.matchId'])
      .where('raw.matchId > :afterMatchId', { afterMatchId })
      .orderBy('raw.matchId', 'ASC')
      .addOrderBy('raw.fetchedAt', 'DESC')
      .addOrderBy('raw.id', 'DESC')
      .take(limit);
    const rows = await query.getMany();
    const results: HistoricalMatchReplayEntry[] = [];

    for (const row of rows) {
      const matchId = Number(row.matchId);
      if (dto.force !== true && !shouldReplayHistoricalRow(row)) {
        results.push({
          status: 'skipped',
          matchId,
          rawMetadataId: row.id,
        });
        continue;
      }

      try {
        const normalization =
          await this.rawMatchMetadataNormalizerService.normalizeRawMetadata(row, false);
        const reprocessing =
          await this.storedMatchReprocessingService.reprocessRawMetadata(row);
        results.push({
          status: 'replayed',
          matchId,
          rawMetadataId: row.id,
          normalization,
          reprocessing,
        });
      } catch (error) {
        results.push({
          status: 'failed',
          matchId,
          rawMetadataId: row.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      requestedLimit: limit,
      processed: results.length,
      replayed: results.filter((entry) => entry.status === 'replayed').length,
      skipped: results.filter((entry) => entry.status === 'skipped').length,
      failed: results.filter((entry) => entry.status === 'failed').length,
      nextAfterMatchId:
        rows.length > 0 ? Number(rows[rows.length - 1].matchId) : afterMatchId,
      hasMore: rows.length === limit,
      normalizationVersion: RAW_MATCH_METADATA_NORMALIZATION_VERSION,
      processingVersion: MATCH_METADATA_PROCESSING_VERSION,
      rulesetResolutionUsed: false,
      results,
    };
  }

  async getStatus() {
    const rows = await this.dataSource.query(
      `
        WITH latest AS (
          SELECT DISTINCT ON ("matchId")
            "id",
            "matchId",
            "normalizationVersion",
            "processingVersion",
            "normalizedAt",
            "lastProcessedAt"
          FROM "raw_match_metadata"
          ORDER BY "matchId" ASC, "fetchedAt" DESC, "id" DESC
        )
        SELECT
          (SELECT COUNT(*) FROM "raw_match_metadata") AS "rawRows",
          COUNT(*) AS "latestMatches",
          COUNT(*) FILTER (
            WHERE "normalizationVersion" = $1
          ) AS "normalizedLatestMatches",
          COUNT(*) FILTER (
            WHERE "processingVersion" = $2
          ) AS "replayedLatestMatches",
          COUNT(*) FILTER (
            WHERE "processingVersion" IS DISTINCT FROM $2
          ) AS "pendingLatestMatches",
          MAX("normalizedAt") AS "lastNormalizedAt",
          MAX("lastProcessedAt") AS "lastProcessedAt"
        FROM latest
      `,
      [RAW_MATCH_METADATA_NORMALIZATION_VERSION, MATCH_METADATA_PROCESSING_VERSION],
    );
    const row = rows[0] ?? {};

    return {
      rawRows: toCount(row.rawRows),
      latestMatches: toCount(row.latestMatches),
      normalizedLatestMatches: toCount(row.normalizedLatestMatches),
      replayedLatestMatches: toCount(row.replayedLatestMatches),
      pendingLatestMatches: toCount(row.pendingLatestMatches),
      lastNormalizedAt: row.lastNormalizedAt,
      lastProcessedAt: row.lastProcessedAt,
      normalizationVersion: RAW_MATCH_METADATA_NORMALIZATION_VERSION,
      processingVersion: MATCH_METADATA_PROCESSING_VERSION,
      rulesetResolutionUsed: false,
    };
  }
}

export function shouldReplayHistoricalRow(rawMetadata: RawMatchMetadata): boolean {
  return rawMetadata.processingVersion !== MATCH_METADATA_PROCESSING_VERSION;
}

export function normalizeReplayLimit(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0) {
    return DEFAULT_REPLAY_LIMIT;
  }
  return Math.min(value, MAX_REPLAY_LIMIT);
}

function normalizeReplayCursor(value: number | undefined): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function toCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
