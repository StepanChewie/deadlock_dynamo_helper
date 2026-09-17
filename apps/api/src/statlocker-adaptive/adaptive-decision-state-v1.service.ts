import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  InventoryState,
  RecommendationDecisionState,
  RecommendationItemGraph,
  buildInventoryInstancesForRecommendation,
  buildRecommendationRulesetCatalogV1,
  compileStrictRecommendationCatalogV1,
  observedFact,
  unknownFact,
} from '@dynamo-lab/build-domain';
import { MinimalMatchState, MinimalPlayerState } from '@dynamo-lab/shared';
import { LiveMatchStateService } from '../deadlock-live/live-match-state.service';
import { SoulsAffordabilityEvidenceV2Service } from '../deadlock-live/souls-affordability-evidence-v2.service';
import { RecommendationItemCatalogVersionV1 } from '../deadlock-live/entities/recommendation-item-catalog-version-v1.entity';
import { RecommendationItemCatalogItemV1 } from '../deadlock-live/entities/recommendation-item-catalog-item-v1.entity';
import { RecommendationItemCatalogRecipeV1 } from '../deadlock-live/entities/recommendation-item-catalog-recipe-v1.entity';
import { resolveRecommendationCatalogAssetSemantics } from '../deadlock-live/recommendation-catalog-asset-semantics';
import {
  AdaptiveInvestmentStateV1,
  AdaptiveSlotStateV1,
  RecommendationEconomyRulesV1,
  deriveAdaptiveInvestmentStateV1,
  deriveAdaptiveSlotStateV1,
  slotRulesFromEconomyRulesV1,
} from './adaptive-economy-v1';
import { RecommendationEconomyRulesStoreV1Service } from './recommendation-economy-rules-store-v1.service';

export interface AdaptiveEnemyHeroV1 {
  heroId: number;
  heroName?: string;
}

export interface AdaptiveEnemyLiveStateV1 {
  steamId: string;
  playerName?: string;
  heroId: number;
  heroName?: string;
  level?: number;
  souls?: number;
  kills?: number;
  deaths?: number;
  assists?: number;
  heroDamage?: number;
}

export interface AdaptiveDecisionStateV1 {
  state: RecommendationDecisionState;
  itemGraph: RecommendationItemGraph;
  catalogVersionId: string;
  catalogSha256: string;
  rulesetId: string;
  localSteamId: string;
  allyHeroIds?: readonly number[];
  enemyHeroIds: readonly number[];
  enemyHeroes?: readonly AdaptiveEnemyHeroV1[];
  enemyLiveStates: readonly AdaptiveEnemyLiveStateV1[];
  allyItemIds?: readonly number[];
  enemyItemIds?: readonly number[];
  ourTeamSouls?: number;
  enemyTeamSouls?: number;
  slots: AdaptiveSlotStateV1;
  investment: AdaptiveInvestmentStateV1;
  economyRules?: RecommendationEconomyRulesV1;
  economyRulesEvidence: 'RECONSTRUCTED' | 'UNKNOWN';
  stateRevision: string;
}

export class AdaptiveLiveStateNotReadyError extends Error {
  constructor(
    readonly matchId: string,
    readonly blocker: 'LIVE_MATCH_STATE_UNAVAILABLE' | 'LOCAL_PLAYER_UNRESOLVED' | 'LOCAL_PLAYER_IDENTITY_INCOMPLETE',
  ) {
    super(`Live state is not ready for match ${matchId}: ${blocker}`);
    this.name = 'AdaptiveLiveStateNotReadyError';
  }
}

@Injectable()
export class AdaptiveDecisionStateV1Service {
  constructor(
    private readonly liveState: LiveMatchStateService,
    private readonly soulsEvidence: SoulsAffordabilityEvidenceV2Service,
    @InjectRepository(RecommendationItemCatalogVersionV1)
    private readonly versionRepo: Repository<RecommendationItemCatalogVersionV1>,
    @InjectRepository(RecommendationItemCatalogItemV1)
    private readonly itemRepo: Repository<RecommendationItemCatalogItemV1>,
    @InjectRepository(RecommendationItemCatalogRecipeV1)
    private readonly recipeRepo: Repository<RecommendationItemCatalogRecipeV1>,
    private readonly economyRulesStore: RecommendationEconomyRulesStoreV1Service,
  ) {}

  async build(matchId: string, requestedLocalSteamId?: string): Promise<AdaptiveDecisionStateV1> {
    const match = this.liveState.getState(matchId);
    if (!match) throw new AdaptiveLiveStateNotReadyError(matchId, 'LIVE_MATCH_STATE_UNAVAILABLE');
    const localSteamId = resolveLocalSteamId(match, requestedLocalSteamId);
    const local = match.playersBySteamId[localSteamId];
    if (!local?.heroId || local.teamId === undefined) {
      throw new AdaptiveLiveStateNotReadyError(matchId, 'LOCAL_PLAYER_IDENTITY_INCOMPLETE');
    }

    const [version] = await this.versionRepo.find({
      order: { importedAt: 'DESC', catalogVersionId: 'DESC' },
      take: 1,
    });
    if (!version) throw new Error('No item catalog version is available');

    const [itemRows, recipeRows] = await Promise.all([
      this.itemRepo.find({ where: { catalogVersionId: version.catalogVersionId }, order: { itemId: 'ASC' } }),
      this.recipeRepo.find({
        where: { catalogVersionId: version.catalogVersionId },
        order: { parentItemId: 'ASC', componentOrder: 'ASC', componentItemId: 'ASC' },
      }),
    ]);

    const expectedRulesetId = catalogRulesetId(version);
    const pinnedEconomyRules = expectedRulesetId && typeof (this.economyRulesStore as any).resolveExact === 'function'
      ? await (this.economyRulesStore as any).resolveExact(expectedRulesetId, version.payloadSha256)
      : undefined;
    const catalog = buildRecommendationRulesetCatalogV1({
      version: {
        catalogVersionId: version.catalogVersionId,
        contentCatalogVersionId: version.contentCatalogVersionId,
        clientVersion: version.clientVersion,
        rulesetKey: version.rulesetKey,
        source: version.source,
        payloadSha256: version.payloadSha256,
        importedAt: version.importedAt.toISOString(),
      },
      items: itemRows.map((row) => {
        const semantics = resolveRecommendationCatalogAssetSemantics(row);
        return {
          itemId: Number(row.itemId),
          name: row.name,
          className: row.className,
          itemType: semantics.itemType,
          slotType: row.slotType,
          cost: row.cost,
          tier: row.tier,
          shopable: semantics.shopable,
          disabled: semantics.disabled,
          active: semantics.active,
          isActiveItem: semantics.isActiveItem,
          activationType: semantics.activationType,
          rawPayload: row.rawPayload,
        };
      }),
      recipeEdges: recipeRows.map((row) => ({
        parentItemId: Number(row.parentItemId),
        componentItemId: Number(row.componentItemId),
        componentOrder: row.componentOrder,
      })),
      upgradePricingPolicy: pinnedEconomyRules?.upgradePricingPolicy,
    });
    const compiled = compileStrictRecommendationCatalogV1(catalog);
    const exactEconomyRules = pinnedEconomyRules?.rulesetId === compiled.rulesetId
      ? pinnedEconomyRules
      : typeof (this.economyRulesStore as any).resolveExact === 'function'
        ? await (this.economyRulesStore as any).resolveExact(compiled.rulesetId, version.payloadSha256)
        : undefined;

    const ownedItemIds = local.items.map((item) => item.id).sort((a, b) => a - b);
    const heldByItemId = buildInventoryInstancesForRecommendation(ownedItemIds, compiled.graph);
    const inventory: InventoryState = {
      initializedFromSnapshot: true,
      heldByItemId,
      lifecycleCountByItemId: new Map(ownedItemIds.map((itemId) => [itemId, 1])),
      nextInstanceSequence: heldByItemId.size + 1,
    };

    const slotRules = slotRulesFromEconomyRulesV1(exactEconomyRules);
    const flexCapacity = Number.isInteger(match.unlockedFlexSlots) && Number(match.unlockedFlexSlots) >= 0
      ? {
          unlockedFlexSlots: Number(match.unlockedFlexSlots),
          evidence: 'OBSERVED' as const,
        }
      : { evidence: 'UNKNOWN' as const };
    const slots = deriveAdaptiveSlotStateV1(
      ownedItemIds,
      compiled.graph,
      slotRules,
      flexCapacity,
    );
    const investment = deriveAdaptiveInvestmentStateV1(ownedItemIds, compiled.graph, exactEconomyRules);

    const canVerifySpendable = await this.soulsEvidence.canVerifyScope(
      compiled.rulesetId,
      version.payloadSha256,
    );
    const spendableSouls = canVerifySpendable && Number.isFinite(local.souls)
      ? observedFact(local.souls as number, `souls-affordability:${compiled.rulesetId}:${version.payloadSha256}`)
      : unknownFact<number>('souls-affordability-scope-unverified');

    const players = Object.values(match.playersBySteamId);
    const allies = players.filter((player) => player.teamId === local.teamId && player.steamId !== localSteamId);
    const enemies = players.filter((player) => player.teamId !== undefined && player.teamId !== local.teamId);
    const allyHeroIds = stableHeroIds(allies);
    const enemyHeroes = resolveEnemyHeroes(match, local.teamId);
    const enemyHeroIds = enemyHeroes.map((hero) => hero.heroId);
    const enemyLiveStates = resolveEnemyLiveStates(match, local.teamId);
    const allyItemIds = stableObservedItemIds(allies);
    const enemyItemIds = stableObservedItemIds(enemies);
    const teamTotals = calculateTeamSoulTotals(match, local.teamId);
    const gameTimeSec = Number.isFinite(match.gameTimeSec) ? (match.gameTimeSec as number) : 0;
    const stateRevision = computeStateRevision(match, localSteamId, version, ownedItemIds);
    const state: RecommendationDecisionState = {
      decisionId: `adaptive:${stateRevision.slice(0, 24)}`,
      matchId,
      playerSlot: stablePlayerSlot(match, localSteamId),
      gameTimeSec,
      rulesetId: compiled.rulesetId,
      heroId: local.heroId,
      inventory,
      economy: {
        spendableSouls,
        shopOpportunity: unknownFact('direct-shop-opportunity-unobserved'),
      },
    };

    return {
      state,
      itemGraph: compiled.graph,
      catalogVersionId: version.catalogVersionId,
      catalogSha256: version.payloadSha256,
      rulesetId: compiled.rulesetId,
      localSteamId,
      allyHeroIds,
      enemyHeroIds,
      enemyHeroes,
      enemyLiveStates,
      allyItemIds,
      enemyItemIds,
      ourTeamSouls: teamTotals.our,
      enemyTeamSouls: teamTotals.enemy,
      slots,
      investment,
      economyRules: exactEconomyRules,
      economyRulesEvidence: exactEconomyRules ? 'RECONSTRUCTED' : 'UNKNOWN',
      stateRevision,
    };
  }
}

function catalogRulesetId(version: RecommendationItemCatalogVersionV1): string | undefined {
  const value = version.rulesetKey ?? version.clientVersion;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function resolveEnemyHeroes(match: MinimalMatchState, localTeamId: number): readonly AdaptiveEnemyHeroV1[] {
  const byHeroId = new Map<number, AdaptiveEnemyHeroV1>();
  for (const player of Object.values(match.playersBySteamId)) {
    // Hero id 0 is not a hero: it is the observer slot, which sits on its own
    // team. It is filtered out here rather than by identity, because in a bot
    // match every real player is also unidentified (`steam_id: "0"`) and must
    // still be counted.
    if (player.teamId === undefined || player.teamId === localTeamId) continue;
    if (!Number.isInteger(player.heroId) || (player.heroId as number) <= 0) continue;
    const heroId = Number(player.heroId);
    const heroName = typeof player.heroName === 'string' && player.heroName.trim()
      ? player.heroName.trim()
      : undefined;
    const existing = byHeroId.get(heroId);
    if (!existing || (!existing.heroName && heroName)) {
      byHeroId.set(heroId, heroName ? { heroId, heroName } : { heroId });
    }
  }
  return [...byHeroId.values()].sort((a, b) => a.heroId - b.heroId);
}

function resolveEnemyLiveStates(
  match: MinimalMatchState,
  localTeamId: number,
): readonly AdaptiveEnemyLiveStateV1[] {
  return Object.values(match.playersBySteamId)
    .filter(
      (player) =>
        player.teamId !== undefined &&
        player.teamId !== localTeamId &&
        Number.isInteger(player.heroId) &&
        (player.heroId as number) > 0,
    )
    .map((player) => ({
      steamId: player.steamId,
      ...(typeof player.playerName === 'string' && player.playerName.trim()
        ? { playerName: player.playerName.trim() }
        : {}),
      heroId: Number(player.heroId),
      ...(typeof player.heroName === 'string' && player.heroName.trim()
        ? { heroName: player.heroName.trim() }
        : {}),
      ...(Number.isFinite(player.level) ? { level: player.level as number } : {}),
      ...(Number.isFinite(player.souls) ? { souls: player.souls as number } : {}),
      ...(Number.isFinite(player.kills) ? { kills: player.kills as number } : {}),
      ...(Number.isFinite(player.deaths) ? { deaths: player.deaths as number } : {}),
      ...(Number.isFinite(player.assists) ? { assists: player.assists as number } : {}),
      ...(Number.isFinite(player.heroDamage) ? { heroDamage: player.heroDamage as number } : {}),
    }))
    .sort((a, b) => a.heroId - b.heroId || a.steamId.localeCompare(b.steamId));
}

function resolveLocalSteamId(match: MinimalMatchState, requested?: string): string {
  if (requested && match.playersBySteamId[requested]) return requested;

  const markedLocal = Object.values(match.playersBySteamId)
    .filter((player) => player.isLocal)
    .sort((a, b) => a.steamId.localeCompare(b.steamId));
  if (markedLocal.length === 1) return markedLocal[0].steamId;
  if (markedLocal.length > 1) {
    throw new AdaptiveLiveStateNotReadyError(match.matchId, 'LOCAL_PLAYER_UNRESOLVED');
  }

  const realPlayers = Object.values(match.playersBySteamId)
    .filter((player) => player.steamId !== '0' && !player.steamId.startsWith('bot:'))
    .sort((a, b) => a.steamId.localeCompare(b.steamId));
  if (realPlayers.length === 1) return realPlayers[0].steamId;

  throw new AdaptiveLiveStateNotReadyError(match.matchId, 'LOCAL_PLAYER_UNRESOLVED');
}

function stableHeroIds(players: readonly MinimalPlayerState[]): number[] {
  return players
    .map((player) => player.heroId)
    .filter((heroId): heroId is number => Number.isInteger(heroId))
    .sort((a, b) => a - b);
}

function stableObservedItemIds(players: readonly MinimalPlayerState[]): number[] {
  return [...new Set(players.flatMap((player) => player.items.map((item) => item.id)))]
    .filter((itemId) => Number.isInteger(itemId) && itemId > 0)
    .sort((a, b) => a - b);
}

function calculateTeamSoulTotals(
  match: MinimalMatchState,
  localTeamId: number,
): { our?: number; enemy?: number } {
  const ourPlayers = Object.values(match.playersBySteamId).filter((player) => player.teamId === localTeamId);
  const enemyPlayers = Object.values(match.playersBySteamId).filter(
    (player) => player.teamId !== undefined && player.teamId !== localTeamId,
  );
  return {
    our: finiteSoulTotal(ourPlayers),
    enemy: finiteSoulTotal(enemyPlayers),
  };
}

function finiteSoulTotal(players: readonly MinimalPlayerState[]): number | undefined {
  if (players.length === 0 || players.some((player) => !Number.isFinite(player.souls))) return undefined;
  return players.reduce((sum, player) => sum + (player.souls as number), 0);
}

function stablePlayerSlot(match: MinimalMatchState, localSteamId: string): number {
  return Object.keys(match.playersBySteamId).sort().indexOf(localSteamId);
}

function computeStateRevision(
  match: MinimalMatchState,
  localSteamId: string,
  version: RecommendationItemCatalogVersionV1,
  ownedItemIds: readonly number[],
): string {
  const roster = Object.values(match.playersBySteamId)
    .map((player) => ({
      steamId: player.steamId,
      heroId: player.heroId,
      heroName: player.heroName,
      teamId: player.teamId,
      souls: player.souls,
      itemIds: player.items.map((item) => item.id).sort((a, b) => a - b),
    }))
    .sort((a, b) => a.steamId.localeCompare(b.steamId));
  const payload = {
    matchId: match.matchId,
    localSteamId,
    gameTimeSec: match.gameTimeSec,
    unlockedFlexSlots: match.unlockedFlexSlots,
    rulesetId: version.rulesetKey,
    catalogSha256: version.payloadSha256,
    ownedItemIds,
    roster,
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
