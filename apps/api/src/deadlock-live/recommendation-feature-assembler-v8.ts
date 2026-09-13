import {
  InventorySnapshotPayloadV8,
  PlayerStatePayloadV8,
  RecommendationFeatureHistoryEventV8,
  RecommendationFeatureStateV8,
  RECOMMENDATION_FEATURE_CONTRACT_VERSION,
  validateRecommendationFeatureStateV8,
} from '@deadlock-live-probe/shared';

export interface RecommendationFeatureDecisionSourceV8 {
  decisionId: string;
  matchId: string;
  playerKey: string;
  decisionAtMs: number;
  gameTimeMs?: number;
  rulesetVersion: string;
  catalogSha256: string;
}

export interface RecommendationAlignedPlayerStateV8 {
  sourceOccurredAtMs: number;
  payload: PlayerStatePayloadV8;
}

export interface RecommendationAlignedInventorySnapshotV8 {
  sourceOccurredAtMs: number;
  payload: InventorySnapshotPayloadV8;
}

export interface RecommendationFeatureAssemblerInputV8 {
  decision: RecommendationFeatureDecisionSourceV8;
  playerState?: RecommendationAlignedPlayerStateV8;
  inventorySnapshot?: RecommendationAlignedInventorySnapshotV8;
  slotTypeByItemId: ReadonlyMap<number, 'weapon' | 'vitality' | 'spirit'>;
  activeItemIds?: ReadonlySet<number>;
  history?: readonly RecommendationFeatureHistoryEventV8[];
}

export interface RecommendationFeatureAssemblerResultV8 {
  ready: boolean;
  blockers: readonly string[];
  featureState?: RecommendationFeatureStateV8;
}

export function assembleRecommendationFeatureStateV8(
  input: RecommendationFeatureAssemblerInputV8,
): RecommendationFeatureAssemblerResultV8 {
  const blockers: string[] = [];
  const { decision, playerState, inventorySnapshot } = input;
  if (!decision.decisionId) blockers.push('DECISION_ID_REQUIRED');
  if (!decision.matchId) blockers.push('MATCH_ID_REQUIRED');
  if (!decision.playerKey) blockers.push('PLAYER_KEY_REQUIRED');
  if (!Number.isFinite(decision.decisionAtMs)) blockers.push('DECISION_TIMESTAMP_INVALID');
  if (!playerState) blockers.push('PLAYER_STATE_MISSING');
  if (!inventorySnapshot) blockers.push('INVENTORY_SNAPSHOT_MISSING');
  if (playerState && playerState.sourceOccurredAtMs > decision.decisionAtMs) blockers.push('PLAYER_STATE_FROM_FUTURE');
  if (inventorySnapshot && inventorySnapshot.sourceOccurredAtMs > decision.decisionAtMs) blockers.push('INVENTORY_SNAPSHOT_FROM_FUTURE');

  const heroId = playerState?.payload.heroId;
  if (!Number.isInteger(heroId) || (heroId ?? 0) <= 0) blockers.push('HERO_ID_MISSING');
  if (!inventorySnapshot?.payload.snapshotSha256) blockers.push('INVENTORY_SNAPSHOT_SHA_MISSING');

  const inventory = (inventorySnapshot?.payload.items ?? []).map((item) => {
    const slotType = item.slotType ?? input.slotTypeByItemId.get(item.itemId);
    if (!slotType) blockers.push(`ITEM_SLOT_TYPE_UNKNOWN:${item.itemId}`);
    return slotType
      ? {
          itemId: item.itemId,
          slotType,
          active: input.activeItemIds?.has(item.itemId) ?? false,
        }
      : undefined;
  }).filter((item): item is NonNullable<typeof item> => item !== undefined);

  const stateSourceAtMs = Math.max(
    playerState?.sourceOccurredAtMs ?? Number.NEGATIVE_INFINITY,
    inventorySnapshot?.sourceOccurredAtMs ?? Number.NEGATIVE_INFINITY,
  );
  if (!Number.isFinite(stateSourceAtMs)) blockers.push('STATE_SOURCE_TIMESTAMP_MISSING');

  const uniqueBlockers = [...new Set(blockers)].sort();
  if (uniqueBlockers.length > 0) return { ready: false, blockers: uniqueBlockers };

  const health = playerState?.payload.health;
  const maxHealth = playerState?.payload.maxHealth;
  const healthFraction = health !== undefined && maxHealth !== undefined && maxHealth > 0
    ? Math.max(0, Math.min(1, health / maxHealth))
    : undefined;
  const verifiedWallet = playerState?.payload.spendableSoulsVerified;
  const history = [...(input.history ?? [])]
    .filter((event) => event.occurredAtMs < decision.decisionAtMs)
    .sort((a, b) => a.occurredAtMs - b.occurredAtMs);

  const featureState: RecommendationFeatureStateV8 = {
    contractVersion: RECOMMENDATION_FEATURE_CONTRACT_VERSION,
    decisionId: decision.decisionId,
    matchId: decision.matchId,
    playerKey: decision.playerKey,
    decisionAtMs: decision.decisionAtMs,
    stateSourceAtMs,
    gameTimeSec: (decision.gameTimeMs ?? 0) / 1000,
    heroId: heroId as number,
    teamId: playerState?.payload.teamId,
    level: playerState?.payload.level,
    healthFraction,
    verifiedSpendableSouls: verifiedWallet?.value,
    spendableSoulsVerificationContract: verifiedWallet?.verificationContractVersion,
    shopOpportunity: playerState?.payload.shopOpportunity ?? 'UNKNOWN',
    inventorySnapshotSha256: inventorySnapshot?.payload.snapshotSha256 as string,
    inventory,
    history,
    rulesetVersion: decision.rulesetVersion,
    catalogSha256: decision.catalogSha256,
  };
  const validation = validateRecommendationFeatureStateV8(featureState);
  if (!validation.valid) {
    return {
      ready: false,
      blockers: validation.errors.map((error) => `FEATURE_VALIDATION:${error}`).sort(),
    };
  }
  return { ready: true, blockers: [], featureState };
}
