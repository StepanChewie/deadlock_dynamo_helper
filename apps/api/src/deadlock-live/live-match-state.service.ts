import { Injectable } from '@nestjs/common';
import {
  MinimalItemState,
  MinimalMatchState,
  MinimalMatchSnapshot,
  MinimalPlayerState,
  OverwolfLiveBatchDto,
  OverwolfLiveEventDto,
} from '@dynamo-lab/shared';

const EXPLICIT_FLEX_EVENT_KEYS = new Set([
  'flex_slots',
  'unlocked_flex_slots',
  'flex_slot_count',
]);

const EXPLICIT_FLEX_PAYLOAD_KEYS = [
  'unlocked_flex_slots',
  'flex_slots',
  'flex_slot_count',
] as const;

@Injectable()
export class LiveMatchStateService {
  private readonly snapshotIntervalSec = 30;
  private readonly maxSnapshotsPerMatch = 120;
  private readonly states = new Map<string, MinimalMatchState>();
  private readonly clientMatchIds = new Map<string, string>();
  private readonly clientLocalSteamIds = new Map<string, string>();
  private readonly clientLocalRosterSlots = new Map<string, string>();
  private readonly snapshots = new Map<string, MinimalMatchSnapshot[]>();

  applyBatch(batch: OverwolfLiveBatchDto): MinimalMatchState | undefined {
    const extractedMatchId = this.extractMatchId(batch.events);
    const extractedLocalSteamId = this.extractLocalSteamId(batch.events);
    const previousMatchId = this.clientMatchIds.get(batch.clientId);
    const currentMatchId = extractedMatchId ?? previousMatchId ?? 'unknown';
    const state = this.getOrCreateState(currentMatchId, previousMatchId, extractedMatchId);

    if (
      previousMatchId &&
      previousMatchId !== 'unknown' &&
      extractedMatchId &&
      previousMatchId !== extractedMatchId
    ) {
      this.clientLocalRosterSlots.delete(batch.clientId);
      this.clientLocalSteamIds.delete(batch.clientId);
    }
    if (extractedLocalSteamId) {
      this.clientLocalSteamIds.set(batch.clientId, extractedLocalSteamId);
    }

    const localSteamId = extractedLocalSteamId ?? this.clientLocalSteamIds.get(batch.clientId);
    this.clientMatchIds.set(batch.clientId, currentMatchId);

    let shouldSnapshot = false;
    for (const event of batch.events) {
      shouldSnapshot = this.applyEvent(
        state,
        event,
        batch.clientId,
        localSteamId,
      ) || shouldSnapshot;
    }

    state.lastUpdatedAt = new Date().toISOString();
    this.states.set(currentMatchId, state);
    this.captureSnapshotIfNeeded(state, shouldSnapshot);

    return state;
  }

  getState(matchId: string): MinimalMatchState | undefined {
    return this.states.get(matchId);
  }

  getAllStates(): MinimalMatchState[] {
    return [...this.states.values()];
  }

  getSnapshots(matchId: string): MinimalMatchSnapshot[] {
    return [...(this.snapshots.get(matchId) ?? [])];
  }

  private getOrCreateState(
    currentMatchId: string,
    previousMatchId: string | undefined,
    extractedMatchId: string | undefined,
  ): MinimalMatchState {
    if (previousMatchId === 'unknown' && extractedMatchId && extractedMatchId !== 'unknown') {
      return this.migrateUnknownState(extractedMatchId);
    }

    return (
      this.states.get(currentMatchId) ?? {
        matchId: currentMatchId,
        playersBySteamId: {},
        lastUpdatedAt: new Date().toISOString(),
      }
    );
  }

  private migrateUnknownState(matchId: string): MinimalMatchState {
    const unknownState = this.states.get('unknown');
    const existingState = this.states.get(matchId);

    if (!unknownState) {
      return (
        existingState ?? {
          matchId,
          playersBySteamId: {},
          lastUpdatedAt: new Date().toISOString(),
        }
      );
    }

    if (!existingState) {
      this.states.delete('unknown');
      return {
        ...unknownState,
        matchId,
      };
    }

    this.states.delete('unknown');

    return {
      ...unknownState,
      ...existingState,
      matchId,
      playersBySteamId: this.mergePlayersBySteamId(
        unknownState.playersBySteamId,
        existingState.playersBySteamId,
      ),
    };
  }

  private mergePlayersBySteamId(
    basePlayers: Record<string, MinimalPlayerState>,
    nextPlayers: Record<string, MinimalPlayerState>,
  ): Record<string, MinimalPlayerState> {
    const mergedPlayers: Record<string, MinimalPlayerState> = { ...basePlayers };

    for (const [steamId, nextPlayer] of Object.entries(nextPlayers)) {
      mergedPlayers[steamId] = {
        ...(mergedPlayers[steamId] ?? {}),
        ...nextPlayer,
      };
    }

    return mergedPlayers;
  }

  private applyEvent(
    state: MinimalMatchState,
    event: OverwolfLiveEventDto,
    clientId: string,
    localSteamId?: string,
  ): boolean {
    if (event.key === 'match_clock') {
      const seconds = this.parseClockSeconds(event.payload);
      if (seconds !== undefined) {
        state.gameTimeSec = seconds;
      }
      return false;
    }

    const observedFlexSlots = this.extractExplicitFlexSlots(event);
    if (observedFlexSlots !== undefined) {
      const changed = state.unlockedFlexSlots !== observedFlexSlots;
      state.unlockedFlexSlots = observedFlexSlots;
      state.flexSlotsSource = `overwolf:${event.key ?? 'payload'}`;
      return changed;
    }

    if (event.key?.startsWith('roster')) {
      this.applyRosterPayload(state, event.payload, event.key, clientId, localSteamId);
      return false;
    }

    if (event.key?.startsWith('items')) {
      return this.applyItemsPayload(state, event.payload, event.key, clientId, localSteamId);
    }

    return false;
  }

  private extractExplicitFlexSlots(event: OverwolfLiveEventDto): number | undefined {
    if (event.key && EXPLICIT_FLEX_EVENT_KEYS.has(event.key)) {
      const scalar = this.getNonNegativeInteger(event.payload);
      if (scalar !== undefined) return scalar;
    }

    if (!this.isRecord(event.payload)) return undefined;
    for (const key of EXPLICIT_FLEX_PAYLOAD_KEYS) {
      if (!(key in event.payload)) continue;
      const value = this.getNonNegativeInteger(event.payload[key]);
      if (value !== undefined) return value;
    }
    return undefined;
  }

  private extractMatchId(events: OverwolfLiveEventDto[]): string | undefined {
    for (const event of events) {
      if (typeof event.matchId === 'string' && event.matchId.length > 0) {
        return event.matchId;
      }

      if (event.key === 'match_id' && typeof event.payload === 'string' && event.payload.length > 0) {
        return event.payload;
      }

      if (this.isRecord(event.payload)) {
        const payloadMatchId = this.getStringValue(event.payload, 'match_id');
        if (payloadMatchId) {
          return payloadMatchId;
        }
      }
    }

    return undefined;
  }

  private extractLocalSteamId(events: OverwolfLiveEventDto[]): string | undefined {
    for (const event of events) {
      if (event.key !== 'steam_id') {
        continue;
      }

      const steamId = this.getScalarString(event.payload);
      if (steamId && steamId !== '0') {
        return steamId;
      }
    }

    return undefined;
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
      const [minutes, seconds] = parts;
      return minutes * 60 + seconds;
    }

    const [hours, minutes, seconds] = parts;
    return hours * 3600 + minutes * 60 + seconds;
  }

  private applyRosterPayload(
    state: MinimalMatchState,
    payload: unknown,
    eventKey: string,
    clientId: string,
    localSteamId?: string,
  ): void {
    if (!this.isRecord(payload)) {
      return;
    }

    const playerKey = this.resolvePlayerKey(payload, eventKey, clientId, localSteamId);
    if (!playerKey) {
      return;
    }

    // A roster slot that has revealed its real steam id supersedes the synthetic
    // `bot:<slot>` player created while the id was still unknown.
    //
    // The synthetic entry is never written to again -- every later event for the
    // slot resolves to the steam id -- so it keeps whatever placeholder arrived
    // first, typically hero_id 0 or 55 with hero_name "UNKNOWN". Left in place it
    // inflates the roster for the whole match: on 2026-09-17, match 106167848,
    // the state held 20 players for a 12-player match, so the enemy roster
    // counted 8 heroes instead of 6 and every request from the first second of
    // the match to the twelfth minute came back ENEMY_ROSTER_INCOMPLETE.
    const rosterSlot = this.rosterSlotForEvent(eventKey);
    if (rosterSlot && playerKey !== `bot:${rosterSlot}`) {
      delete state.playersBySteamId[`bot:${rosterSlot}`];
    }

    const player = this.getOrCreatePlayer(state, playerKey);
    const playerName = this.getStringValue(payload, 'player_name');
    const heroName = this.getStringValue(payload, 'hero_name');
    const heroId = this.getNumericValue(payload, 'hero_id');
    const teamId =
      this.getNumericValue(payload, 'team_id') ??
      this.getNumericValue(payload, 'team');
    const lane =
      this.getNumericValue(payload, 'assigned_lane') ??
      this.getNumericValue(payload, 'lane');
    const level = this.getNumericValue(payload, 'level');
    const souls = this.getNumericValue(payload, 'souls');
    const health = this.getNumericValue(payload, 'health');
    const maxHealth = this.getNumericValue(payload, 'max_health');
    const kills = this.getNumericValue(payload, 'kills');
    const deaths = this.getNumericValue(payload, 'deaths');
    const assists =
      this.getNumericValue(payload, 'assist') ??
      this.getNumericValue(payload, 'assists');
    const heroDamage = this.getNumericValue(payload, 'hero_damage');
    const objectDamage = this.getNumericValue(payload, 'object_damage');
    const healing =
      this.getNumericValue(payload, 'hero_healing') ??
      this.getNumericValue(payload, 'healing');

    if (playerName !== undefined) player.playerName = playerName;
    if ('is_local' in payload || 'isLocal' in payload) {
      player.isLocal = this.getBooleanValue(payload, 'is_local') || this.getBooleanValue(payload, 'isLocal');
    }
    if (heroName !== undefined) player.heroName = heroName;
    if (heroId !== undefined) player.heroId = heroId;
    if (teamId !== undefined) player.teamId = teamId;
    if (lane !== undefined) player.lane = lane;
    if (level !== undefined) player.level = level;
    if (souls !== undefined) player.souls = souls;
    if (health !== undefined) player.health = health;
    if (maxHealth !== undefined) player.maxHealth = maxHealth;
    if (kills !== undefined) player.kills = kills;
    if (deaths !== undefined) player.deaths = deaths;
    if (assists !== undefined) player.assists = assists;
    if (heroDamage !== undefined) player.heroDamage = heroDamage;
    if (objectDamage !== undefined) player.objectDamage = objectDamage;
    if (healing !== undefined) player.healing = healing;
  }

  private applyItemsPayload(
    state: MinimalMatchState,
    payload: unknown,
    eventKey: string,
    clientId: string,
    localSteamId?: string,
  ): boolean {
    if (!this.isRecord(payload)) return false;

    const playerKey = this.resolvePlayerKey(payload, eventKey, clientId, localSteamId);
    if (!playerKey) return false;

    const itemsValue = payload.items;
    if (!Array.isArray(itemsValue)) return false;

    const player = this.getOrCreatePlayer(state, playerKey);
    const nextItems: MinimalItemState[] = [];

    for (const item of itemsValue) {
      if (!this.isRecord(item)) continue;

      const id = this.getNumericValue(item, 'id');
      const name = this.getStringValue(item, 'name');
      const className = this.getStringValue(item, 'class_name');
      if (id === undefined || name === undefined || className === undefined) continue;

      nextItems.push({
        id,
        name,
        className,
        enhanced: this.getBooleanValue(item, 'enhanced'),
        firstSeenAtSec: state.gameTimeSec,
      });
    }

    const previousKey = this.itemIdentityKey(player.items);
    const nextKey = this.itemIdentityKey(nextItems);
    player.items = nextItems;
    return previousKey !== nextKey;
  }

  private resolvePlayerKey(
    payload: Record<string, unknown>,
    eventKey: string,
    clientId: string,
    localSteamId?: string,
  ): string | undefined {
    const steamId = this.getStringValue(payload, 'steam_id');
    const rosterSlot = this.rosterSlotForEvent(eventKey);
    const isLocal = this.getBooleanValue(payload, 'is_local') || this.getBooleanValue(payload, 'isLocal');

    if (isLocal && rosterSlot) this.clientLocalRosterSlots.set(clientId, rosterSlot);
    if (steamId && steamId !== '0') return steamId;
    if (isLocal && localSteamId) return localSteamId;
    if (rosterSlot && this.clientLocalRosterSlots.get(clientId) === rosterSlot && localSteamId) return localSteamId;
    if (!steamId) return undefined;
    if (rosterSlot) return `bot:${rosterSlot}`;

    const teamId = this.getNumericValue(payload, 'team_id') ?? this.getNumericValue(payload, 'team') ?? 'unknown';
    const heroId = this.getNumericValue(payload, 'hero_id') ?? 'unknown';
    const playerName = this.getStringValue(payload, 'player_name') ?? 'unknown';
    return `bot:${teamId}:${heroId}:${playerName}`;
  }

  private rosterSlotForEvent(eventKey: string): string | undefined {
    if (eventKey.startsWith('roster_')) return eventKey;
    if (eventKey.startsWith('items_')) return `roster_${eventKey.slice('items_'.length)}`;
    return undefined;
  }

  private captureSnapshotIfNeeded(state: MinimalMatchState, force: boolean): void {
    if (!state.matchId || state.matchId === 'unknown') return;

    const existing = this.snapshots.get(state.matchId) ?? [];
    const latest = existing[existing.length - 1];
    const gameTimeSec = state.gameTimeSec;
    const intervalElapsed =
      gameTimeSec !== undefined &&
      (latest?.gameTimeSec === undefined || gameTimeSec - latest.gameTimeSec >= this.snapshotIntervalSec);

    if (!force && !intervalElapsed && existing.length > 0) return;

    const snapshot: MinimalMatchSnapshot = {
      matchId: state.matchId,
      gameTimeSec,
      unlockedFlexSlots: state.unlockedFlexSlots,
      flexSlotsSource: state.flexSlotsSource,
      capturedAt: new Date().toISOString(),
      playersBySteamId: Object.entries(state.playersBySteamId).reduce<
        Record<string, MinimalMatchSnapshot['playersBySteamId'][string]>
      >((acc, [steamId, player]) => {
        acc[steamId] = {
          steamId,
          heroId: player.heroId,
          teamId: player.teamId,
          level: player.level,
          souls: player.souls,
          kills: player.kills,
          deaths: player.deaths,
          assists: player.assists,
          heroDamage: player.heroDamage,
          objectDamage: player.objectDamage,
          healing: player.healing,
          itemIds: player.items.map((item) => item.id),
        };
        return acc;
      }, {}),
    };

    const nextSnapshots = [...existing, snapshot].slice(-this.maxSnapshotsPerMatch);
    this.snapshots.set(state.matchId, nextSnapshots);
  }

  private itemIdentityKey(items: MinimalItemState[]): string {
    return items.map((item) => item.id).sort((a, b) => a - b).join(',');
  }

  private getOrCreatePlayer(state: MinimalMatchState, steamId: string): MinimalPlayerState {
    const existing = state.playersBySteamId[steamId];
    if (existing) return existing;

    const created: MinimalPlayerState = {
      steamId,
      playerName: '',
      items: [],
    };
    state.playersBySteamId[steamId] = created;
    return created;
  }

  private getScalarString(value: unknown): string | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed || undefined;
  }

  private getStringValue(record: Record<string, unknown>, key: string): string | undefined {
    const value = record[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  private getNumericValue(record: Record<string, unknown>, key: string): number | undefined {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
  }

  private getNonNegativeInteger(value: unknown): number | undefined {
    const numeric = typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : undefined;
    if (!Number.isInteger(numeric) || Number(numeric) < 0) return undefined;
    return Number(numeric);
  }

  private getBooleanValue(record: Record<string, unknown>, key: string): boolean {
    const value = record[key];
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') return value === 'true' || value === '1';
    return false;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }
}
