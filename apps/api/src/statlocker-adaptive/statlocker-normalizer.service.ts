import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import {
  HERO_REFERENCE_SEED,
  ITEM_REFERENCE_SEED,
} from '../deadlock-live/reference-data.seed';
import {
  ConsensusBuildGroupTypeV1,
  ConsensusBuildPhaseV1,
  StatlockerFrequencyTierV1,
  StatlockerHeroItemLifecycleV1,
  StatlockerHeroLeaderboardV1,
  StatlockerNormalizedDatasetV1,
  StatlockerPatchControlV1,
  StatlockerProBuildAnalysisV1,
  StatlockerProBuildExplicitGroupV1,
  StatlockerProBuildItemV1,
  StatlockerT4ChainV1,
  StatlockerT4ChainsV1,
  StatlockerVsHeroItemV1,
  StatlockerVsHeroSliceV1,
  StatlockerVsHeroWpaV1,
  StatlockerWpaFilteredItemsV1,
  StatlockerWpaItemV1,
  StatlockerWpaPatchDataV1,
} from './statlocker-adaptive.types';

export class StatlockerDatasetValidationError extends Error {
  constructor(public readonly dataset: string, message: string) {
    super(`${dataset}: ${message}`);
    this.name = 'StatlockerDatasetValidationError';
  }
}

@Injectable()
export class StatlockerNormalizerService {
  normalizePatches(raw: unknown): StatlockerPatchControlV1 {
    if (Array.isArray(raw)) {
      const availableMinorPatchIds = [...new Set(raw.map((value) => {
        const row = requireRecord(value, 'WPA_PATCHES', 'patch');
        return requireString(row.minorPatchId ?? row.minor_patch_id ?? row.id, 'WPA_PATCHES', 'minor patch id');
      }))].sort();
      const currentMinorPatchId = requireString(
        requireRecord(raw[0], 'WPA_PATCHES', 'current patch').minorPatchId ??
          requireRecord(raw[0], 'WPA_PATCHES', 'current patch').minor_patch_id ??
          requireRecord(raw[0], 'WPA_PATCHES', 'current patch').id,
        'WPA_PATCHES',
        'current minor patch',
      );
      return { currentMinorPatchId, availableMinorPatchIds };
    }

    const root = requireRecord(raw, 'WPA_PATCHES', 'root');
    const current = requireString(root.current_minor_patch_id ?? root.currentMinorPatchId, 'WPA_PATCHES', 'current minor patch');
    const patches = requireArray(root.patches, 'WPA_PATCHES', 'patches')
      .map((value) => {
        const row = requireRecord(value, 'WPA_PATCHES', 'patch');
        return requireString(row.minor_patch_id ?? row.minorPatchId ?? row.id, 'WPA_PATCHES', 'minor patch id');
      });
    const availableMinorPatchIds = [...new Set([current, ...patches])].sort();
    return { currentMinorPatchId: current, availableMinorPatchIds };
  }

  normalizeWpaPatchData(raw: unknown, statlockerPatchId: string): StatlockerNormalizedDatasetV1<StatlockerWpaPatchDataV1> {
    const root = requireRecord(raw, 'WPA_PATCH_DATA', 'root');
    if (root.by_patch !== undefined) {
      const items = parseNestedWpaPatchData(root, statlockerPatchId);
      return wrap('WPA_PATCH_DATA', `patch:${statlockerPatchId}`, statlockerPatchId, {
        patchId: statlockerPatchId,
        items,
      });
    }
    const patchId = requireString(root.patch ?? root.patch_id ?? root.patchId, 'WPA_PATCH_DATA', 'patch');
    if (patchId !== statlockerPatchId) throw new StatlockerDatasetValidationError('WPA_PATCH_DATA', `patch mismatch ${patchId}`);
    const items = requireArray(root.items, 'WPA_PATCH_DATA', 'items').map((row) => parseWpaItem(row, 'WPA_PATCH_DATA'));
    if (items.length === 0) throw new StatlockerDatasetValidationError('WPA_PATCH_DATA', 'items must not be empty');
    items.sort((a, b) => a.heroId - b.heroId || a.itemId - b.itemId);
    return wrap('WPA_PATCH_DATA', `patch:${patchId}`, statlockerPatchId, { patchId, items });
  }

  normalizeVsHeroWpa(raw: unknown, statlockerPatchId: string): StatlockerNormalizedDatasetV1<StatlockerVsHeroWpaV1> {
    const root = requireRecord(raw, 'VS_HERO_WPA', 'root');
    if (root.by_patch !== undefined) {
      const slices = parseNestedVsHeroWpa(root, statlockerPatchId);
      return wrap('VS_HERO_WPA', 'global', statlockerPatchId, { slices });
    }
    const source = root.data ?? root.slices ?? root.matchups;
    const slices = requireArray(source, 'VS_HERO_WPA', 'data').map((row) => parseVsHeroSlice(row));
    if (slices.length === 0 || slices.every((slice) => slice.items.length === 0)) {
      throw new StatlockerDatasetValidationError('VS_HERO_WPA', 'primary exact-enemy data must not be empty');
    }
    slices.sort((a, b) => a.heroId - b.heroId || a.enemyHeroId - b.enemyHeroId);
    return wrap('VS_HERO_WPA', 'global', statlockerPatchId, { slices });
  }

  normalizeT4Chains(raw: unknown, statlockerPatchId: string): StatlockerNormalizedDatasetV1<StatlockerT4ChainsV1> {
    const root = requireRecord(raw, 'T4_CHAINS', 'root');
    const byHero = requireRecord(root.by_hero ?? root.byHero, 'T4_CHAINS', 'by_hero');
    const chains: StatlockerT4ChainV1[] = [];
    for (const [heroKey, rawChains] of Object.entries(byHero)) {
      const numericHeroId = Number(heroKey);
      const heroId = Number.isInteger(numericHeroId) && numericHeroId > 0
        ? numericHeroId
        : resolveReferenceId(heroKey, HERO_ID_BY_NAME);
      if (!heroId) continue;
      if (!Array.isArray(rawChains)) {
        const heroChains = requireRecord(rawChains, 'T4_CHAINS', `hero ${heroKey}`);
        for (const family of ['two_item_chains', 'three_item_chains']) {
          const expectedItemCount = family === 'two_item_chains' ? 2 : 3;
          for (const rawChain of requireArray(heroChains[family], 'T4_CHAINS', `${heroKey}.${family}`)) {
            const row = requireRecord(rawChain, 'T4_CHAINS', 'chain');
            const itemIds = requireArray(row.items, 'T4_CHAINS', 'items')
              .map((itemName) => resolveReferenceId(itemName, ITEM_ID_BY_NAME));
            if (itemIds.length !== expectedItemCount || itemIds.some((itemId) => itemId === undefined)) continue;
            const wpaMetrics = requireRecord(row.wpa_metrics, 'T4_CHAINS', 'wpa metrics');
            const chainTotal = requireRecord(wpaMetrics.chain_total, 'T4_CHAINS', 'chain total');
            chains.push({
              heroId,
              itemIds: itemIds as number[],
              sampleSize: parseNonNegativeFinite(row.sample_size ?? row.sampleSize, 'T4_CHAINS', 'sample size'),
              meanWpa: optionalFinite(chainTotal.mean_wpa ?? chainTotal.meanWpa, 'T4_CHAINS', 'mean wpa'),
            });
          }
        }
        continue;
      }
      for (const rawChain of rawChains) {
        const row = requireRecord(rawChain, 'T4_CHAINS', 'chain');
        const itemIds = requireArray(row.item_ids ?? row.itemIds, 'T4_CHAINS', 'item ids')
          .map((itemId) => parsePositiveInt(itemId, 'T4_CHAINS', 'item id'));
        if (itemIds.length !== 2 && itemIds.length !== 3) continue;
        chains.push({
          heroId,
          itemIds,
          sampleSize: parseNonNegativeFinite(row.sample_size ?? row.sampleSize, 'T4_CHAINS', 'sample size'),
          meanWpa: optionalFinite(row.mean_wpa ?? row.meanWpa, 'T4_CHAINS', 'mean wpa'),
        });
      }
    }
    if (chains.length === 0) throw new StatlockerDatasetValidationError('T4_CHAINS', 'no 2/3-item chains');
    chains.sort((a, b) => a.heroId - b.heroId || compareNumberArrays(a.itemIds, b.itemIds));
    return wrap('T4_CHAINS', 'global', statlockerPatchId, { chains });
  }

  normalizeHeroLeaderboard(
    raw: unknown,
    statlockerPatchId: string,
    heroId: number,
  ): StatlockerNormalizedDatasetV1<StatlockerHeroLeaderboardV1> {
    const root = requireRecord(raw, 'HERO_LEADERBOARD', 'root');
    const responseHeroId = optionalPositiveInt(root.hero_id ?? root.heroId, 'HERO_LEADERBOARD', 'hero id') ?? heroId;
    if (responseHeroId !== heroId) throw new StatlockerDatasetValidationError('HERO_LEADERBOARD', 'hero mismatch');
    const profiles = requireArray(root.leaderboard ?? root.players ?? root.data, 'HERO_LEADERBOARD', 'leaderboard')
      .map((value) => {
        const row = requireRecord(value, 'HERO_LEADERBOARD', 'profile');
        const steamProfile = isRecord(row.steamProfile) ? row.steamProfile : undefined;
        const rowHeroId = optionalPositiveInt(row.hero_id ?? row.heroId, 'HERO_LEADERBOARD', 'hero id');
        if (rowHeroId !== undefined && rowHeroId !== heroId) {
          throw new StatlockerDatasetValidationError('HERO_LEADERBOARD', 'hero mismatch');
        }
        return {
          accountId: requireIdentifierString(row.account_id ?? row.accountId, 'HERO_LEADERBOARD', 'account id'),
          heroId,
          rank: parsePositiveInt(row.rank, 'HERO_LEADERBOARD', 'rank'),
          playerName: optionalString(row.player_name ?? row.playerName ?? steamProfile?.name),
        };
      });
    if (profiles.length === 0) throw new StatlockerDatasetValidationError('HERO_LEADERBOARD', 'leaderboard must not be empty');
    profiles.sort((a, b) => a.rank - b.rank || a.accountId.localeCompare(b.accountId));
    return wrap('HERO_LEADERBOARD', `hero:${heroId}`, statlockerPatchId, { heroId, profiles });
  }

  normalizeProBuildAnalysis(
    raw: unknown,
    statlockerPatchId: string,
    accountId: string,
    heroId: number,
  ): StatlockerNormalizedDatasetV1<StatlockerProBuildAnalysisV1> {
    const root = requireRecord(raw, 'PRO_BUILD_ANALYSIS', 'root');
    const responseAccount = requireIdentifierString(root.account_id ?? root.accountId, 'PRO_BUILD_ANALYSIS', 'account id');
    const responseHero = parsePositiveInt(root.hero_id ?? root.heroId, 'PRO_BUILD_ANALYSIS', 'hero id');
    if (responseAccount !== accountId || responseHero !== heroId) {
      throw new StatlockerDatasetValidationError('PRO_BUILD_ANALYSIS', 'profile scope mismatch');
    }
    const items: StatlockerProBuildItemV1[] = requireArray(root.items ?? root.build, 'PRO_BUILD_ANALYSIS', 'items')
      .map((value) => parseProBuildItem(value));
    if (items.length === 0) throw new StatlockerDatasetValidationError('PRO_BUILD_ANALYSIS', 'items must not be empty');
    items.sort((a, b) => a.medianBuyTimeS - b.medianBuyTimeS || a.itemId - b.itemId);
    return wrap('PRO_BUILD_ANALYSIS', `hero:${heroId}:account:${accountId}`, statlockerPatchId, {
      accountId,
      heroId,
      items,
    });
  }

  normalizeWpaFilteredItems(
    raw: unknown,
    statlockerPatchId: string,
    heroId: number,
  ): StatlockerNormalizedDatasetV1<StatlockerWpaFilteredItemsV1> {
    const root = requireRecord(raw, 'WPA_FILTERED_ITEMS', 'root');
    const items = requireArray(root.items, 'WPA_FILTERED_ITEMS', 'items')
      .map((row) => parseHeroItemLifecycle(row, heroId));
    if (items.length === 0) throw new StatlockerDatasetValidationError('WPA_FILTERED_ITEMS', 'items must not be empty');
    items.sort((a, b) => a.itemId - b.itemId);
    return wrap('WPA_FILTERED_ITEMS', `hero:${heroId}`, statlockerPatchId, { heroId, items });
  }
}

const HERO_ID_BY_NAME = buildReferenceIdMap(
  HERO_REFERENCE_SEED.map((hero) => ({ id: hero.hero_id, name: hero.name })),
);
const ITEM_ID_BY_NAME = buildReferenceIdMap(
  ITEM_REFERENCE_SEED.map((item) => ({ id: item.itemId, name: item.name })),
);

interface WpaAccumulatorV1 {
  heroId: number;
  itemId: number;
  sampleSize: number;
  weightedMeanWpa: number;
}

interface VsItemAccumulatorV1 {
  itemId: number;
  count: number;
  weightedDeltaWpa: number;
}

interface VsSliceAccumulatorV1 {
  heroId: number;
  enemyHeroId: number;
  items: Map<number, VsItemAccumulatorV1>;
}

function parseNestedWpaPatchData(
  root: Record<string, unknown>,
  statlockerPatchId: string,
): StatlockerWpaItemV1[] {
  const byPatch = requireRecord(root.by_patch, 'WPA_PATCH_DATA', 'by_patch');
  const patchKey = `patch_${statlockerPatchId}`;
  const patch = requireRecord(byPatch[patchKey] ?? byPatch[statlockerPatchId], 'WPA_PATCH_DATA', patchKey);
  const byRank = requireRecord(patch.by_rank, 'WPA_PATCH_DATA', 'by_rank');
  const aggregates = new Map<string, WpaAccumulatorV1>();

  for (const rawRank of Object.values(byRank)) {
    const rank = requireRecord(rawRank, 'WPA_PATCH_DATA', 'rank');
    const byTier = requireRecord(rank.by_tier, 'WPA_PATCH_DATA', 'by_tier');
    for (const rawTier of Object.values(byTier)) {
      const tier = requireRecord(rawTier, 'WPA_PATCH_DATA', 'tier');
      const topByHero = requireRecord(tier.top_by_hero, 'WPA_PATCH_DATA', 'top_by_hero');
      for (const [heroName, rawItems] of Object.entries(topByHero)) {
        const heroId = resolveReferenceId(heroName, HERO_ID_BY_NAME);
        if (!heroId) continue;
        for (const rawItem of requireArray(rawItems, 'WPA_PATCH_DATA', `hero ${heroName}`)) {
          const row = requireRecord(rawItem, 'WPA_PATCH_DATA', 'item');
          const itemId = resolveReferenceId(row.item, ITEM_ID_BY_NAME);
          if (!itemId) continue;
          const sampleSize = parseNonNegativeFinite(row.sample_size ?? row.sampleSize, 'WPA_PATCH_DATA', 'sample size');
          const meanWpa = parseFinite(row.mean_wpa ?? row.meanWpa, 'WPA_PATCH_DATA', 'mean wpa');
          if (sampleSize === 0) continue;
          const key = `${heroId}:${itemId}`;
          const current = aggregates.get(key) ?? {
            heroId,
            itemId,
            sampleSize: 0,
            weightedMeanWpa: 0,
          };
          current.sampleSize += sampleSize;
          current.weightedMeanWpa += meanWpa * sampleSize;
          aggregates.set(key, current);
        }
      }
    }
  }

  const items = [...aggregates.values()].map((entry) => ({
    heroId: entry.heroId,
    itemId: entry.itemId,
    meanWpa: entry.weightedMeanWpa / entry.sampleSize,
    sampleSize: entry.sampleSize,
    gameState: {},
    purchaseTiming: {},
  } satisfies StatlockerWpaItemV1));
  if (items.length === 0) throw new StatlockerDatasetValidationError('WPA_PATCH_DATA', 'items must not be empty');
  items.sort((a, b) => a.heroId - b.heroId || a.itemId - b.itemId);
  return items;
}

function parseNestedVsHeroWpa(
  root: Record<string, unknown>,
  statlockerPatchId: string,
): StatlockerVsHeroSliceV1[] {
  const byPatch = requireRecord(root.by_patch, 'VS_HERO_WPA', 'by_patch');
  const patchKey = `patch_${statlockerPatchId}`;
  const patch = requireRecord(byPatch[patchKey] ?? byPatch[statlockerPatchId], 'VS_HERO_WPA', patchKey);
  const byRank = requireRecord(patch.by_rank, 'VS_HERO_WPA', 'by_rank');
  const aggregates = new Map<string, VsSliceAccumulatorV1>();

  for (const rawRank of Object.values(byRank)) {
    const rank = requireRecord(rawRank, 'VS_HERO_WPA', 'rank');
    const byHero = requireRecord(rank.by_hero, 'VS_HERO_WPA', 'by_hero');
    for (const [heroName, rawItems] of Object.entries(byHero)) {
      const heroId = resolveReferenceId(heroName, HERO_ID_BY_NAME);
      if (!heroId) continue;
      const byItem = requireRecord(rawItems, 'VS_HERO_WPA', `hero ${heroName}`);
      for (const [itemName, rawMatchups] of Object.entries(byItem)) {
        const itemId = resolveReferenceId(itemName, ITEM_ID_BY_NAME);
        if (!itemId) continue;
        const matchups = requireRecord(rawMatchups, 'VS_HERO_WPA', `item ${itemName}`);
        for (const [enemyName, rawMatchup] of Object.entries(matchups)) {
          if (enemyName === '_baseline') continue;
          const enemyHeroId = resolveReferenceId(enemyName, HERO_ID_BY_NAME);
          if (!enemyHeroId) continue;
          const matchup = requireRecord(rawMatchup, 'VS_HERO_WPA', `enemy ${enemyName}`);
          const count = parseNonNegativeFinite(matchup.count ?? matchup.sample_size, 'VS_HERO_WPA', 'count');
          const deltaWpa = parseFinite(matchup.delta_wpa ?? matchup.deltaWpa, 'VS_HERO_WPA', 'delta wpa');
          if (count === 0) continue;
          const sliceKey = `${heroId}:${enemyHeroId}`;
          const slice = aggregates.get(sliceKey) ?? {
            heroId,
            enemyHeroId,
            items: new Map<number, VsItemAccumulatorV1>(),
          };
          const item = slice.items.get(itemId) ?? { itemId, count: 0, weightedDeltaWpa: 0 };
          item.count += count;
          item.weightedDeltaWpa += deltaWpa * count;
          slice.items.set(itemId, item);
          aggregates.set(sliceKey, slice);
        }
      }
    }
  }

  const slices = [...aggregates.values()].map((entry) => ({
    heroId: entry.heroId,
    enemyHeroId: entry.enemyHeroId,
    items: [...entry.items.values()]
      .map((item) => ({
        itemId: item.itemId,
        deltaWpa: item.weightedDeltaWpa / item.count,
        count: item.count,
      }))
      .sort((a, b) => a.itemId - b.itemId),
  }));
  if (slices.length === 0 || slices.every((slice) => slice.items.length === 0)) {
    throw new StatlockerDatasetValidationError('VS_HERO_WPA', 'primary exact-enemy data must not be empty');
  }
  slices.sort((a, b) => a.heroId - b.heroId || a.enemyHeroId - b.enemyHeroId);
  return slices;
}

function buildReferenceIdMap(rows: readonly { id: number; name: string }[]): ReadonlyMap<string, number> {
  const result = new Map<string, number>();
  for (const row of rows) {
    const key = normalizeReferenceName(row.name);
    if (!result.has(key)) result.set(key, row.id);
  }
  return result;
}

function resolveReferenceId(value: unknown, ids: ReadonlyMap<string, number>): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
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

function parseHeroItemLifecycle(raw: unknown, heroId: number): StatlockerHeroItemLifecycleV1 {
  const dataset = 'WPA_FILTERED_ITEMS';
  const row = requireRecord(raw, dataset, 'item');
  const heroName = requireString(row.heroName ?? row.hero_name, dataset, 'hero name');
  const resolvedHeroId = resolveReferenceId(heroName, HERO_ID_BY_NAME);
  if (resolvedHeroId !== heroId) {
    throw new StatlockerDatasetValidationError(dataset, `hero mismatch ${heroName}`);
  }
  const itemName = requireString(row.item, dataset, 'item name');
  const itemId = resolveReferenceId(itemName, ITEM_ID_BY_NAME);
  if (!itemId) {
    throw new StatlockerDatasetValidationError(dataset, `unknown item ${itemName}`);
  }
  const sampleSizeRaw = row.sampleSize ?? row.sample_size;
  return {
    heroId,
    itemId,
    generalWpa: parseFinite(row.wpaValue, dataset, 'general wpa'),
    averagePurchaseTimeS: parseNonNegativeFinite(
      row.mean_purchase_time_min,
      dataset,
      'average purchase time minutes',
    ) * 60,
    ...(sampleSizeRaw === undefined
      ? {}
      : { sampleSize: parseNonNegativeFinite(sampleSizeRaw, dataset, 'sample size') }),
  };
}

function parseWpaItem(raw: unknown, dataset: string, fallbackHeroId?: number): StatlockerWpaItemV1 {
  const row = requireRecord(raw, dataset, 'item');
  const heroId = optionalPositiveInt(row.hero_id ?? row.heroId, dataset, 'hero id') ?? fallbackHeroId;
  if (!heroId) throw new StatlockerDatasetValidationError(dataset, 'hero id is required');
  return {
    heroId,
    itemId: parsePositiveInt(row.item_id ?? row.itemId, dataset, 'item id'),
    meanWpa: parseFinite(row.mean_wpa ?? row.meanWpa, dataset, 'mean wpa'),
    sampleSize: parseNonNegativeFinite(row.sample_size ?? row.sampleSize, dataset, 'sample size'),
    wpaConfidence: optionalFinite(row.wpa_confidence ?? row.wpaConfidence, dataset, 'wpa confidence'),
    gameState: {
      ahead: optionalFinite(row.ahead_wpa ?? row.aheadWpa, dataset, 'ahead wpa'),
      even: optionalFinite(row.even_wpa ?? row.evenWpa, dataset, 'even wpa'),
      behind: optionalFinite(row.behind_wpa ?? row.behindWpa, dataset, 'behind wpa'),
    },
    purchaseTiming: {
      medianPurchaseSec: optionalFinite(
        row.median_purchase_time_s ?? row.medianPurchaseTimeS ?? row.median_buy_time_s,
        dataset,
        'median purchase time',
      ),
      earlyWpa: optionalFinite(row.early_wpa ?? row.earlyWpa, dataset, 'early wpa'),
      midWpa: optionalFinite(row.mid_wpa ?? row.midWpa, dataset, 'mid wpa'),
      lateWpa: optionalFinite(row.late_wpa ?? row.lateWpa, dataset, 'late wpa'),
    },
    laneWpa: optionalFinite(row.lane_wpa ?? row.laneWpa, dataset, 'lane wpa'),
    postLaneWpa: optionalFinite(row.post_lane_wpa ?? row.postLaneWpa, dataset, 'post lane wpa'),
    enemyComposition: optionalNumericRecord(row.enemy_composition ?? row.enemyComposition, dataset, 'enemy composition'),
    ownBuild: optionalNumericRecord(row.build_breakdown ?? row.own_build ?? row.ownBuild, dataset, 'build breakdown'),
  };
}

function parseVsHeroSlice(raw: unknown): StatlockerVsHeroSliceV1 {
  const row = requireRecord(raw, 'VS_HERO_WPA', 'slice');
  const items: StatlockerVsHeroItemV1[] = requireArray(row.items, 'VS_HERO_WPA', 'items').map((value) => {
    const item = requireRecord(value, 'VS_HERO_WPA', 'item');
    return {
      itemId: parsePositiveInt(item.item_id ?? item.itemId, 'VS_HERO_WPA', 'item id'),
      deltaWpa: parseFinite(item.delta_wpa ?? item.deltaWpa, 'VS_HERO_WPA', 'delta wpa'),
      count: parseNonNegativeFinite(item.count ?? item.sample_size, 'VS_HERO_WPA', 'count'),
    };
  });
  items.sort((a, b) => a.itemId - b.itemId);
  return {
    heroId: parsePositiveInt(row.hero_id ?? row.heroId, 'VS_HERO_WPA', 'hero id'),
    enemyHeroId: parsePositiveInt(row.vs_hero_id ?? row.enemy_hero_id ?? row.enemyHeroId, 'VS_HERO_WPA', 'enemy hero id'),
    items,
  };
}

function parseProBuildItem(raw: unknown): StatlockerProBuildItemV1 {
  const row = requireRecord(raw, 'PRO_BUILD_ANALYSIS', 'item');
  const frequencyTier = normalizeFrequencyTier(
    requireString(row.frequencyTier ?? row.frequency_tier, 'PRO_BUILD_ANALYSIS', 'frequency tier'),
  );
  const relationships = Array.isArray(row.relationships)
    ? row.relationships.map((value) => {
        const relationship = requireRecord(value, 'PRO_BUILD_ANALYSIS', 'relationship');
        return {
          itemId: parsePositiveInt(relationship.itemId ?? relationship.item_id, 'PRO_BUILD_ANALYSIS', 'relationship item id'),
          strength: parseFinite(relationship.strength, 'PRO_BUILD_ANALYSIS', 'relationship strength'),
        };
      }).sort((a, b) => a.itemId - b.itemId)
    : [];
  const explicitGroup = parseExplicitGroupV1(row);
  return {
    itemId: parsePositiveInt(row.item_id ?? row.itemId, 'PRO_BUILD_ANALYSIS', 'item id'),
    purchaseRate: parseFinite(row.purchaseRate ?? row.purchase_rate, 'PRO_BUILD_ANALYSIS', 'purchase rate'),
    medianBuyTimeS: parseNonNegativeFinite(row.medianBuyTimeS ?? row.median_buy_time_s, 'PRO_BUILD_ANALYSIS', 'median buy time'),
    frequencyTier,
    phase: normalizeBuildPhaseV1(row.phase),
    relationships,
    ...(explicitGroup ? { explicitGroup } : {}),
  };
}

function normalizeFrequencyTier(value: string): StatlockerFrequencyTierV1 {
  const normalized = value.trim().toUpperCase();
  if (normalized === 'CORE' || normalized === 'FREQUENT' || normalized === 'SOMETIMES' || normalized === 'FLEX') {
    return normalized;
  }
  throw new StatlockerDatasetValidationError('PRO_BUILD_ANALYSIS', `unsupported frequency tier ${value}`);
}

function normalizeBuildPhaseV1(value: unknown): ConsensusBuildPhaseV1 {
  const text = String(value ?? '').trim().toUpperCase();
  if (text === 'EARLY' || text === 'EARLY_GAME') return 'EARLY';
  if (text === 'MID' || text === 'MID_GAME') return 'MID';
  if (text === 'LATE' || text === 'LATE_GAME') return 'LATE';
  throw new StatlockerDatasetValidationError('PRO_BUILD_ANALYSIS', `unknown phase ${String(value)}`);
}

function parseExplicitGroupV1(row: Record<string, unknown>): StatlockerProBuildExplicitGroupV1 | undefined {
  const groupObject = isRecord(row.group) ? row.group : undefined;
  const groupKey = optionalString(
    groupObject?.key ?? groupObject?.id ?? groupObject?.name ??
    row.group_key ?? row.groupKey ??
    (typeof row.group === 'string' ? row.group : undefined) ??
    row.category,
  );
  if (!groupKey) return undefined;

  const explicitType = optionalString(
    groupObject?.type ?? row.group_type ?? row.groupType ?? row.selection_type ?? row.selectionType,
  );
  const pick = parseSelectionCount(groupObject?.pick ?? row.pick);
  const optional = groupObject?.optional === true || row.optional === true;
  const required = groupObject?.required === true || row.required === true;

  let type: ConsensusBuildGroupTypeV1 | undefined;
  if (explicitType) {
    const normalized = explicitType.toUpperCase();
    if (normalized === 'CHOICE' || normalized === 'ONE_OF' || normalized === 'PICK') type = 'CHOICE';
    else if (normalized === 'OPTIONAL') type = 'OPTIONAL';
    else if (normalized === 'REQUIRED' || normalized === 'CORE') type = 'REQUIRED';
    else throw new StatlockerDatasetValidationError('PRO_BUILD_ANALYSIS', `unsupported explicit group type ${explicitType}`);
  } else if (optional) {
    type = 'OPTIONAL';
  } else if (required) {
    type = 'REQUIRED';
  } else if (pick !== undefined) {
    type = 'CHOICE';
  }
  if (!type) return undefined;

  const defaultMin = type === 'OPTIONAL' ? 0 : type === 'CHOICE' ? (pick ?? 1) : 1;
  const defaultMax = type === 'CHOICE' ? (pick ?? 1) : 1;
  const minSelect = optionalNonNegativeInt(groupObject?.min_select ?? groupObject?.minSelect ?? row.min_select ?? row.minSelect) ?? defaultMin;
  const maxSelect = optionalNonNegativeInt(groupObject?.max_select ?? groupObject?.maxSelect ?? row.max_select ?? row.maxSelect) ?? defaultMax;
  if (maxSelect < 1 || minSelect > maxSelect) {
    throw new StatlockerDatasetValidationError('PRO_BUILD_ANALYSIS', `invalid explicit group selection bounds ${minSelect}/${maxSelect}`);
  }
  return { type, groupKey, minSelect, maxSelect };
}

function parseSelectionCount(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string') {
    const match = value.trim().match(/(?:pick\s*)?(\d+)/i);
    if (match) {
      const count = Number(match[1]);
      if (Number.isInteger(count) && count > 0) return count;
    }
  }
  throw new StatlockerDatasetValidationError('PRO_BUILD_ANALYSIS', `invalid pick count ${String(value)}`);
}

function wrap<T extends StatlockerWpaPatchDataV1 | StatlockerVsHeroWpaV1 | StatlockerT4ChainsV1 | StatlockerHeroLeaderboardV1 | StatlockerProBuildAnalysisV1 | StatlockerWpaFilteredItemsV1>(
  dataset: StatlockerNormalizedDatasetV1<T>['dataset'],
  scopeKey: string,
  statlockerPatchId: string,
  payload: T,
): StatlockerNormalizedDatasetV1<T> {
  return {
    dataset,
    scopeKey,
    statlockerPatchId,
    contentSha256: createHash('sha256').update(stableJson(payload)).digest('hex'),
    payload,
  };
}

export function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) result[key] = stableValue(value[key]);
  return result;
}

function requireRecord(value: unknown, dataset: string, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new StatlockerDatasetValidationError(dataset, `${label} must be an object`);
  return value;
}

function requireArray(value: unknown, dataset: string, label: string): unknown[] {
  if (!Array.isArray(value)) throw new StatlockerDatasetValidationError(dataset, `${label} must be an array`);
  return value;
}

function requireString(value: unknown, dataset: string, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new StatlockerDatasetValidationError(dataset, `${label} must be a non-empty string`);
  }
  return value.trim();
}

function requireIdentifierString(value: unknown, dataset: string, label: string): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return requireString(value, dataset, label);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function parseFinite(value: unknown, dataset: string, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new StatlockerDatasetValidationError(dataset, `${label} must be finite`);
  }
  return value;
}

function optionalFinite(value: unknown, dataset: string, label: string): number | undefined {
  if (value === undefined) return undefined;
  return parseFinite(value, dataset, label);
}

function parseNonNegativeFinite(value: unknown, dataset: string, label: string): number {
  const number = parseFinite(value, dataset, label);
  if (number < 0) throw new StatlockerDatasetValidationError(dataset, `${label} must be non-negative`);
  return number;
}

function parsePositiveInt(value: unknown, dataset: string, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new StatlockerDatasetValidationError(dataset, `${label} must be a positive integer`);
  }
  return value;
}

function optionalPositiveInt(value: unknown, dataset: string, label: string): number | undefined {
  if (value === undefined) return undefined;
  return parsePositiveInt(value, dataset, label);
}

function optionalNonNegativeInt(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new StatlockerDatasetValidationError('PRO_BUILD_ANALYSIS', 'selection bound must be a non-negative integer');
  }
  return value;
}

function optionalNumericRecord(
  value: unknown,
  dataset: string,
  label: string,
): Readonly<Record<string, number>> | undefined {
  if (value === undefined) return undefined;
  const source = requireRecord(value, dataset, label);
  const result: Record<string, number> = {};
  for (const key of Object.keys(source).sort()) result[key] = parseFinite(source[key], dataset, `${label}.${key}`);
  return result;
}

function compareNumberArrays(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
