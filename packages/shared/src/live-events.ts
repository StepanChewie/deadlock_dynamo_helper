export type OverwolfLiveEventSource = 'onInfoUpdates2' | 'onNewEvents';

export interface OverwolfLiveEventDto {
  receivedAt: number;
  source: OverwolfLiveEventSource;
  feature?: string;
  category?: string;
  key?: string;
  payload: unknown;
  matchId?: string;
  sequence?: number;
  timestampMs?: number;
}

export interface OverwolfLiveBatchDto {
  clientId: string;
  sentAt?: string;
  events: OverwolfLiveEventDto[];
}

export interface MinimalItemState {
  id: number;
  name: string;
  className: string;
  enhanced: boolean;
  firstSeenAtSec?: number;
}

export interface MinimalPlayerState {
  steamId: string;
  playerName: string;
  isLocal?: boolean;
  heroId?: number;
  heroName?: string;
  teamId?: number;
  lane?: number;
  level?: number;
  souls?: number;
  health?: number;
  maxHealth?: number;
  kills?: number;
  deaths?: number;
  assists?: number;
  heroDamage?: number;
  objectDamage?: number;
  healing?: number;
  items: MinimalItemState[];
}

export interface MinimalMatchState {
  matchId: string;
  gameTimeSec?: number;
  unlockedFlexSlots?: number;
  flexSlotsSource?: string;
  playersBySteamId: Record<string, MinimalPlayerState>;
  lastUpdatedAt: string;
}

interface MinimalPlayerSnapshot {
  steamId: string;
  heroId?: number;
  teamId?: number;
  level?: number;
  souls?: number;
  kills?: number;
  deaths?: number;
  assists?: number;
  heroDamage?: number;
  objectDamage?: number;
  healing?: number;
  itemIds: number[];
}

export interface MinimalMatchSnapshot {
  matchId: string;
  gameTimeSec?: number;
  unlockedFlexSlots?: number;
  flexSlotsSource?: string;
  capturedAt: string;
  playersBySteamId: Record<string, MinimalPlayerSnapshot>;
}
