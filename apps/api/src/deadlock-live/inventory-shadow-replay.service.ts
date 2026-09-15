import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { OverwolfLiveBatchDto, OverwolfLiveEventDto } from '@dynamo-lab/shared';
import {
  createEmptyInventoryState,
  createRecipeGraph,
  InventoryAction,
  InventoryItem,
  InventoryItemInstance,
  InventoryState,
  normalizeInventorySnapshot,
  RecipeDefinition,
  RecipeGraph,
  SnapshotDiagnostic,
} from '@dynamo-lab/build-domain';
import { Repository } from 'typeorm';
import { ItemComponent } from './entities/item-component.entity';

interface InventoryShadowDiagnostic extends SnapshotDiagnostic {
  observedAtMs: number;
  gameTimeSec?: number;
}

interface InventoryShadowTimeline {
  matchId: string;
  steamId: string;
  gameTimeSec?: number;
  lastObservedAtMs: number;
  state: InventoryState;
  actions: InventoryAction[];
  diagnostics: InventoryShadowDiagnostic[];
}

export interface InventoryShadowTimelineDto {
  matchId: string;
  steamId: string;
  gameTimeSec?: number;
  lastObservedAtMs: number;
  heldItems: InventoryItemInstance[];
  actions: InventoryAction[];
  diagnostics: InventoryShadowDiagnostic[];
}

@Injectable()
export class InventoryShadowReplayService implements OnModuleInit {
  private readonly logger = new Logger(InventoryShadowReplayService.name);
  private readonly maxActionsPerPlayer = 500;
  private readonly maxDiagnosticsPerPlayer = 200;
  private readonly timelines = new Map<string, InventoryShadowTimeline>();
  private readonly clientMatchIds = new Map<string, string>();
  private readonly clientGameTimes = new Map<string, number>();
  private recipeGraph: RecipeGraph = createRecipeGraph([]);

  constructor(
    @InjectRepository(ItemComponent)
    private readonly itemComponentRepository: Repository<ItemComponent>,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.refreshRecipes();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Inventory shadow replay started without recipes: ${message}`);
    }
  }

  async refreshRecipes(): Promise<number> {
    const componentRows = await this.itemComponentRepository.find({
      order: {
        parentItemId: 'ASC',
        componentOrder: 'ASC',
      },
    });
    const componentsByParent = new Map<number, number[]>();

    for (const row of componentRows) {
      const parentItemId = Number(row.parentItemId);
      const componentItemId = Number(row.componentItemId);
      if (!Number.isFinite(parentItemId) || !Number.isFinite(componentItemId)) {
        continue;
      }
      const components = componentsByParent.get(parentItemId) ?? [];
      components.push(componentItemId);
      componentsByParent.set(parentItemId, components);
    }

    const definitions: RecipeDefinition[] = [...componentsByParent.entries()].map(
      ([parentItemId, componentItemIds]) => ({ parentItemId, componentItemIds }),
    );
    this.recipeGraph = createRecipeGraph(definitions);
    this.logger.log(`Loaded ${definitions.length} item recipes for inventory shadow replay.`);
    return definitions.length;
  }

  applyBatch(batch: OverwolfLiveBatchDto, resolvedMatchId?: string): void {
    const previousMatchId = this.clientMatchIds.get(batch.clientId);
    const extractedMatchId = this.extractMatchId(batch.events);
    const matchId = resolvedMatchId ?? extractedMatchId ?? previousMatchId ?? 'unknown';

    if (previousMatchId === 'unknown' && matchId !== 'unknown') {
      this.migrateUnknownTimelines(matchId);
    }
    this.clientMatchIds.set(batch.clientId, matchId);

    for (const event of batch.events) {
      if (event.key === 'match_clock') {
        const gameTimeSec = this.parseClockSeconds(event.payload);
        if (gameTimeSec !== undefined) {
          this.clientGameTimes.set(batch.clientId, gameTimeSec);
        }
        continue;
      }

      if (!event.key?.startsWith('items')) {
        continue;
      }

      this.applyItemsSnapshot(
        matchId,
        batch.clientId,
        event,
        this.clientGameTimes.get(batch.clientId),
      );
    }
  }

  getMatchTimelines(matchId: string): InventoryShadowTimelineDto[] {
    return [...this.timelines.values()]
      .filter((timeline) => timeline.matchId === matchId)
      .map((timeline) => this.toDto(timeline));
  }

  getPlayerTimeline(matchId: string, steamId: string): InventoryShadowTimelineDto | undefined {
    const timeline = this.timelines.get(this.timelineKey(matchId, steamId));
    return timeline ? this.toDto(timeline) : undefined;
  }

  private applyItemsSnapshot(
    matchId: string,
    clientId: string,
    event: OverwolfLiveEventDto,
    gameTimeSec: number | undefined,
  ): void {
    const payload = this.toRecord(event.payload);
    if (!payload) {
      return;
    }

    const steamId = this.getStringValue(payload, 'steam_id');
    if (!steamId) {
      return;
    }

    const snapshotItems = this.parseItems(payload.items);
    const key = this.timelineKey(matchId, steamId);
    const previous = this.timelines.get(key) ?? {
      matchId,
      steamId,
      gameTimeSec,
      lastObservedAtMs: event.receivedAt,
      state: createEmptyInventoryState(),
      actions: [],
      diagnostics: [],
    };

    const result = normalizeInventorySnapshot({
      state: previous.state,
      snapshotItems,
      recipeGraph: this.recipeGraph,
      observedAtMs: event.receivedAt,
      gameTimeSec,
    });
    const diagnostics = result.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      observedAtMs: event.receivedAt,
      gameTimeSec,
    }));

    this.timelines.set(key, {
      ...previous,
      matchId,
      steamId,
      gameTimeSec,
      lastObservedAtMs: event.receivedAt,
      state: result.state,
      actions: [...previous.actions, ...result.actions].slice(-this.maxActionsPerPlayer),
      diagnostics: [...previous.diagnostics, ...diagnostics].slice(-this.maxDiagnosticsPerPlayer),
    });
    this.clientMatchIds.set(clientId, matchId);
  }

  private parseItems(value: unknown): InventoryItem[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const items: InventoryItem[] = [];
    for (const rawItem of value) {
      const item = this.toRecord(rawItem);
      if (!item) {
        continue;
      }
      const itemId = this.getNumericValue(item, 'id');
      if (itemId === undefined || itemId <= 0) {
        continue;
      }
      items.push({
        itemId,
        name: this.getStringValue(item, 'name'),
        className: this.getStringValue(item, 'class_name'),
        enhanced: this.getBooleanValue(item, 'enhanced'),
      });
    }
    return items;
  }

  private extractMatchId(events: OverwolfLiveEventDto[]): string | undefined {
    for (const event of events) {
      if (typeof event.matchId === 'string' && event.matchId.length > 0) {
        return event.matchId;
      }
      if (event.key === 'match_id') {
        if (typeof event.payload === 'string' && event.payload.length > 0) {
          return event.payload;
        }
        if (typeof event.payload === 'number' && Number.isFinite(event.payload)) {
          return String(event.payload);
        }
      }
    }
    return undefined;
  }

  private migrateUnknownTimelines(matchId: string): void {
    for (const [key, timeline] of [...this.timelines.entries()]) {
      if (timeline.matchId !== 'unknown') {
        continue;
      }
      this.timelines.delete(key);
      const nextKey = this.timelineKey(matchId, timeline.steamId);
      const existing = this.timelines.get(nextKey);
      this.timelines.set(nextKey, {
        ...(existing ?? timeline),
        matchId,
        actions: [...timeline.actions, ...(existing?.actions ?? [])].slice(-this.maxActionsPerPlayer),
        diagnostics: [...timeline.diagnostics, ...(existing?.diagnostics ?? [])].slice(
          -this.maxDiagnosticsPerPlayer,
        ),
      });
    }
  }

  private parseClockSeconds(payload: unknown): number | undefined {
    if (typeof payload !== 'string') {
      return undefined;
    }
    const parts = payload.split(':').map((part) => Number.parseInt(part, 10));
    if (parts.length < 2 || parts.length > 3 || parts.some((part) => Number.isNaN(part))) {
      return undefined;
    }
    if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    }
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }

  private toDto(timeline: InventoryShadowTimeline): InventoryShadowTimelineDto {
    return {
      matchId: timeline.matchId,
      steamId: timeline.steamId,
      gameTimeSec: timeline.gameTimeSec,
      lastObservedAtMs: timeline.lastObservedAtMs,
      heldItems: [...timeline.state.heldByItemId.values()].sort((a, b) => a.itemId - b.itemId),
      actions: [...timeline.actions],
      diagnostics: [...timeline.diagnostics],
    };
  }

  private timelineKey(matchId: string, steamId: string): string {
    return `${matchId}:${steamId}`;
  }

  private toRecord(value: unknown): Record<string, unknown> | undefined {
    if (typeof value === 'object' && value !== null) {
      return value as Record<string, unknown>;
    }
    if (typeof value !== 'string') {
      return undefined;
    }
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }

  private getStringValue(record: Record<string, unknown>, key: string): string | undefined {
    const value = record[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  private getNumericValue(record: Record<string, unknown>, key: string): number | undefined {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
  }

  private getBooleanValue(record: Record<string, unknown>, key: string): boolean | undefined {
    const value = record[key];
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'number') {
      return value !== 0;
    }
    if (typeof value === 'string') {
      if (value === 'true' || value === '1') return true;
      if (value === 'false' || value === '0') return false;
    }
    return undefined;
  }
}
