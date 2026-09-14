export const GEP_CANONICAL_SCHEMA_VERSION = 2 as const;

export interface CanonicalGepRosterPayloadV2 {
  steamId?: string;
  playerName?: string;
  isLocal?: boolean;
  heroId?: number;
  heroName?: string;
  teamId?: number;
  laneId?: number;
  level?: number;
  soulsRaw?: number;
  health?: number;
  maxHealth?: number;
  kills?: number;
  deaths?: number;
  assists?: number;
  heroDamage?: number;
  objectDamage?: number;
  heroHealing?: number;
}

interface CanonicalGepEnvelopeV2<TCanonical> {
  schemaVersion: typeof GEP_CANONICAL_SCHEMA_VERSION;
  normalizerVersion: 'gep-canonical-v2';
  rawPayload: unknown;
  canonicalPayload: TCanonical;
  unknownFields: string[];
}

const ROSTER_FIELD_NAMES = new Set([
  'steam_id',
  'steamId',
  'player_name',
  'playerName',
  'is_local',
  'isLocal',
  'hero_id',
  'heroId',
  'hero_name',
  'heroName',
  'team_id',
  'team',
  'teamId',
  'assigned_lane',
  'lane',
  'laneId',
  'level',
  'souls',
  'soulsRaw',
  'health',
  'max_health',
  'maxHealth',
  'kills',
  'deaths',
  'assist',
  'assists',
  'hero_damage',
  'heroDamage',
  'object_damage',
  'objectDamage',
  'hero_healing',
  'healing',
  'heroHealing',
]);

export function canonicalizeGepRosterPayloadV2(
  rawPayload: unknown,
): CanonicalGepEnvelopeV2<CanonicalGepRosterPayloadV2> {
  const record = asRecord(rawPayload);
  if (!record) {
    return {
      schemaVersion: GEP_CANONICAL_SCHEMA_VERSION,
      normalizerVersion: 'gep-canonical-v2',
      rawPayload,
      canonicalPayload: {},
      unknownFields: [],
    };
  }

  const canonicalPayload: CanonicalGepRosterPayloadV2 = {};

  assignString(canonicalPayload, 'steamId', first(record, 'steam_id', 'steamId'));
  assignString(canonicalPayload, 'playerName', first(record, 'player_name', 'playerName'));
  assignBoolean(canonicalPayload, 'isLocal', first(record, 'is_local', 'isLocal'));
  assignNumber(canonicalPayload, 'heroId', first(record, 'hero_id', 'heroId'));
  assignString(canonicalPayload, 'heroName', first(record, 'hero_name', 'heroName'));
  assignNumber(canonicalPayload, 'teamId', first(record, 'team_id', 'team', 'teamId'));
  assignNumber(canonicalPayload, 'laneId', first(record, 'assigned_lane', 'lane', 'laneId'));
  assignNumber(canonicalPayload, 'level', record.level);
  assignNumber(canonicalPayload, 'soulsRaw', first(record, 'souls', 'soulsRaw'));
  assignNumber(canonicalPayload, 'health', record.health);
  assignNumber(canonicalPayload, 'maxHealth', first(record, 'max_health', 'maxHealth'));
  assignNumber(canonicalPayload, 'kills', record.kills);
  assignNumber(canonicalPayload, 'deaths', record.deaths);
  assignNumber(canonicalPayload, 'assists', first(record, 'assist', 'assists'));
  assignNumber(canonicalPayload, 'heroDamage', first(record, 'hero_damage', 'heroDamage'));
  assignNumber(canonicalPayload, 'objectDamage', first(record, 'object_damage', 'objectDamage'));
  assignNumber(canonicalPayload, 'heroHealing', first(record, 'hero_healing', 'healing', 'heroHealing'));

  return {
    schemaVersion: GEP_CANONICAL_SCHEMA_VERSION,
    normalizerVersion: 'gep-canonical-v2',
    rawPayload,
    canonicalPayload,
    unknownFields: Object.keys(record)
      .filter((field) => !ROSTER_FIELD_NAMES.has(field))
      .sort(),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function first(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) {
      return record[key];
    }
  }
  return undefined;
}

function assignString<T extends object, K extends keyof T>(target: T, key: K, value: unknown): void {
  if (typeof value === 'string' && value.length > 0) {
    target[key] = value as T[K];
  }
}

function assignNumber<T extends object, K extends keyof T>(target: T, key: K, value: unknown): void {
  const normalized = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : Number.NaN;
  if (Number.isFinite(normalized)) {
    target[key] = normalized as T[K];
  }
}

function assignBoolean<T extends object, K extends keyof T>(target: T, key: K, value: unknown): void {
  if (typeof value === 'boolean') {
    target[key] = value as T[K];
    return;
  }
  if (value === 1 || value === '1' || value === 'true') {
    target[key] = true as T[K];
    return;
  }
  if (value === 0 || value === '0' || value === 'false') {
    target[key] = false as T[K];
  }
}
