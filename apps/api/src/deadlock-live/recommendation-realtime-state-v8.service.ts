import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  RecommendationDecisionState,
  RecommendationItemGraph,
  ShopOpportunity,
  buildInventoryInstancesForRecommendation,
  buildRecommendationRulesetCatalogV1,
  compileStrictRecommendationCatalogV1,
  observedFact,
  unknownFact,
} from '@deadlock-live-probe/build-domain';
import {
  InventorySnapshotPayloadV8,
  PlayerStatePayloadV8,
  RecommendationFeatureHistoryEventV8,
  RecommendationFeatureStateV8,
  RecommendationTelemetryQualityV8,
  RecommendationTelemetryVersionsV8,
} from '@deadlock-live-probe/shared';
import { assembleRecommendationFeatureStateV8 } from './recommendation-feature-assembler-v8';
import {
  approvedDirectShopOpportunityV8,
  configuredDirectShopSourceAllowlist,
} from './recommendation-direct-shop-source-v8';

export interface RecommendationRealtimeStateV8Request {
  decisionId: string;
  matchId: string;
  playerKey: string;
  playerSlot: number;
  decisionAtMs: number;
  maximumAlignmentAgeMs?: number;
  maximumHistoryEvents?: number;
}

export interface RecommendationRealtimeStateV8Result {
  ready: boolean;
  blockers: readonly string[];
  state?: RecommendationDecisionState;
  itemGraph?: RecommendationItemGraph;
  featureState?: RecommendationFeatureStateV8;
  stateRevision?: string;
  versions?: RecommendationTelemetryVersionsV8;
  quality?: RecommendationTelemetryQualityV8;
  rulesetVersion?: string;
  catalogSha256?: string;
}

interface TelemetryRow {
  eventId: string;
  sourceEventId?: string;
  eventType: string;
  source: string;
  sourceOccurredAt: Date | string;
  receivedAt: Date | string;
  gameTimeMs?: number;
  clientVersion: string;
  gepVersion: string;
  normalizerVersion: string;
  rulesetVersion: string;
  catalogSha256: string;
  directlyObserved: boolean;
  reconstructed: boolean;
  stale: boolean;
  alignmentAgeMs: number;
  payload: Record<string, unknown>;
}

interface CatalogVersionRow {
  catalogVersionId: string;
  contentCatalogVersionId?: string;
  clientVersion: string;
  rulesetId?: number | string;
  rulesetKey?: string;
  source: string;
  payloadSha256: string;
  importedAt: Date | string;
}

interface CatalogItemRow {
  itemId: string | number;
  name: string;
  className?: string;
  itemType?: string;
  slotType?: string;
  cost?: string | number;
  tier?: string | number;
  shopable?: boolean;
  disabled?: boolean;
  active?: boolean;
  isActiveItem?: boolean;
  activationType?: string;
  rawPayload?: Record<string, unknown>;
}

interface CatalogRecipeRow {
  parentItemId: string | number;
  componentItemId: string | number;
  componentOrder: string | number;
}

@Injectable()
export class RecommendationRealtimeStateV8Service {
  constructor(private readonly dataSource: DataSource) {}

  async build(request: RecommendationRealtimeStateV8Request): Promise<RecommendationRealtimeStateV8Result> {
    const requestErrors = validateRequest(request);
    if (requestErrors.length > 0) return { ready: false, blockers: requestErrors };
    const maximumAlignmentAgeMs = request.maximumAlignmentAgeMs ?? 5_000;
    const maximumHistoryEvents = request.maximumHistoryEvents ?? 64;
    const approvedDirectShopSourceKeys = configuredDirectShopSourceAllowlist();
    const approvedDirectShopSources = new Set(approvedDirectShopSourceKeys);
    const from = new Date(request.decisionAtMs - maximumAlignmentAgeMs).toISOString();
    const to = new Date(request.decisionAtMs).toISOString();
    const telemetrySelect = `"eventId", "sourceEventId", "eventType", "source", "sourceOccurredAt", "receivedAt", "gameTimeMs", "clientVersion", "gepVersion", "normalizerVersion", "rulesetVersion", "catalogSha256", "directlyObserved", "reconstructed", "stale", "alignmentAgeMs", "payload"`;
    const [playerRows, inventoryRows, historyRows] = await Promise.all([
      this.dataSource.query(
        `SELECT ${telemetrySelect}
         FROM recommendation_telemetry_events
         WHERE "matchId" = $1
           AND "playerKey" = $2
           AND "eventType" = 'PLAYER_STATE'
           AND "sourceOccurredAt" >= $3
           AND "sourceOccurredAt" <= $4
           AND "receivedAt" <= $4
         ORDER BY "sourceOccurredAt" DESC, "receivedAt" DESC
         LIMIT 1`,
        [request.matchId, request.playerKey, from, to],
      ),
      this.dataSource.query(
        `SELECT ${telemetrySelect}
         FROM recommendation_telemetry_events
         WHERE "matchId" = $1
           AND "playerKey" = $2
           AND "eventType" = 'INVENTORY_SNAPSHOT'
           AND "sourceOccurredAt" >= $3
           AND "sourceOccurredAt" <= $4
           AND "receivedAt" <= $4
         ORDER BY "sourceOccurredAt" DESC, "receivedAt" DESC
         LIMIT 1`,
        [request.matchId, request.playerKey, from, to],
      ),
      maximumHistoryEvents === 0
        ? Promise.resolve([])
        : this.dataSource.query(
            `SELECT ${telemetrySelect}
             FROM recommendation_telemetry_events
             WHERE "matchId" = $1
               AND "playerKey" = $2
               AND "sourceOccurredAt" < $3
               AND "receivedAt" <= $3
               AND "eventType" IN ('RECOMMENDATION_DECISION', 'RECOMMENDATION_OUTCOME')
             ORDER BY "sourceOccurredAt" DESC, "receivedAt" DESC
             LIMIT $4`,
            [request.matchId, request.playerKey, to, maximumHistoryEvents],
          ),
    ]) as [TelemetryRow[], TelemetryRow[], TelemetryRow[]];
    const playerRow = playerRows[0];
    const inventoryRow = inventoryRows[0];
    const blockers: string[] = [];
    if (!playerRow) blockers.push('PLAYER_STATE_MISSING');
    if (!inventoryRow) blockers.push('INVENTORY_SNAPSHOT_MISSING');
    if (blockers.length > 0) return { ready: false, blockers: blockers.sort() };

    if (playerRow.rulesetVersion !== inventoryRow.rulesetVersion) blockers.push('RULESET_ALIGNMENT_MISMATCH');
    if (playerRow.catalogSha256 !== inventoryRow.catalogSha256) blockers.push('CATALOG_ALIGNMENT_MISMATCH');
    if (playerRow.gepVersion !== inventoryRow.gepVersion) blockers.push('GEP_ALIGNMENT_MISMATCH');
    if (playerRow.normalizerVersion !== inventoryRow.normalizerVersion) blockers.push('NORMALIZER_ALIGNMENT_MISMATCH');
    if (blockers.length > 0) return { ready: false, blockers: blockers.sort() };

    const playerOccurredAtMs = new Date(playerRow.sourceOccurredAt).getTime();
    const inventoryOccurredAtMs = new Date(inventoryRow.sourceOccurredAt).getTime();
    const playerReceivedAtMs = new Date(playerRow.receivedAt).getTime();
    const inventoryReceivedAtMs = new Date(inventoryRow.receivedAt).getTime();
    if (!Number.isFinite(playerOccurredAtMs)) blockers.push('PLAYER_STATE_TIMESTAMP_INVALID');
    if (!Number.isFinite(inventoryOccurredAtMs)) blockers.push('INVENTORY_SNAPSHOT_TIMESTAMP_INVALID');
    if (!Number.isFinite(playerReceivedAtMs)) blockers.push('PLAYER_STATE_RECEIVED_TIMESTAMP_INVALID');
    if (!Number.isFinite(inventoryReceivedAtMs)) blockers.push('INVENTORY_SNAPSHOT_RECEIVED_TIMESTAMP_INVALID');
    if (playerOccurredAtMs > request.decisionAtMs) blockers.push('PLAYER_STATE_FROM_FUTURE');
    if (inventoryOccurredAtMs > request.decisionAtMs) blockers.push('INVENTORY_SNAPSHOT_FROM_FUTURE');
    if (playerReceivedAtMs > request.decisionAtMs) blockers.push('PLAYER_STATE_RECEIVED_AFTER_DECISION');
    if (inventoryReceivedAtMs > request.decisionAtMs) blockers.push('INVENTORY_SNAPSHOT_RECEIVED_AFTER_DECISION');
    if (blockers.length > 0) return { ready: false, blockers: blockers.sort() };

    const catalog = await this.loadCatalog(playerRow.catalogSha256);
    if (!catalog) return { ready: false, blockers: ['CATALOG_VERSION_NOT_FOUND'] };

    let itemGraph: RecommendationItemGraph;
    let compiledRulesetId: string;
    try {
      const compiled = compileStrictRecommendationCatalogV1(catalog);
      itemGraph = compiled.graph;
      compiledRulesetId = compiled.rulesetId;
    } catch (error) {
      return { ready: false, blockers: [`STRICT_RECOMMENDATION_CATALOG_INVALID:${errorMessage(error)}`] };
    }
    if (itemGraph.getAllItems().length === 0) {
      return { ready: false, blockers: ['STRICT_RECOMMENDATION_CATALOG_EMPTY'] };
    }
    if (compiledRulesetId !== playerRow.rulesetVersion) {
      return {
        ready: false,
        blockers: ['CATALOG_RULESET_MISMATCH'],
        rulesetVersion: playerRow.rulesetVersion,
        catalogSha256: playerRow.catalogSha256,
      };
    }

    const playerPayload = playerRow.payload as unknown as PlayerStatePayloadV8;
    const inventoryPayload = inventoryRow.payload as unknown as InventorySnapshotPayloadV8;
    const heroId = playerPayload.heroId;
    if (heroId === undefined || !Number.isInteger(heroId) || heroId <= 0) blockers.push('HERO_ID_MISSING');
    const inventoryItems = inventoryPayload.items ?? [];
    const itemIds = inventoryItems.map((item) => item.itemId);
    for (const inventoryItem of inventoryItems) {
      const catalogItem = itemGraph.getItem(inventoryItem.itemId);
      if (!catalogItem) {
        blockers.push(`INVENTORY_ITEM_NOT_IN_STRICT_CATALOG:${inventoryItem.itemId}`);
        continue;
      }
      if (inventoryItem.slotType && inventoryItem.slotType !== catalogItem.slotType) {
        blockers.push(`INVENTORY_SLOT_CATALOG_MISMATCH:${inventoryItem.itemId}`);
      }
    }
    if (blockers.length > 0) {
      return {
        ready: false,
        blockers: [...new Set(blockers)].sort(),
        rulesetVersion: playerRow.rulesetVersion,
        catalogSha256: playerRow.catalogSha256,
      };
    }

    const directShopOpportunity = approvedDirectShopOpportunityV8(
      playerPayload,
      playerRow.source,
      approvedDirectShopSources,
    );
    const verifiedWallet = playerPayload.spendableSoulsVerified;
    const state: RecommendationDecisionState = {
      decisionId: request.decisionId,
      matchId: request.matchId,
      playerSlot: request.playerSlot,
      gameTimeSec: ((playerRow.gameTimeMs ?? inventoryRow.gameTimeMs ?? 0) / 1000),
      rulesetId: playerRow.rulesetVersion,
      heroId: heroId as number,
      inventory: {
        initializedFromSnapshot: true,
        heldByItemId: buildInventoryInstancesForRecommendation(itemIds, itemGraph),
        lifecycleCountByItemId: new Map(),
        nextInstanceSequence: itemIds.length + 1,
      },
      economy: {
        spendableSouls: verifiedWallet
          ? observedFact(verifiedWallet.value, verifiedWallet.verificationContractVersion)
          : unknownFact('spendableSouls is not server-verified'),
        shopOpportunity: directShopOpportunity === 'UNKNOWN'
          ? unknownFact<ShopOpportunity>('shop opportunity direct signal unavailable or unapproved')
          : observedFact<ShopOpportunity>(
              directShopOpportunity,
              `direct:${playerRow.source}:${playerPayload.shopOpportunityProvenance?.sourceField}`,
            ),
      },
    };

    const slotTypeByItemId = new Map<number, 'weapon' | 'vitality' | 'spirit'>();
    const activeItemIds = new Set<number>();
    for (const definition of itemGraph.getAllItems()) {
      slotTypeByItemId.set(definition.itemId, definition.slotType);
      if (definition.active) activeItemIds.add(definition.itemId);
    }
    const history = [...historyRows]
      .reverse()
      .map(toHistoryEvent)
      .filter((event): event is RecommendationFeatureHistoryEventV8 => event !== undefined);
    const featurePlayerPayload: PlayerStatePayloadV8 = {
      ...playerPayload,
      shopOpportunity: directShopOpportunity,
      shopOpportunityProvenance: directShopOpportunity === 'UNKNOWN'
        ? undefined
        : playerPayload.shopOpportunityProvenance,
    };
    const featureResult = assembleRecommendationFeatureStateV8({
      decision: {
        decisionId: request.decisionId,
        matchId: request.matchId,
        playerKey: request.playerKey,
        decisionAtMs: request.decisionAtMs,
        gameTimeMs: playerRow.gameTimeMs ?? inventoryRow.gameTimeMs,
        rulesetVersion: playerRow.rulesetVersion,
        catalogSha256: playerRow.catalogSha256,
      },
      playerState: {
        sourceOccurredAtMs: playerOccurredAtMs,
        payload: featurePlayerPayload,
      },
      inventorySnapshot: {
        sourceOccurredAtMs: inventoryOccurredAtMs,
        payload: inventoryPayload,
      },
      slotTypeByItemId,
      activeItemIds,
      history,
    });
    if (!featureResult.ready || !featureResult.featureState) {
      return {
        ready: false,
        blockers: featureResult.blockers,
        rulesetVersion: playerRow.rulesetVersion,
        catalogSha256: playerRow.catalogSha256,
      };
    }

    const alignmentAgeMs = Math.max(
      request.decisionAtMs - playerOccurredAtMs,
      request.decisionAtMs - inventoryOccurredAtMs,
      playerRow.alignmentAgeMs,
      inventoryRow.alignmentAgeMs,
    );
    const versions: RecommendationTelemetryVersionsV8 = {
      client: playerRow.clientVersion,
      gep: playerRow.gepVersion,
      normalizer: playerRow.normalizerVersion,
      ruleset: playerRow.rulesetVersion,
      catalogSha256: playerRow.catalogSha256,
    };
    const quality: RecommendationTelemetryQualityV8 = {
      directlyObserved: playerRow.directlyObserved && inventoryRow.directlyObserved,
      reconstructed: playerRow.reconstructed || inventoryRow.reconstructed,
      stale: playerRow.stale || inventoryRow.stale || alignmentAgeMs > maximumAlignmentAgeMs,
      alignmentAgeMs,
    };
    const stateRevision = createStateRevision(playerRow, inventoryRow, approvedDirectShopSourceKeys);

    return {
      ready: true,
      blockers: [],
      state,
      itemGraph,
      featureState: featureResult.featureState,
      stateRevision,
      versions,
      quality,
      rulesetVersion: playerRow.rulesetVersion,
      catalogSha256: playerRow.catalogSha256,
    };
  }

  private async loadCatalog(catalogSha256: string) {
    const versionRows = await this.dataSource.query(
      `SELECT "catalogVersionId", "contentCatalogVersionId", "clientVersion", "rulesetId", "rulesetKey", "source", "payloadSha256", "importedAt"
       FROM item_catalog_versions
       WHERE "payloadSha256" = $1
       ORDER BY "importedAt" DESC
       LIMIT 1`,
      [catalogSha256],
    ) as CatalogVersionRow[];
    const version = versionRows[0];
    if (!version) return undefined;
    const contentCatalogVersionId = version.contentCatalogVersionId ?? version.catalogVersionId;
    const [itemRows, recipeRows] = await Promise.all([
      this.dataSource.query(
        `SELECT "itemId", "name", "className", "itemType", "slotType", "cost", "tier", "shopable", "disabled", "active", "isActiveItem", "activationType", "rawPayload"
         FROM item_catalog_items
         WHERE "catalogVersionId" = $1
         ORDER BY "itemId"`,
        [contentCatalogVersionId],
      ),
      this.dataSource.query(
        `SELECT "parentItemId", "componentItemId", "componentOrder"
         FROM item_catalog_recipes
         WHERE "catalogVersionId" = $1
         ORDER BY "parentItemId", "componentOrder", "componentItemId"`,
        [contentCatalogVersionId],
      ),
    ]) as [CatalogItemRow[], CatalogRecipeRow[]];
    return buildRecommendationRulesetCatalogV1({
      version: {
        catalogVersionId: version.catalogVersionId,
        contentCatalogVersionId: version.contentCatalogVersionId,
        clientVersion: version.clientVersion,
        rulesetId: version.rulesetId === undefined ? undefined : String(version.rulesetId),
        rulesetKey: version.rulesetKey,
        source: version.source,
        payloadSha256: version.payloadSha256,
        importedAt: new Date(version.importedAt).toISOString(),
      },
      items: itemRows.map((item) => ({
        itemId: Number(item.itemId),
        name: item.name,
        className: item.className,
        itemType: item.itemType,
        slotType: item.slotType,
        cost: item.cost === undefined ? undefined : Number(item.cost),
        tier: item.tier === undefined ? undefined : Number(item.tier),
        shopable: item.shopable,
        disabled: item.disabled,
        active: item.active,
        isActiveItem: item.isActiveItem,
        activationType: item.activationType,
        rawPayload: item.rawPayload,
      })),
      recipeEdges: recipeRows.map((recipe) => ({
        parentItemId: Number(recipe.parentItemId),
        componentItemId: Number(recipe.componentItemId),
        componentOrder: Number(recipe.componentOrder),
      })),
    });
  }
}

function validateRequest(request: RecommendationRealtimeStateV8Request): string[] {
  const errors: string[] = [];
  if (!request.decisionId) errors.push('DECISION_ID_REQUIRED');
  if (!request.matchId) errors.push('MATCH_ID_REQUIRED');
  if (!request.playerKey) errors.push('PLAYER_KEY_REQUIRED');
  if (!Number.isInteger(request.playerSlot) || request.playerSlot < 0) errors.push('PLAYER_SLOT_INVALID');
  if (!Number.isFinite(request.decisionAtMs)) errors.push('DECISION_AT_INVALID');
  if (
    request.maximumAlignmentAgeMs !== undefined
    && (!Number.isInteger(request.maximumAlignmentAgeMs) || request.maximumAlignmentAgeMs < 0)
  ) errors.push('MAXIMUM_ALIGNMENT_AGE_INVALID');
  if (
    request.maximumHistoryEvents !== undefined
    && (!Number.isInteger(request.maximumHistoryEvents) || request.maximumHistoryEvents < 0)
  ) errors.push('MAXIMUM_HISTORY_EVENTS_INVALID');
  return errors.sort();
}

function createStateRevision(
  player: TelemetryRow,
  inventory: TelemetryRow,
  approvedDirectShopSourceKeys: readonly string[],
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({
      playerEventId: player.eventId,
      playerSourceEventId: player.sourceEventId,
      inventoryEventId: inventory.eventId,
      inventorySourceEventId: inventory.sourceEventId,
      rulesetVersion: player.rulesetVersion,
      catalogSha256: player.catalogSha256,
      approvedDirectShopSourceKeys: [...approvedDirectShopSourceKeys].sort(),
    }))
    .digest('hex');
  return `recommendation-state-v8:${digest}`;
}

function toHistoryEvent(row: TelemetryRow): RecommendationFeatureHistoryEventV8 | undefined {
  const occurredAtMs = new Date(row.sourceOccurredAt).getTime();
  if (!Number.isFinite(occurredAtMs)) return undefined;
  const payload = row.payload ?? {};
  const actionKey = stringValue(payload.selectedActionKey) ?? stringValue(payload.observedActionKey);
  const itemId = numericValue(payload.itemId) ?? numericValue(payload.targetItemId);
  return {
    occurredAtMs,
    eventType: row.eventType,
    actionKey,
    itemId,
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
