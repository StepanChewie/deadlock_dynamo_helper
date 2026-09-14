import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { AdaptiveRecommendationResultV2 } from '@deadlock-live-probe/shared';
import { AdaptiveBuildIterationV1Entity } from '../deadlock-live/entities/adaptive-build-iteration-v1.entity';
import { BuildIterationCaptureV1 } from './build-iteration-capture-v1';
import {
  blockerFingerprintV1,
  boundRejectsForStorageV1,
  extractRejectsV1,
  planFingerprintV1,
  projectPlanForStorageV1,
} from './build-iteration-fingerprint-v1';

const DEFAULT_MAX_JSON_KB = 64;
const DEFAULT_CLEANUP_PASS_LIMIT = 5000;
const MAX_CLEANUP_PASSES = 20;
const BUILD_ITERATION_TABLE = 'adaptive_build_iterations_v1';

export interface RecordBuildIterationV1Input {
  matchId: string;
  steamId: string;
  result: AdaptiveRecommendationResultV2;
  capture?: BuildIterationCaptureV1;
}

@Injectable()
export class BuildIterationHistoryV1Service {
  private readonly logger = new Logger(BuildIterationHistoryV1Service.name);
  private readonly maxJsonBytes = readPositiveInteger(process.env.ADAPTIVE_BUILD_ITERATION_MAX_JSON_KB, DEFAULT_MAX_JSON_KB) * 1024;

  /**
   * Last state written for a (matchId, steamId) key in this process. Keeps the
   * previous-state lookup at one SELECT per key; after a restart the lookup
   * re-hydrates from the table instead.
   */
  private readonly lastWritten = new Map<
    string,
    { kind: 'PLAN' | 'NOT_READY'; fingerprint: string }
  >();

  constructor(
    @InjectRepository(AdaptiveBuildIterationV1Entity)
    private readonly repository: Repository<AdaptiveBuildIterationV1Entity>,
  ) {}

  async record(input: RecordBuildIterationV1Input): Promise<void> {
    try {
      const row = this.buildRow(input);
      const steamId = row.steamId as string;
      const kind = row.kind as 'PLAN' | 'NOT_READY';
      const fingerprint = row.fingerprint as string;
      const key = `${input.matchId}|${steamId}`;
      const last = this.lastWritten.get(key) ?? (await this.readLastWritten(input.matchId, steamId));
      const unchanged = last !== undefined && last.kind === kind && last.fingerprint === fingerprint;
      if (unchanged) return;

      await this.repository
        .createQueryBuilder()
        .insert()
        .into(AdaptiveBuildIterationV1Entity)
        .values(row)
        .execute();

      this.lastWritten.set(key, { kind, fingerprint });
    } catch (error) {
      this.logger.warn(`Build iteration history write failed: ${describeError(error)}`);
    }
  }

  private async readLastWritten(
    matchId: string,
    steamId: string,
  ): Promise<{ kind: 'PLAN' | 'NOT_READY'; fingerprint: string } | undefined> {
    const last = await this.repository.findOne({
      where: { matchId, steamId },
      order: { id: 'DESC' },
    });
    return last ? { kind: last.kind, fingerprint: last.fingerprint } : undefined;
  }

  @Cron('0 * * * *')
  async cleanupExpired(passLimit = DEFAULT_CLEANUP_PASS_LIMIT): Promise<number> {
    const days = readPositiveInteger(process.env.ADAPTIVE_BUILD_ITERATION_TTL_DAYS, 30);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const limit = readPositiveInteger(String(passLimit), DEFAULT_CLEANUP_PASS_LIMIT);
    let deleted = 0;
    try {
      for (let pass = 0; pass < MAX_CLEANUP_PASSES; pass += 1) {
        const result = await this.repository
          .createQueryBuilder()
          .delete()
          .from(AdaptiveBuildIterationV1Entity)
          .where('pinned = false')
          .andWhere({ capturedAt: LessThan(cutoff) })
          .andWhere(
            `id IN (SELECT id FROM ${BUILD_ITERATION_TABLE} WHERE pinned = false AND "capturedAt" < :cutoff LIMIT :passLimit)`,
          )
          .setParameters({ cutoff, passLimit: limit })
          .execute();
        const affected = result.affected ?? 0;
        deleted += affected;
        if (affected < limit) break;
      }
      return deleted;
    } catch (error) {
      this.logger.warn(`Build iteration history cleanup failed: ${describeError(error)}`);
      return deleted;
    }
  }

  private buildRow(input: RecordBuildIterationV1Input): Record<string, unknown> {
    const { result, capture } = input;
    const steamId = (capture?.steamId ?? input.steamId).slice(0, 32);
    const steps = result.fullBuild?.steps ?? [];
    const blockers = [...(result.blockers ?? [])].sort();
    const captureStages = capture?.stages ?? [];

    const plan = result.fullBuild
      ? projectPlanForStorageV1(result.fullBuild, this.maxJsonBytes)
      : { payload: null, truncated: false };
    const rejects = boundRejectsForStorageV1(extractRejectsV1(captureStages), this.maxJsonBytes);

    return {
      matchId: input.matchId,
      steamId,
      heroId: capture?.heroId ?? result.heroId ?? null,
      gameTimeSec: capture?.gameTimeSec ?? null,
      kind: result.ready ? 'PLAN' : 'NOT_READY',
      fingerprint: result.ready ? planFingerprintV1(steps) : blockerFingerprintV1(blockers),
      stateRevision: result.stateRevision.slice(0, 64),
      plan: plan.payload,
      rejects: rejects.payload,
      archetype: capture?.archetype ? { ...capture.archetype } : null,
      score: { ...(result.score ?? { total: 0, confidence: 0 }) },
      evidence: buildEvidencePayload(result, capture),
      context: buildContextPayload(capture),
      blockers: result.ready ? null : blockers,
      truncated: plan.truncated || rejects.truncated,
      pinned: false,
      capturedAt: new Date(),
    };
  }
}

function buildEvidencePayload(
  result: AdaptiveRecommendationResultV2,
  capture?: BuildIterationCaptureV1,
): Record<string, unknown> {
  const summary = capture?.evidence ?? result.evidence;
  if (!summary) return { families: [], degradedReasons: [...(result.degradedReasons ?? [])] };
  return {
    rulesetVersion: summary.rulesetVersion,
    catalogSha256: summary.catalogSha256,
    statlockerPatchId: summary.statlockerPatchId,
    sourceProfileCount: summary.sourceProfileCount,
    families: summary.families.map((family) => ({
      dataset: family.dataset,
      available: family.available,
      rowCount: family.rowCount ?? null,
      reasonCodes: [...family.reasonCodes],
    })),
    degradedReasons: [...(summary.degradedReasons ?? [])],
  };
}

function buildContextPayload(capture?: BuildIterationCaptureV1): Record<string, unknown> {
  return {
    capacity: capture?.capacity ?? null,
    inventoryItemIds: [...(capture?.inventoryItemIds ?? [])],
    spendableSouls: typeof capture?.spendableSouls === 'number' ? capture.spendableSouls : null,
    enemyHeroIds: [...(capture?.enemyHeroIds ?? [])],
    enemyThreats: (capture?.enemyThreats ?? []).map((threat) => ({
      heroId: threat.heroId,
      threatMultiplier: threat.threatMultiplier,
      completeness: threat.completeness,
      reasonCodes: [...threat.reasonCodes],
    })),
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readPositiveInteger(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
