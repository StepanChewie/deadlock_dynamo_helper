import {
  canonicalizeGepRosterPayloadV2,
  CanonicalGepRosterPayloadV2,
  MinimalPlayerState,
} from '@deadlock-live-probe/shared';

export interface CanonicalRosterStateResult {
  canonical: CanonicalGepRosterPayloadV2;
  steamId?: string;
}

export function applyCanonicalRosterPayloadV2(
  player: MinimalPlayerState,
  payload: unknown,
): CanonicalRosterStateResult {
  const canonical = canonicalizeGepRosterPayloadV2(payload).canonicalPayload;
  if (canonical.playerName !== undefined) player.playerName = canonical.playerName;
  if (canonical.isLocal !== undefined) player.isLocal = canonical.isLocal;
  if (canonical.heroName !== undefined) player.heroName = canonical.heroName;
  if (canonical.heroId !== undefined) player.heroId = canonical.heroId;
  if (canonical.teamId !== undefined) player.teamId = canonical.teamId;
  if (canonical.laneId !== undefined) player.lane = canonical.laneId;
  if (canonical.level !== undefined) player.level = canonical.level;
  if (canonical.soulsRaw !== undefined) player.souls = canonical.soulsRaw;
  if (canonical.health !== undefined) player.health = canonical.health;
  if (canonical.maxHealth !== undefined) player.maxHealth = canonical.maxHealth;
  if (canonical.kills !== undefined) player.kills = canonical.kills;
  if (canonical.deaths !== undefined) player.deaths = canonical.deaths;
  if (canonical.assists !== undefined) player.assists = canonical.assists;
  if (canonical.heroDamage !== undefined) player.heroDamage = canonical.heroDamage;
  if (canonical.objectDamage !== undefined) player.objectDamage = canonical.objectDamage;
  if (canonical.heroHealing !== undefined) player.healing = canonical.heroHealing;
  return { canonical, steamId: canonical.steamId };
}
