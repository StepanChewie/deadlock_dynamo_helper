import { Injectable } from '@nestjs/common';
import {
  OverwolfLiveBatchDto,
  OverwolfLiveEventDto,
} from '@dynamo-lab/shared';

interface LiveItemMetadata {
  name: string;
  className: string;
}

const INT32_MIN = -0x80000000;
const UINT32_MAX = 0xffffffff;
const UINT32_MODULUS = 0x100000000;

@Injectable()
export class LiveInventoryEventNormalizerService {
  private readonly metadataByItemId = new Map<number, LiveItemMetadata>();
  private readonly steamIdByClientAndRosterSlot = new Map<string, Map<string, string>>();
  private readonly steamIdsByClientAndPlayerName = new Map<string, Map<string, Set<string>>>();
  private readonly localSteamIdByClientId = new Map<string, string>();
  private readonly matchIdByClientId = new Map<string, string>();

  normalizeBatch(batch: OverwolfLiveBatchDto): OverwolfLiveBatchDto {
    this.resetRosterIdentityWhenMatchChanges(batch);
    this.captureLocalSteamId(batch.clientId, batch.events);
    this.captureRosterIdentities(batch.clientId, batch.events);

    return {
      ...batch,
      events: batch.events.map((event) => this.normalizeEvent(batch.clientId, event)),
    };
  }

  private captureLocalSteamId(
    clientId: string,
    events: readonly OverwolfLiveEventDto[],
  ): void {
    for (const event of events) {
      if (event.key !== 'steam_id') {
        continue;
      }

      const steamId = readSteamId(event.payload);
      if (steamId && steamId !== '0') {
        this.localSteamIdByClientId.set(clientId, steamId);
        return;
      }
    }
  }

  private captureRosterIdentities(
    clientId: string,
    events: readonly OverwolfLiveEventDto[],
  ): void {
    const rosterSlots = this.getRosterSlots(clientId);
    const steamIdsByPlayerName = this.getSteamIdsByPlayerName(clientId);
    const localSteamId = this.localSteamIdByClientId.get(clientId);

    for (const event of events) {
      if (!event.key?.startsWith('roster_') || !isRecord(event.payload)) {
        continue;
      }

      const rawSteamId = readSteamId(event.payload.steam_id ?? event.payload.steamId);
      const directSteamId = rawSteamId && rawSteamId !== '0' ? rawSteamId : undefined;
      const isLocal = readBoolean(event.payload.is_local ?? event.payload.isLocal);
      const resolvedSteamId =
        directSteamId
          ? directSteamId
          : isLocal && localSteamId
            ? localSteamId
            : undefined;

      if (resolvedSteamId) {
        rosterSlots.set(event.key, resolvedSteamId);
      }

      const playerName = readString(event.payload.player_name ?? event.payload.playerName);
      if (!playerName || !resolvedSteamId || resolvedSteamId === '0') {
        continue;
      }

      const nameKey = normalizePlayerName(playerName);
      const existing = steamIdsByPlayerName.get(nameKey) ?? new Set<string>();
      existing.add(resolvedSteamId);
      steamIdsByPlayerName.set(nameKey, existing);
    }
  }

  private normalizeEvent(
    clientId: string,
    event: OverwolfLiveEventDto,
  ): OverwolfLiveEventDto {
    if (
      !event.key?.startsWith('items') ||
      !isRecord(event.payload) ||
      !Array.isArray(event.payload.items)
    ) {
      return event;
    }

    const rosterSlot = event.key.startsWith('items_')
      ? `roster_${event.key.slice('items_'.length)}`
      : undefined;
    const rawSteamId = readSteamId(event.payload.steam_id ?? event.payload.steamId);
    const directSteamId = rawSteamId && rawSteamId !== '0' ? rawSteamId : undefined;
    const playerName = readString(event.payload.player_name ?? event.payload.playerName);
    const steamId = directSteamId
      ?? (rosterSlot ? this.getRosterSlots(clientId).get(rosterSlot) : undefined)
      ?? this.resolveUniqueSteamIdByPlayerName(clientId, playerName);
    const items = event.payload.items
      .map((item) => this.normalizeItem(item))
      .filter((item): item is Record<string, unknown> => item !== undefined);

    return {
      ...event,
      payload: {
        ...event.payload,
        ...(steamId ? { steam_id: steamId } : {}),
        items,
      },
    };
  }

  private resolveUniqueSteamIdByPlayerName(
    clientId: string,
    playerName: string | undefined,
  ): string | undefined {
    if (!playerName) {
      return undefined;
    }

    const candidates = this.getSteamIdsByPlayerName(clientId).get(
      normalizePlayerName(playerName),
    );
    if (!candidates || candidates.size !== 1) {
      return undefined;
    }

    return candidates.values().next().value;
  }

  private resetRosterIdentityWhenMatchChanges(batch: OverwolfLiveBatchDto): void {
    const matchId = extractMatchId(batch.events);
    if (!matchId) {
      return;
    }

    const previousMatchId = this.matchIdByClientId.get(batch.clientId);
    if (previousMatchId && previousMatchId !== matchId) {
      this.steamIdByClientAndRosterSlot.delete(batch.clientId);
      this.steamIdsByClientAndPlayerName.delete(batch.clientId);
      this.localSteamIdByClientId.delete(batch.clientId);
    }
    this.matchIdByClientId.set(batch.clientId, matchId);
  }

  private getRosterSlots(clientId: string): Map<string, string> {
    const existing = this.steamIdByClientAndRosterSlot.get(clientId);
    if (existing) {
      return existing;
    }

    const created = new Map<string, string>();
    this.steamIdByClientAndRosterSlot.set(clientId, created);
    return created;
  }

  private getSteamIdsByPlayerName(clientId: string): Map<string, Set<string>> {
    const existing = this.steamIdsByClientAndPlayerName.get(clientId);
    if (existing) {
      return existing;
    }

    const created = new Map<string, Set<string>>();
    this.steamIdsByClientAndPlayerName.set(clientId, created);
    return created;
  }

  private normalizeItem(value: unknown): Record<string, unknown> | undefined {
    if (!isRecord(value)) {
      return undefined;
    }

    const id = readDeadlockItemId(value.id ?? value.item_id ?? value.itemId);
    if (id === undefined) {
      return undefined;
    }

    const cached = this.metadataByItemId.get(id);
    const name = readString(value.name ?? value.item_name ?? value.itemName)
      ?? cached?.name
      ?? `Item ${id}`;
    const className = readString(value.class_name ?? value.className)
      ?? cached?.className
      ?? `item_${id}`;

    this.metadataByItemId.set(id, { name, className });

    return {
      ...value,
      id,
      name,
      class_name: className,
      enhanced: readBoolean(value.enhanced),
    };
  }
}

function extractMatchId(events: readonly OverwolfLiveEventDto[]): string | undefined {
  for (const event of events) {
    const explicitMatchId = readString(event.matchId);
    if (explicitMatchId) {
      return explicitMatchId;
    }
    if (event.key === 'match_id') {
      const payloadMatchId = readStringOrNumber(event.payload);
      if (payloadMatchId) {
        return payloadMatchId;
      }
    }
  }
  return undefined;
}

function normalizePlayerName(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readDeadlockItemId(value: unknown): number | undefined {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value)
      : Number.NaN;

  if (!Number.isSafeInteger(parsed) || parsed === 0) {
    return undefined;
  }
  if (parsed > 0 && parsed <= UINT32_MAX) {
    return parsed;
  }
  if (parsed >= INT32_MIN && parsed < 0) {
    return parsed + UINT32_MODULUS;
  }
  return undefined;
}

function readSteamId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return readString(value);
}

function readStringOrNumber(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return readString(value);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
}

function readBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  return value === 'true' || value === '1';
}
