import {
  canonicalizeGepRosterPayloadV2,
  CanonicalGepRosterPayloadV2,
  OverwolfLiveBatchDto,
  OverwolfLiveEventDto,
} from '@dynamo-lab/shared';

export function canonicalizeLiveBatchForStateV2(batch: OverwolfLiveBatchDto): OverwolfLiveBatchDto {
  return {
    clientId: batch.clientId,
    events: batch.events.map(canonicalizeLiveEventForStateV2),
  };
}

export function canonicalizeLiveEventForStateV2(event: OverwolfLiveEventDto): OverwolfLiveEventDto {
  if (!event.key?.startsWith('roster')) return event;
  const canonical = canonicalizeGepRosterPayloadV2(event.payload).canonicalPayload;
  return {
    ...event,
    payload: canonicalRosterToLegacyStatePayload(canonical),
  };
}

function canonicalRosterToLegacyStatePayload(
  canonical: CanonicalGepRosterPayloadV2,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  assign(payload, 'steam_id', canonical.steamId);
  assign(payload, 'player_name', canonical.playerName);
  assign(payload, 'is_local', canonical.isLocal);
  assign(payload, 'hero_id', canonical.heroId);
  assign(payload, 'hero_name', canonical.heroName);
  assign(payload, 'team', canonical.teamId);
  assign(payload, 'lane', canonical.laneId);
  assign(payload, 'level', canonical.level);
  assign(payload, 'souls', canonical.soulsRaw);
  assign(payload, 'health', canonical.health);
  assign(payload, 'max_health', canonical.maxHealth);
  assign(payload, 'kills', canonical.kills);
  assign(payload, 'deaths', canonical.deaths);
  assign(payload, 'assists', canonical.assists);
  assign(payload, 'hero_damage', canonical.heroDamage);
  assign(payload, 'object_damage', canonical.objectDamage);
  assign(payload, 'healing', canonical.heroHealing);
  return payload;
}

function assign(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value;
}
