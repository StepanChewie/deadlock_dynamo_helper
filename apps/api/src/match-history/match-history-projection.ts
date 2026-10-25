import { OverwolfLiveBatchDto, OverwolfLiveEventDto } from '@dynamo-lab/shared';
import { MatchHistoryPlayer } from './match-history.types';

export interface MatchHistoryProjection {
  matchId: string;
  localSteamId: string;
  clientId: string;
  players: MatchHistoryPlayer[];
  durationSec?: number;
}

/** Same containment rule as the raw event log: a match id is one path/db segment. */
function sanitizeMatchId(matchId: string): string {
  return matchId.replace(/[/\\]/g, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function num(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function str(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Legacy-state roster payload → stored player snapshot. */
function payloadToPlayer(payload: Record<string, unknown>): MatchHistoryPlayer {
  const player: MatchHistoryPlayer = {
    steamId: str(payload, 'steam_id'),
    name: str(payload, 'player_name'),
    isLocal: payload.is_local === true,
    heroId: num(payload, 'hero_id'),
    heroName: str(payload, 'hero_name'),
    team: num(payload, 'team'),
    lane: num(payload, 'lane'),
    level: num(payload, 'level'),
    souls: num(payload, 'souls'),
    kills: num(payload, 'kills'),
    deaths: num(payload, 'deaths'),
    assists: num(payload, 'assists'),
    heroDamage: num(payload, 'hero_damage'),
    objectDamage: num(payload, 'object_damage'),
    healing: num(payload, 'healing'),
  };
  for (const key of Object.keys(player) as (keyof MatchHistoryPlayer)[]) {
    if (player[key] === undefined) delete player[key];
  }
  return player;
}

function mergePlayer(previous: MatchHistoryPlayer | undefined, next: MatchHistoryPlayer): MatchHistoryPlayer {
  if (!previous) return { ...next };
  const merged: MatchHistoryPlayer = { ...previous };
  // `as never`: TS 5.9 rejects a write to a union-keyed indexed access whose
  // value type it cannot prove matches the specific key; runtime behavior is
  // unchanged (only defined fields are copied, final value wins).
  for (const key of Object.keys(next) as (keyof MatchHistoryPlayer)[]) {
    if (next[key] !== undefined) merged[key] = next[key] as never;
  }
  return merged;
}

/** "mm:ss" or "h:mm:ss" — same shapes `parseClockSeconds` accepts. */
export function parseClockSeconds(payload: unknown): number | undefined {
  if (typeof payload !== 'string') return undefined;
  const parts = payload.split(':').map((part) => Number.parseInt(part, 10));
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => Number.isNaN(part))) return undefined;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

export function projectMatchHistoryBatch(
  batch: OverwolfLiveBatchDto,
  previous?: MatchHistoryProjection,
): MatchHistoryProjection | null {
  const primaryMatchId = batch.events.find((event) => typeof event.matchId === 'string' && event.matchId.length > 0)
    ?.matchId;
  if (!primaryMatchId) return null;

  const playersBySteamId = new Map<string, MatchHistoryPlayer>();
  for (const player of previous?.players ?? []) {
    if (player.steamId) playersBySteamId.set(player.steamId, { ...player });
  }

  let localSteamId = previous?.localSteamId;
  let durationSec = previous?.durationSec;

  for (const event of batch.events as OverwolfLiveEventDto[]) {
    if (event.matchId !== primaryMatchId) continue;

    if (event.key === 'match_clock') {
      const seconds = parseClockSeconds(event.payload);
      if (seconds !== undefined && (durationSec === undefined || seconds > durationSec)) {
        durationSec = seconds;
      }
      continue;
    }

    if (!event.key?.startsWith('roster') || !isRecord(event.payload)) continue;

    const player = payloadToPlayer(event.payload);
    if (player.steamId === undefined) continue;
    playersBySteamId.set(player.steamId, mergePlayer(playersBySteamId.get(player.steamId), player));
    if (player.isLocal && player.steamId) localSteamId = player.steamId;
  }

  if (localSteamId === undefined) return null;

  return {
    matchId: sanitizeMatchId(primaryMatchId),
    localSteamId,
    clientId: batch.clientId,
    players: [...playersBySteamId.values()],
    durationSec,
  };
}
