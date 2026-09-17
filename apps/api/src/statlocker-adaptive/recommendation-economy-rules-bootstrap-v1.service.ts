import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RecommendationItemCatalogVersionV1 } from '../deadlock-live/entities/recommendation-item-catalog-version-v1.entity';
import { RecommendationEconomyRulesV1, createCanonicalEconomyRulesV1 } from './adaptive-economy-v1';
import {
  PublishRecommendationEconomyRulesV1Input,
  RecommendationEconomyRulesStoreV1Service,
} from './recommendation-economy-rules-store-v1.service';

export interface RecommendationEconomyRulesBootstrapStatusV1 {
  bootstrapEconomyRulesCount: number;
  lastError?: string;
}

interface EconomyRulesBootstrapEntryV1 {
  snapshotId: string;
  source: string;
  verifiedAt?: string;
  rules: RecommendationEconomyRulesV1;
}

/**
 * Bootstraps verified economy rules into RecommendationEconomyRulesStoreV1Service.
 *
 * Sources, in order:
 *  1. ADAPTIVE_ECONOMY_RULES_JSON (operator-verified rules pinned to a ruleset
 *     version + catalog sha256);
 *  2. canonical rules auto-generated from the latest imported catalog versions.
 *
 * The live v2 adaptive decision state resolves these rules exactly by
 * (rulesetId, catalogSha256); without a published entry it would silently fall
 * back to canonical slot rules and lose the verified upgrade pricing policy.
 */
@Injectable()
export class RecommendationEconomyRulesBootstrapV1Service implements OnModuleInit {
  private readonly logger = new Logger(RecommendationEconomyRulesBootstrapV1Service.name);
  private bootstrapEconomyRulesCount = 0;
  private lastError?: string;

  constructor(
    @InjectRepository(RecommendationItemCatalogVersionV1)
    private readonly versionRepo: Repository<RecommendationItemCatalogVersionV1>,
    private readonly economyRulesStore: RecommendationEconomyRulesStoreV1Service,
  ) {}

  async onModuleInit(): Promise<void> {
    const entries = parseEconomyBootstrap(process.env.ADAPTIVE_ECONOMY_RULES_JSON);
    for (const entry of entries) {
      await this.publishEconomyRules({
        snapshotId: entry.snapshotId,
        source: entry.source,
        verifiedAt: entry.verifiedAt ? parseDate(entry.verifiedAt) : undefined,
        rules: entry.rules,
      });
      this.bootstrapEconomyRulesCount += 1;
    }

    // This loop must run even when ADAPTIVE_ECONOMY_RULES_JSON supplied entries.
    //
    // Those entries are pinned to one (rulesetKey, payloadSha256) pair each, so
    // they cover the catalog that existed when the operator wrote them and
    // nothing else. Gating this on `bootstrapEconomyRulesCount === 0` meant that
    // the moment an operator pinned anything by hand, no later catalog import
    // ever received rules - and the live decision state resolves them exactly by
    // (rulesetId, catalogSha256), so `resolveExact` returned undefined for the
    // new catalog and the verified upgrade pricing policy was silently lost.
    //
    // The consequence is not subtle. Without an upgrade pricing policy the
    // compiler cannot derive a recipe's soul cost, and a recipe whose cost is
    // unknown is dropped from the item graph entirely. Every progression path
    // then becomes unexecutable: on 2026-09-17 the full build stopped after four
    // family entry purchases and the app answered REQUIRED_FAMILY_UNSATISFIED
    // for the rest of the match. Catalog 6694 was imported on 2026-09-16 and had
    // no matching economy snapshot at all.
    //
    // Running it unconditionally is safe: the resolveExact check below publishes
    // only for versions that have no entry yet, so this stays idempotent.
    if (this.versionRepo?.find) {
      try {
        const versions = await this.versionRepo.find({
          order: { importedAt: 'DESC' },
          take: 5,
        });
        for (const version of versions) {
          if (!version.rulesetKey || !version.payloadSha256) continue;
          const existing = await this.economyRulesStore.resolveExact(
            version.rulesetKey,
            version.payloadSha256,
          );
          // Only a version with no entry at all is published.
          //
          // Replacing an existing entry was tried and does not work from here:
          // resolveExact parses the payload column and does not return `source`,
          // which lives in its own column, so there is no way to tell our own
          // canonical row from an operator's. It is also unnecessary - the
          // generator now always writes the pricing policy, so a catalog
          // imported from here on gets a usable entry the first time.
          if (existing) continue;

          await this.publishEconomyRules({
            snapshotId: `canonical:${version.rulesetKey}:${version.payloadSha256.slice(0, 16)}`,
            source: 'canonical-deadlock-universal-v1',
            verifiedAt: new Date(),
            rules: createCanonicalEconomyRulesV1(version.rulesetKey, version.payloadSha256),
          });
          this.bootstrapEconomyRulesCount += 1;
        }
      } catch (error) {
        this.lastError = describeError(error);
        this.logger.warn(`Failed to auto-bootstrap canonical economy rules: ${describeError(error)}`);
      }
    }
  }

  async publishEconomyRules(input: PublishRecommendationEconomyRulesV1Input): Promise<void> {
    await this.economyRulesStore.publish(input);
  }

  getStatus(): RecommendationEconomyRulesBootstrapStatusV1 {
    return {
      bootstrapEconomyRulesCount: this.bootstrapEconomyRulesCount,
      lastError: this.lastError,
    };
  }
}

function parseEconomyBootstrap(raw: string | undefined): EconomyRulesBootstrapEntryV1[] {
  if (!raw || raw.trim() === '') return [];
  const parsed = JSON.parse(raw) as unknown;
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  return entries.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.snapshotId !== 'string' || entry.snapshotId.trim() === '' ||
      typeof entry.source !== 'string' || entry.source.trim() === '' || !isRecord(entry.rules)) {
      throw new Error(`ADAPTIVE_ECONOMY_RULES_JSON entry ${index} is invalid`);
    }
    if (entry.verifiedAt !== undefined && typeof entry.verifiedAt !== 'string') {
      throw new Error(`ADAPTIVE_ECONOMY_RULES_JSON entry ${index} verifiedAt is invalid`);
    }
    return {
      snapshotId: entry.snapshotId,
      source: entry.source,
      verifiedAt: entry.verifiedAt,
      rules: entry.rules as unknown as RecommendationEconomyRulesV1,
    };
  });
}

function parseDate(value: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid economy verifiedAt: ${value}`);
  return date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
