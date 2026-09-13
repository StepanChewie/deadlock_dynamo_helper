export const RECOMMENDATION_VALUE_V6_PREVIOUS_ACTION_TAIL_SIZE = 5;

export type RecommendationValueV6TeamEconomyBand =
  | 'FAR_BEHIND'
  | 'BEHIND'
  | 'EVEN'
  | 'AHEAD'
  | 'FAR_AHEAD';

export interface RecommendationValueV6StateFeatureInput {
  heroId: number;
  teamId?: number | string;
  timeBucket: number;
  inventoryStateKey: string;
  previousActionKeys: readonly string[];
  alliedHeroIds: readonly number[];
  enemyHeroIds: readonly number[];
  inventoryTotalCost?: number;
  inventoryHighestTier?: number;
  playerNetWorth?: number;
  playerKills?: number;
  playerDeaths?: number;
  playerAssists?: number;
  teamNetWorthDelta?: number;
  teamRelativeNetWorthDelta?: number;
  playerNetWorthRankInTeam?: number;
  playerNetWorthShare?: number;
}

export interface RecommendationValueV6ActionFeatureInput {
  heroId: number;
  timeBucket: number;
  inventoryStateKey: string;
  previousActionKeys: readonly string[];
  teamEconomyBand?: RecommendationValueV6TeamEconomyBand;
  actionKey: string;
  slotType?: string;
  tier?: number;
  cost?: number;
  isActiveItem?: boolean;
  tags?: readonly string[];
  interactionKeys?: readonly string[];
}

export function buildRecommendationValueV6StateKeys(
  input: RecommendationValueV6StateFeatureInput,
): string[] {
  validatePositiveInteger(input.heroId, 'heroId');
  validateNonNegativeInteger(input.timeBucket, 'timeBucket');
  const baseKey = `${input.heroId}|${input.timeBucket}`;
  const previousTail = buildRecommendationValueV6PreviousTail(
    input.previousActionKeys,
  );
  const teamEconomyBand =
    input.teamRelativeNetWorthDelta === undefined
      ? undefined
      : classifyRecommendationValueV6TeamEconomy(
          input.teamRelativeNetWorthDelta,
        );

  return uniqueStrings([
    `HERO:${input.heroId}`,
    `HERO_TIME:${baseKey}`,
    `HERO_TEAM_TIME:${baseKey}|${normalizeTeamId(input.teamId)}`,
    `HERO_TIME_INVENTORY:${baseKey}|${input.inventoryStateKey}`,
    `HERO_TIME_PREVIOUS:${baseKey}|${previousTail}`,
    finite(input.inventoryTotalCost)
      ? `BUILD_TOTAL_COST:${input.heroId}|${bucket(input.inventoryTotalCost, 1_000)}`
      : undefined,
    finite(input.inventoryHighestTier)
      ? `BUILD_HIGHEST_TIER:${input.heroId}|${input.inventoryHighestTier}`
      : undefined,
    finite(input.playerNetWorth)
      ? `TIMELINE_NET_WORTH:${input.heroId}|${bucket(input.playerNetWorth, 1_000)}`
      : undefined,
    finite(input.playerKills) &&
    finite(input.playerDeaths) &&
    finite(input.playerAssists)
      ? `TIMELINE_KDA:${input.heroId}|${bucket(
          input.playerKills + input.playerAssists - input.playerDeaths,
          2,
        )}`
      : undefined,
    teamEconomyBand
      ? `TEAM_ECONOMY_BAND:${input.heroId}|${teamEconomyBand}`
      : undefined,
    finite(input.teamNetWorthDelta)
      ? `TEAM_NET_WORTH_DELTA:${input.heroId}|${bucket(
          input.teamNetWorthDelta,
          5_000,
        )}`
      : undefined,
    finite(input.teamRelativeNetWorthDelta)
      ? `TEAM_RELATIVE_NET_WORTH_DELTA:${input.heroId}|${bucket(
          input.teamRelativeNetWorthDelta * 100,
          5,
        )}`
      : undefined,
    finite(input.playerNetWorthRankInTeam) &&
    input.playerNetWorthRankInTeam > 0
      ? `PLAYER_TEAM_NET_WORTH_RANK:${input.heroId}|${input.playerNetWorthRankInTeam}`
      : undefined,
    finite(input.playerNetWorthShare)
      ? `PLAYER_TEAM_NET_WORTH_SHARE:${input.heroId}|${bucket(
          input.playerNetWorthShare * 100,
          10,
        )}`
      : undefined,
    ...input.alliedHeroIds.map(
      (allyHeroId) => `ALLY:${baseKey}|${allyHeroId}`,
    ),
    ...input.enemyHeroIds.map(
      (enemyHeroId) => `ENEMY:${baseKey}|${enemyHeroId}`,
    ),
  ]);
}

export function buildRecommendationValueV6ActionKeys(
  input: RecommendationValueV6ActionFeatureInput,
): string[] {
  validatePositiveInteger(input.heroId, 'heroId');
  validateNonNegativeInteger(input.timeBucket, 'timeBucket');
  if (!input.actionKey) {
    throw new Error('actionKey must be non-empty.');
  }
  const previousTail = buildRecommendationValueV6PreviousTail(
    input.previousActionKeys,
  );
  const slotType = normalizeOptionalText(input.slotType);

  return uniqueStrings([
    `HERO_TIME_ACTION:${input.heroId}|${input.timeBucket}|${input.actionKey}`,
    `HERO_TIME_INVENTORY_ACTION:${input.heroId}|${input.timeBucket}|${input.inventoryStateKey}|${input.actionKey}`,
    `HERO_TIME_PREVIOUS_ACTION:${input.heroId}|${input.timeBucket}|${previousTail}|${input.actionKey}`,
    input.teamEconomyBand
      ? `HERO_TEAM_ECONOMY_ACTION:${input.heroId}|${input.teamEconomyBand}|${input.actionKey}`
      : undefined,
    input.teamEconomyBand && slotType
      ? `HERO_TEAM_ECONOMY_SLOT:${input.heroId}|${input.teamEconomyBand}|${slotType}`
      : undefined,
    slotType ? `HERO_SLOT:${input.heroId}|${slotType}` : undefined,
    finite(input.tier) && input.tier > 0
      ? `HERO_TIER:${input.heroId}|${input.tier}`
      : undefined,
    finite(input.cost) && input.cost > 0
      ? `HERO_COST_BUCKET:${input.heroId}|${bucket(input.cost, 500)}`
      : undefined,
    input.isActiveItem === true
      ? `HERO_ACTIVE_ITEM:${input.heroId}`
      : undefined,
    ...(input.tags ?? []).map(
      (tag) => `HERO_ITEM_TAG:${input.heroId}|${tag}`,
    ),
    ...(input.interactionKeys ?? []).map((key) => `INTERACTION:${key}`),
  ]);
}

export function classifyRecommendationValueV6TeamEconomy(
  relativeNetWorthDelta: number,
): RecommendationValueV6TeamEconomyBand {
  if (!Number.isFinite(relativeNetWorthDelta)) {
    throw new Error('Team relative net-worth delta must be finite.');
  }
  if (relativeNetWorthDelta <= -0.15) {
    return 'FAR_BEHIND';
  }
  if (relativeNetWorthDelta < -0.05) {
    return 'BEHIND';
  }
  if (relativeNetWorthDelta <= 0.05) {
    return 'EVEN';
  }
  if (relativeNetWorthDelta < 0.15) {
    return 'AHEAD';
  }
  return 'FAR_AHEAD';
}

export function buildRecommendationValueV6PreviousTail(
  previousActionKeys: readonly string[],
): string {
  return (
    previousActionKeys
      .slice(-RECOMMENDATION_VALUE_V6_PREVIOUS_ACTION_TAIL_SIZE)
      .join('>') || 'EMPTY'
  );
}

function bucket(value: number, width: number): number {
  return Math.floor(value / width);
}

function finite(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeTeamId(value: number | string | undefined): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return 'UNKNOWN';
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function uniqueStrings(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function validatePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
}

function validateNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer.`);
  }
}
