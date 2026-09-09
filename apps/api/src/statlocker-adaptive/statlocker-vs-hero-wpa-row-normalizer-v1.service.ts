import { Injectable } from '@nestjs/common';
import {
  HERO_REFERENCE_SEED,
  ITEM_REFERENCE_SEED,
} from '../deadlock-live/reference-data.seed';
import { StatlockerVsHeroWpaRowV1Entity } from '../deadlock-live/entities/statlocker-vs-hero-wpa-row-v1.entity';

export interface StatlockerVsHeroWpaRowIdentityV1 {
  snapshotId: string;
  statlockerPatchId: string;
  rulesetVersion: string;
  catalogSha256: string;
}

export type NormalizedStatlockerVsHeroWpaRowV1 = Omit<StatlockerVsHeroWpaRowV1Entity, 'id'>;

export class StatlockerVsHeroWpaRowNormalizationError extends Error {
  constructor(message: string) {
    super(`VS_HERO_WPA relational rows: ${message}`);
    this.name = 'StatlockerVsHeroWpaRowNormalizationError';
  }
}

@Injectable()
export class StatlockerVsHeroWpaRowNormalizerV1Service {
  normalize(
    raw: unknown,
    identity: StatlockerVsHeroWpaRowIdentityV1,
  ): NormalizedStatlockerVsHeroWpaRowV1[] {
    const root = requireRecord(raw, 'root');
    const byPatch = requireRecord(root.by_patch, 'by_patch');
    const patchKey = `patch_${identity.statlockerPatchId}`;
    const patch = requireRecord(byPatch[patchKey] ?? byPatch[identity.statlockerPatchId], patchKey);
    const byRank = requireRecord(patch.by_rank, 'by_rank');
    const rows: NormalizedStatlockerVsHeroWpaRowV1[] = [];

    for (const [rankBucket, rawRank] of Object.entries(byRank).sort(([a], [b]) => a.localeCompare(b))) {
      const rank = optionalRecord(rawRank);
      const byHero = optionalRecord(rank?.by_hero);
      if (!byHero) continue;

      for (const [heroName, rawItems] of Object.entries(byHero).sort(([a], [b]) => a.localeCompare(b))) {
        const heroId = resolveReferenceId(heroName, HERO_ID_BY_NAME);
        const byItem = optionalRecord(rawItems);
        if (!heroId || !byItem) continue;

        for (const [itemName, rawMatchups] of Object.entries(byItem).sort(([a], [b]) => a.localeCompare(b))) {
          const itemId = resolveReferenceId(itemName, ITEM_ID_BY_NAME);
          const matchups = optionalRecord(rawMatchups);
          if (!itemId || !matchups) continue;

          for (const [enemyName, rawMatchup] of Object.entries(matchups).sort(([a], [b]) => a.localeCompare(b))) {
            if (enemyName === '_baseline') continue;
            const enemyHeroId = resolveReferenceId(enemyName, HERO_ID_BY_NAME);
            const matchup = optionalRecord(rawMatchup);
            if (!enemyHeroId || !matchup) continue;

            const count = positiveInteger(matchup.count ?? matchup.sample_size);
            const deltaWpa = finiteNumber(matchup.delta_wpa ?? matchup.deltaWpa);
            if (count === undefined || deltaWpa === undefined) continue;

            const meanWpa = finiteNumber(matchup.mean_wpa ?? matchup.meanWpa);
            rows.push({
              snapshotId: identity.snapshotId,
              statlockerPatchId: identity.statlockerPatchId,
              rulesetVersion: identity.rulesetVersion,
              catalogSha256: identity.catalogSha256.toLowerCase(),
              rankBucket,
              heroId,
              enemyHeroId,
              itemId,
              count,
              deltaWpa,
              ...(meanWpa !== undefined ? { meanWpa } : {}),
            });
          }
        }
      }
    }

    rows.sort((a, b) =>
      a.heroId - b.heroId ||
      a.enemyHeroId - b.enemyHeroId ||
      a.itemId - b.itemId ||
      a.rankBucket.localeCompare(b.rankBucket),
    );
    return rows;
  }
}

const HERO_ID_BY_NAME = buildReferenceIdMap(
  HERO_REFERENCE_SEED.map((hero) => ({ id: hero.hero_id, name: hero.name })),
);
const ITEM_ID_BY_NAME = buildReferenceIdMap(
  ITEM_REFERENCE_SEED.map((item) => ({ id: item.itemId, name: item.name })),
);

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  const record = optionalRecord(value);
  if (!record) throw new StatlockerVsHeroWpaRowNormalizationError(`${label} must be an object`);
  return record;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function buildReferenceIdMap(rows: readonly { id: number; name: string }[]): ReadonlyMap<string, number> {
  const result = new Map<string, number>();
  for (const row of rows) {
    const key = normalizeReferenceName(row.name);
    if (!result.has(key)) result.set(key, row.id);
  }
  return result;
}

function resolveReferenceId(value: string, ids: ReadonlyMap<string, number>): number | undefined {
  return ids.get(normalizeReferenceName(value));
}

function normalizeReferenceName(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
