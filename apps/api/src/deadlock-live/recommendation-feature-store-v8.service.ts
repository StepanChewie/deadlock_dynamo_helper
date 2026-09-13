import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  InventorySnapshotPayloadV8,
  PlayerStatePayloadV8,
  RecommendationFeatureHistoryEventV8,
} from '@deadlock-live-probe/shared';
import {
  RecommendationFeatureAssemblerResultV8,
  assembleRecommendationFeatureStateV8,
} from './recommendation-feature-assembler-v8';
import {
  configuredDirectShopSourceAllowlist,
  sanitizePlayerStateDirectShopV8,
} from './recommendation-direct-shop-source-v8';

interface DecisionRow {
  decisionId: string;
  matchId: string;
  playerKey: string;
  decidedAt: Date | string;
  gameTimeMs?: number;
  rulesetVersion: string;
  catalogSha256: string;
}

interface EventRow {
  eventType: string;
  source: string;
  sourceOccurredAt: Date | string;
  payload: Record<string, unknown>;
}

interface CatalogItemRow {
  itemId: string | number;
  slotType?: string;
  isActiveItem?: boolean;
}

@Injectable()
export class RecommendationFeatureStoreV8Service {
  constructor(private readonly dataSource: DataSource) {}

  async buildForDecision(
    decisionId: string,
    maximumAlignmentAgeMs = 5_000,
    maximumHistoryEvents = 64,
  ): Promise<RecommendationFeatureAssemblerResultV8> {
    if (!decisionId) throw new Error('decisionId is required');
    if (!Number.isInteger(maximumAlignmentAgeMs) || maximumAlignmentAgeMs < 0) {
      throw new Error('maximumAlignmentAgeMs must be a non-negative integer');
    }
    if (!Number.isInteger(maximumHistoryEvents) || maximumHistoryEvents < 0) {
      throw new Error('maximumHistoryEvents must be a non-negative integer');
    }

    const decisions = await this.dataSource.query(
      `SELECT
         "decisionId", "matchId", "playerKey", "decidedAt", "gameTimeMs",
         "rulesetVersion", "catalogSha256"
       FROM recommendation_decisions_v8
       WHERE "decisionId" = $1
       LIMIT 1`,
      [decisionId],
    ) as DecisionRow[];
    const decision = decisions[0];
    if (!decision) return { ready: false, blockers: ['DECISION_NOT_FOUND'] };
    const decisionAt = new Date(decision.decidedAt);
    if (!Number.isFinite(decisionAt.getTime())) return { ready: false, blockers: ['DECISION_TIMESTAMP_INVALID'] };
    const lowerBound = new Date(decisionAt.getTime() - maximumAlignmentAgeMs);
    const approvedDirectShopSources = new Set(configuredDirectShopSourceAllowlist());

    const [playerRows, inventoryRows, catalogRows, historyRows] = await Promise.all([
      this.dataSource.query(
        `SELECT "eventType", "source", "sourceOccurredAt", "payload"
         FROM recommendation_telemetry_events
         WHERE "matchId" = $1
           AND "playerKey" = $2
           AND "eventType" = 'PLAYER_STATE'
           AND "sourceOccurredAt" >= $3
           AND "sourceOccurredAt" <= $4
           AND "receivedAt" <= $4
         ORDER BY "sourceOccurredAt" DESC, "receivedAt" DESC
         LIMIT 1`,
        [decision.matchId, decision.playerKey, lowerBound.toISOString(), decisionAt.toISOString()],
      ),
      this.dataSource.query(
        `SELECT "eventType", "source", "sourceOccurredAt", "payload"
         FROM recommendation_telemetry_events
         WHERE "matchId" = $1
           AND "playerKey" = $2
           AND "eventType" = 'INVENTORY_SNAPSHOT'
           AND "sourceOccurredAt" >= $3
           AND "sourceOccurredAt" <= $4
           AND "receivedAt" <= $4
         ORDER BY "sourceOccurredAt" DESC, "receivedAt" DESC
         LIMIT 1`,
        [decision.matchId, decision.playerKey, lowerBound.toISOString(), decisionAt.toISOString()],
      ),
      this.dataSource.query(
        `SELECT i."itemId", i."slotType", i."isActiveItem"
         FROM item_catalog_items i
         JOIN item_catalog_versions v ON v."catalogVersionId" = i."catalogVersionId"
         WHERE v."payloadSha256" = $1`,
        [decision.catalogSha256],
      ),
      maximumHistoryEvents === 0
        ? Promise.resolve([])
        : this.dataSource.query(
            `SELECT "eventType", "source", "sourceOccurredAt", "payload"
             FROM recommendation_telemetry_events
             WHERE "matchId" = $1
               AND "playerKey" = $2
               AND "sourceOccurredAt" < $3
               AND "receivedAt" <= $3
             ORDER BY "sourceOccurredAt" DESC, "receivedAt" DESC
             LIMIT $4`,
            [decision.matchId, decision.playerKey, decisionAt.toISOString(), maximumHistoryEvents],
          ),
    ]) as [EventRow[], EventRow[], CatalogItemRow[], EventRow[]];

    const slotTypeByItemId = new Map<number, 'weapon' | 'vitality' | 'spirit'>();
    const activeItemIds = new Set<number>();
    for (const row of catalogRows) {
      const itemId = Number(row.itemId);
      const slotType = normalizeSlotType(row.slotType);
      if (Number.isInteger(itemId) && slotType) slotTypeByItemId.set(itemId, slotType);
      if (Number.isInteger(itemId) && row.isActiveItem === true) activeItemIds.add(itemId);
    }

    const player = playerRows[0];
    const inventory = inventoryRows[0];
    const history = [...historyRows]
      .reverse()
      .map(toHistoryEvent)
      .filter((event): event is RecommendationFeatureHistoryEventV8 => event !== undefined);
    const playerPayload = player
      ? sanitizePlayerStateDirectShopV8(
          player.payload as unknown as PlayerStatePayloadV8,
          player.source,
          approvedDirectShopSources,
        )
      : undefined;

    return assembleRecommendationFeatureStateV8({
      decision: {
        decisionId: decision.decisionId,
        matchId: decision.matchId,
        playerKey: decision.playerKey,
        decisionAtMs: decisionAt.getTime(),
        gameTimeMs: decision.gameTimeMs,
        rulesetVersion: decision.rulesetVersion,
        catalogSha256: decision.catalogSha256,
      },
      playerState: player && playerPayload
        ? {
            sourceOccurredAtMs: new Date(player.sourceOccurredAt).getTime(),
            payload: playerPayload,
          }
        : undefined,
      inventorySnapshot: inventory
        ? {
            sourceOccurredAtMs: new Date(inventory.sourceOccurredAt).getTime(),
            payload: inventory.payload as unknown as InventorySnapshotPayloadV8,
          }
        : undefined,
      slotTypeByItemId,
      activeItemIds,
      history,
    });
  }
}

function normalizeSlotType(value: string | undefined): 'weapon' | 'vitality' | 'spirit' | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'weapon' || normalized === 'vitality' || normalized === 'spirit') return normalized;
  return undefined;
}

function toHistoryEvent(row: EventRow): RecommendationFeatureHistoryEventV8 | undefined {
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
