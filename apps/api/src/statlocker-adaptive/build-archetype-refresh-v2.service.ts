import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  RecommendationItemDefinition,
  RecommendationItemGraph,
  createRecommendationItemGraph,
} from '@deadlock-live-probe/build-domain';
import { Repository } from 'typeorm';
import { RecommendationItemCatalogItemV1 } from '../deadlock-live/entities/recommendation-item-catalog-item-v1.entity';
import { RecommendationItemCatalogRecipeV1 } from '../deadlock-live/entities/recommendation-item-catalog-recipe-v1.entity';
import { RecommendationItemCatalogVersionV1 } from '../deadlock-live/entities/recommendation-item-catalog-version-v1.entity';
import {
  BuildArchetypeSnapshotV2,
  StatlockerBuildProfileV2,
} from './build-archetype-v2';
import { BuildArchetypeCompilerV2Service } from './build-archetype-compiler-v2.service';
import { BuildArchetypeMinerV2Service } from './build-archetype-miner-v2.service';
import {
  BuildArchetypeQualityGateResultV2,
  BuildArchetypeQualityGateV2Service,
} from './build-archetype-quality-gate-v2.service';
import { BuildArchetypeSnapshotStoreV2Service } from './build-archetype-snapshot-store-v2.service';
import {
  StatlockerHeroLeaderboardV1,
  StatlockerProBuildAnalysisV1,
} from './statlocker-adaptive.types';
import { toStatlockerBuildProfileV2 } from './statlocker-build-profile-v2';
import { StatlockerSnapshotStoreService } from './statlocker-snapshot-store.service';

const REQUIRED_PROFILE_COUNT = 10;

export type BuildArchetypeRefreshReasonCodeV2 =
  | 'HERO_LEADERBOARD_SNAPSHOT_MISSING'
  | 'INSUFFICIENT_TOP_TEN_PROFILES'
  | 'CATALOG_SNAPSHOT_MISSING'
  | 'ARCHETYPE_MINING_EMPTY'
  | 'ARCHETYPE_QUALITY_REJECTED';

export interface BuildArchetypeRefreshIdentityV2 {
  rulesetVersion: string;
  catalogSha256: string;
  statlockerPatchId: string;
}

export interface BuildArchetypeRefreshSourceProfileV2 {
  accountId: string;
  rank: number;
  playerName?: string;
}

export interface BuildArchetypeRefreshResultV2 {
  published: boolean;
  reasonCodes: readonly BuildArchetypeRefreshReasonCodeV2[];
  sourceProfiles: readonly BuildArchetypeRefreshSourceProfileV2[];
  snapshot?: BuildArchetypeSnapshotV2;
  quality?: BuildArchetypeQualityGateResultV2;
}

@Injectable()
export class BuildArchetypeRefreshV2Service {
  constructor(
    private readonly sourceStore: StatlockerSnapshotStoreService,
    private readonly miner: BuildArchetypeMinerV2Service,
    private readonly compiler: BuildArchetypeCompilerV2Service,
    private readonly qualityGate: BuildArchetypeQualityGateV2Service,
    private readonly snapshotStore: BuildArchetypeSnapshotStoreV2Service,
    @InjectRepository(RecommendationItemCatalogVersionV1)
    private readonly catalogVersionRepo: Repository<RecommendationItemCatalogVersionV1>,
    @InjectRepository(RecommendationItemCatalogItemV1)
    private readonly itemRepo: Repository<RecommendationItemCatalogItemV1>,
    @InjectRepository(RecommendationItemCatalogRecipeV1)
    private readonly recipeRepo: Repository<RecommendationItemCatalogRecipeV1>,
  ) {}

  async refreshHero(
    heroId: number,
    identity: BuildArchetypeRefreshIdentityV2,
    nowMs = Date.now(),
  ): Promise<BuildArchetypeRefreshResultV2> {
    validateInput(heroId, identity);
    const normalizedIdentity = {
      ...identity,
      catalogSha256: identity.catalogSha256.toLowerCase(),
    };

    const leaderboardRow = await this.sourceStore.getActive({
      dataset: 'HERO_LEADERBOARD',
      scopeKey: `hero:${heroId}`,
      rulesetVersion: normalizedIdentity.rulesetVersion,
      catalogSha256: normalizedIdentity.catalogSha256,
      statlockerPatchId: normalizedIdentity.statlockerPatchId,
    });
    if (!leaderboardRow) {
      return rejected('HERO_LEADERBOARD_SNAPSHOT_MISSING', []);
    }

    const leaderboard = parseLeaderboard(leaderboardRow.payload, heroId);
    const topTen = selectTopTen(leaderboard, heroId);
    if (topTen.length !== REQUIRED_PROFILE_COUNT) {
      return rejected('INSUFFICIENT_TOP_TEN_PROFILES', topTen);
    }

    const catalogGraph = await this.loadCatalogGraph(normalizedIdentity);
    if (!catalogGraph) {
      return rejected('CATALOG_SNAPSHOT_MISSING', topTen);
    }

    const profiles: StatlockerBuildProfileV2[] = [];
    const availableSources: BuildArchetypeRefreshSourceProfileV2[] = [];
    for (const source of topTen) {
      const profileRow = await this.sourceStore.getActive({
        dataset: 'PRO_BUILD_ANALYSIS',
        scopeKey: `hero:${heroId}:account:${source.accountId}`,
        rulesetVersion: normalizedIdentity.rulesetVersion,
        catalogSha256: normalizedIdentity.catalogSha256,
        statlockerPatchId: normalizedIdentity.statlockerPatchId,
      });
      if (!profileRow) continue;

      const analysis = parseProBuild(profileRow.payload, heroId, source.accountId);
      profiles.push(toStatlockerBuildProfileV2(analysis, catalogGraph, source.rank, source.playerName));
      availableSources.push(source);
    }

    if (profiles.length !== REQUIRED_PROFILE_COUNT) {
      return rejected('INSUFFICIENT_TOP_TEN_PROFILES', availableSources);
    }

    const mining = this.miner.mine(profiles);
    if (mining.accepted.length === 0) {
      return rejected('ARCHETYPE_MINING_EMPTY', availableSources);
    }

    const archetypes = mining.accepted.map((cluster) => this.compiler.compile({
      cluster,
      profiles,
      rulesetVersion: normalizedIdentity.rulesetVersion,
      statlockerPatchId: normalizedIdentity.statlockerPatchId,
      catalogSha256: normalizedIdentity.catalogSha256,
      itemGraph: catalogGraph,
    }));

    const snapshot: BuildArchetypeSnapshotV2 = {
      snapshotId: buildSnapshotId(heroId, normalizedIdentity, availableSources, archetypes.map((entry) => entry.archetypeId)),
      heroId,
      rulesetVersion: normalizedIdentity.rulesetVersion,
      catalogSha256: normalizedIdentity.catalogSha256,
      statlockerPatchId: normalizedIdentity.statlockerPatchId,
      generatedAt: new Date(nowMs).toISOString(),
      sourceProfileAccountIds: availableSources.map((entry) => entry.accountId),
      archetypes,
    };
    const quality = this.qualityGate.evaluate(snapshot, catalogGraph);
    if (!quality.accepted) {
      return {
        published: false,
        reasonCodes: ['ARCHETYPE_QUALITY_REJECTED'],
        sourceProfiles: availableSources,
        snapshot,
        quality,
      };
    }

    await this.snapshotStore.publishValidated(snapshot, quality, new Date(nowMs));
    return {
      published: true,
      reasonCodes: [],
      sourceProfiles: availableSources,
      snapshot,
      quality,
    };
  }

  private async loadCatalogGraph(identity: BuildArchetypeRefreshIdentityV2): Promise<RecommendationItemGraph | undefined> {
    const catalog = await this.catalogVersionRepo.findOne({
      where: {
        rulesetKey: identity.rulesetVersion,
        payloadSha256: identity.catalogSha256.toLowerCase(),
      },
    });
    if (!catalog) return undefined;

    const [itemRows, recipeRows] = await Promise.all([
      this.itemRepo.find({
        where: { catalogVersionId: catalog.catalogVersionId },
        order: { itemId: 'ASC' },
      }),
      this.recipeRepo.find({
        where: { catalogVersionId: catalog.catalogVersionId },
        order: { parentItemId: 'ASC', componentOrder: 'ASC', componentItemId: 'ASC' },
      }),
    ]);
    const buildItemRows = itemRows.filter((row) => hasInventorySlotType(row.slotType));
    if (buildItemRows.length === 0) return undefined;

    const definitions = buildItemRows.map((row) => toItemDefinition(row, identity.rulesetVersion));
    const lineageEdges = recipeRows.map((row) => ({
      parentItemId: positiveInteger(row.parentItemId, 'catalog recipe parentItemId'),
      componentItemId: positiveInteger(row.componentItemId, 'catalog recipe componentItemId'),
    }));
    return createRecommendationItemGraph(definitions, lineageEdges);
  }
}

function rejected(
  reason: BuildArchetypeRefreshReasonCodeV2,
  sourceProfiles: readonly BuildArchetypeRefreshSourceProfileV2[],
): BuildArchetypeRefreshResultV2 {
  return { published: false, reasonCodes: [reason], sourceProfiles };
}

function validateInput(heroId: number, identity: BuildArchetypeRefreshIdentityV2): void {
  if (!Number.isInteger(heroId) || heroId <= 0) {
    throw new Error('Build archetype v2 refresh: heroId must be a positive integer');
  }
  if (!identity.rulesetVersion || !identity.statlockerPatchId) {
    throw new Error('Build archetype v2 refresh: ruleset/patch identity is incomplete');
  }
  if (!/^[a-f0-9]{64}$/i.test(identity.catalogSha256)) {
    throw new Error('Build archetype v2 refresh: catalogSha256 must be a 64-character hex digest');
  }
}

function parseLeaderboard(payload: Record<string, unknown>, heroId: number): StatlockerHeroLeaderboardV1 {
  const value = payload as unknown as StatlockerHeroLeaderboardV1;
  if (value.heroId !== heroId || !Array.isArray(value.profiles)) {
    throw new Error(`Build archetype v2 refresh: invalid leaderboard payload for hero ${heroId}`);
  }
  return value;
}

function selectTopTen(
  leaderboard: StatlockerHeroLeaderboardV1,
  heroId: number,
): BuildArchetypeRefreshSourceProfileV2[] {
  const valid = leaderboard.profiles
    .filter((profile) =>
      profile.heroId === heroId &&
      Number.isInteger(profile.rank) &&
      profile.rank > 0 &&
      typeof profile.accountId === 'string' &&
      profile.accountId.trim() !== '',
    )
    .map((profile) => {
      const playerName = typeof profile.playerName === 'string' ? profile.playerName.trim() : '';
      return {
        accountId: profile.accountId,
        rank: profile.rank,
        ...(playerName ? { playerName } : {}),
      };
    })
    .sort((left, right) => left.rank - right.rank || left.accountId.localeCompare(right.accountId));

  const selected: BuildArchetypeRefreshSourceProfileV2[] = [];
  const seenAccounts = new Set<string>();
  for (const profile of valid) {
    if (seenAccounts.has(profile.accountId)) continue;
    seenAccounts.add(profile.accountId);
    selected.push(profile);
    if (selected.length === REQUIRED_PROFILE_COUNT) break;
  }
  return selected;
}

function parseProBuild(
  payload: Record<string, unknown>,
  heroId: number,
  accountId: string,
): StatlockerProBuildAnalysisV1 {
  const value = payload as unknown as StatlockerProBuildAnalysisV1;
  if (value.heroId !== heroId || value.accountId !== accountId || !Array.isArray(value.items) || value.items.length === 0) {
    throw new Error(`Build archetype v2 refresh: invalid PRO_BUILD_ANALYSIS for ${accountId}`);
  }
  return value;
}

function toItemDefinition(
  row: RecommendationItemCatalogItemV1,
  rulesetVersion: string,
): RecommendationItemDefinition {
  const slotType = normalizeSlotType(row.slotType);
  const itemId = positiveInteger(row.itemId, 'catalog itemId');
  const directPurchaseCost = finiteNonNegative(row.cost) ? Number(row.cost) : undefined;
  return {
    itemId,
    name: row.name || `Item ${itemId}`,
    slotType,
    active: row.active ?? row.disabled !== true,
    availableRulesetIds: [rulesetVersion],
    ...(directPurchaseCost === undefined ? {} : { directPurchaseCost }),
    upgradeRecipes: [],
  };
}

function normalizeSlotType(value: string | undefined): RecommendationItemDefinition['slotType'] {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'weapon' || normalized === 'vitality' || normalized === 'spirit') return normalized;
  throw new Error(`Build archetype v2 refresh: unsupported catalog slot type ${String(value)}`);
}

function hasInventorySlotType(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function positiveInteger(value: number, field: string): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new Error(`Build archetype v2 refresh: invalid ${field} ${String(value)}`);
  }
  return normalized;
}

function finiteNonNegative(value: number | undefined): boolean {
  return value !== undefined && Number.isFinite(Number(value)) && Number(value) >= 0;
}

export function buildSnapshotId(
  heroId: number,
  identity: BuildArchetypeRefreshIdentityV2,
  sourceProfiles: readonly BuildArchetypeRefreshSourceProfileV2[],
  archetypeIds: readonly string[],
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({
      heroId,
      rulesetVersion: identity.rulesetVersion,
      catalogSha256: identity.catalogSha256.toLowerCase(),
      statlockerPatchId: identity.statlockerPatchId,
      sourceProfiles: sourceProfiles.map(({ accountId, rank }) => ({ accountId, rank })),
      archetypeIds: [...archetypeIds].sort(),
    }))
    .digest('hex')
    .slice(0, 24);
  return `build-archetype-v2:${heroId}:${digest}`;
}