import {
  FactEvidence,
  InventorySlotType,
  ObservedFact,
  RecommendationCandidateGeneratorRules,
  RecommendationItemGraph,
  recommendationSlotUsageFor,
  RecommendationUpgradePricingPolicyV1,
} from '@deadlock-live-probe/build-domain';

export type AdaptiveInvestmentTypeV1 = 'weapon' | 'vitality' | 'spirit';

export const ADAPTIVE_INVESTMENT_TYPES_V1: readonly AdaptiveInvestmentTypeV1[] = [
  'weapon',
  'vitality',
  'spirit',
];

export interface AdaptiveSlotStateV1 {
  /** Compatibility aggregate. New code should use baseSlotsByType. */
  baseSlots: number;
  baseSlotsByType: Readonly<Record<InventorySlotType, number>>;
  maxFlexSlots: number;
  maxActiveItems: number;
  unlockedFlexSlots?: number;
  usedSlots: number;
  usedSlotsByType: Readonly<Record<InventorySlotType, number>>;
  /** Compatibility alias used by transaction-plan projections. */
  usedByType: Readonly<Record<InventorySlotType, number>>;
  overflowByType: Readonly<Record<InventorySlotType, number>>;
  usedFlexSlots: number;
  provedFlexLowerBound: number;
  freeBaseSlots: number;
  freeBaseSlotsByType: Readonly<Record<InventorySlotType, number>>;
  /** Compatibility alias used by exact-mechanics callers. */
  freeBaseByType: Readonly<Record<InventorySlotType, number>>;
  freeFlexSlots?: number;
  totalCapacity?: number;
  activeItemsUsed: number;
  /** Compatibility alias used by exact-mechanics callers. */
  usedActiveItems: number;
  freeActiveItemSlots: number;
  mechanicsEvidence: FactEvidence;
  flexEvidence: FactEvidence;
  /** Compatibility alias for flexEvidence. */
  evidence?: FactEvidence;
}

export interface AdaptiveInvestmentTrackStateV1 {
  type: AdaptiveInvestmentTypeV1;
  currentValue: number;
  achievedBreakpoint?: number;
  nextBreakpoint?: number;
  soulsToNextBreakpoint?: number;
}

export interface AdaptiveInvestmentStateV1 {
  tracks: Readonly<Record<AdaptiveInvestmentTypeV1, AdaptiveInvestmentTrackStateV1>>;
  evidence: FactEvidence;
}

export interface RecommendationEconomyRulesV1 {
  rulesetId: string;
  catalogSha256: string;
  /** Compatibility aggregate; exact callers use baseSlotsByType. */
  baseSlots?: number;
  baseSlotsByType: Readonly<Record<InventorySlotType, number>>;
  maxFlexSlots: number;
  maxActiveItems: number;
  investmentBreakpoints: Readonly<Record<AdaptiveInvestmentTypeV1, readonly number[]>>;
  upgradePricingPolicy?: RecommendationUpgradePricingPolicyV1;
  source?: string;
}

export interface AdaptiveFlexCapacityInputV1 {
  unlockedFlexSlots?: number;
  evidence: FactEvidence;
}

export interface AdaptiveSlotRulesV1 {
  /** Compatibility aggregate for callers that also retain the exact per-category record. */
  baseSlots?: number;
  baseSlotsByType: Readonly<Record<InventorySlotType, number>>;
  maxFlexSlots: number;
  maxActiveItems: number;
  evidence?: FactEvidence;
}

export const UNKNOWN_ADAPTIVE_SLOT_RULES_V1: AdaptiveSlotRulesV1 = {
  baseSlotsByType: { weapon: 0, vitality: 0, spirit: 0 },
  maxFlexSlots: 0,
  maxActiveItems: 0,
  evidence: 'UNKNOWN',
};

export const CANONICAL_ADAPTIVE_SLOT_RULES_V1: AdaptiveSlotRulesV1 = {
  baseSlots: 0,
  baseSlotsByType: { weapon: 0, vitality: 0, spirit: 0 },
  maxFlexSlots: 12,
  maxActiveItems: 4,
  evidence: 'RECONSTRUCTED',
};

export function isCanonicalAdaptiveInvestmentStateV1(value: unknown): value is AdaptiveInvestmentStateV1 {
  if (!isRecord(value) || !isFactEvidence(value.evidence)) return false;
  const tracks = value.tracks;
  if (!isRecord(tracks)) return false;
  return ADAPTIVE_INVESTMENT_TYPES_V1.every((type) =>
    isCanonicalAdaptiveInvestmentTrackV1(tracks[type], type),
  );
}

export function isCanonicalAdaptiveInvestmentTrackV1(
  value: unknown,
  expectedType: AdaptiveInvestmentTypeV1,
): value is AdaptiveInvestmentTrackStateV1 {
  if (!isRecord(value) || value.type !== expectedType || typeof value.currentValue !== 'number' ||
    !Number.isFinite(value.currentValue) || value.currentValue < 0) return false;
  const achievedBreakpoint = value.achievedBreakpoint;
  return achievedBreakpoint === undefined ||
    (typeof achievedBreakpoint === 'number' && Number.isFinite(achievedBreakpoint) &&
      achievedBreakpoint > 0 && achievedBreakpoint <= value.currentValue);
}

/**
 * Persisted-replay compatibility only. Production serving must resolve exact rules by
 * rulesetId + catalogSha256 and must never select this record as a fallback.
 */
export const ADAPTIVE_UNIVERSAL_SLOT_RULES_V1: AdaptiveSlotRulesV1 = {
  baseSlotsByType: { weapon: 4, vitality: 4, spirit: 4 },
  maxFlexSlots: 4,
  maxActiveItems: 4,
  evidence: 'UNKNOWN',
};

export function createCanonicalEconomyRulesV1(
  rulesetId: string,
  catalogSha256: string,
): RecommendationEconomyRulesV1 {
  return {
    rulesetId,
    catalogSha256: catalogSha256.toLowerCase(),
    baseSlots: 0,
    baseSlotsByType: { weapon: 0, vitality: 0, spirit: 0 },
    maxFlexSlots: 12,
    maxActiveItems: 4,
    investmentBreakpoints: {
      weapon: [1600],
      vitality: [1600],
      spirit: [1600],
    },
  };
}
export function resolveRecommendationEconomyRulesV1(
  rulesetId: string,
  catalogSha256: string,
  registry: readonly RecommendationEconomyRulesV1[] = loadRecommendationEconomyRulesRegistryV1(),
): RecommendationEconomyRulesV1 | undefined {
  const normalizedSha = catalogSha256.trim().toLowerCase();
  return registry.find((entry) =>
    entry.rulesetId === rulesetId && entry.catalogSha256.trim().toLowerCase() === normalizedSha,
  );
}

export function loadRecommendationEconomyRulesRegistryV1(
  raw: string | undefined = process.env.ADAPTIVE_RECOMMENDATION_ECONOMY_RULES_JSON,
): readonly RecommendationEconomyRulesV1[] {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed
    .map(parseRecommendationEconomyRuleV1)
    .filter((entry): entry is RecommendationEconomyRulesV1 => entry !== undefined)
    .sort((left, right) =>
      left.rulesetId.localeCompare(right.rulesetId) || left.catalogSha256.localeCompare(right.catalogSha256),
    );
}

export function slotRulesFromEconomyRulesV1(
  rules: RecommendationEconomyRulesV1 | undefined,
): AdaptiveSlotRulesV1 {
  return {
    ...CANONICAL_ADAPTIVE_SLOT_RULES_V1,
    baseSlotsByType: { ...CANONICAL_ADAPTIVE_SLOT_RULES_V1.baseSlotsByType },
    maxActiveItems: rules?.maxActiveItems ?? CANONICAL_ADAPTIVE_SLOT_RULES_V1.maxActiveItems,
  };
}

export function candidateGeneratorRulesFromSlotStateV1(
  slots: AdaptiveSlotStateV1,
  overrides: Partial<Pick<
    RecommendationCandidateGeneratorRules,
    'allowSellOnlyActions' | 'generateTargetedWaitActions'
  >> = {},
): RecommendationCandidateGeneratorRules {
  const effectiveUnlocked = slots.unlockedFlexSlots ?? (slots.provedFlexLowerBound > 0 ? slots.provedFlexLowerBound : undefined);
  return {
    baseSlots: slots.baseSlots,
    baseSlotsByType: slots.baseSlotsByType,
    maxFlexSlots: slots.maxFlexSlots,
    unlockedFlexSlots: effectiveUnlocked,
    flexCapacityEvidence: effectiveUnlocked !== undefined && (slots.evidence ?? slots.flexEvidence) === 'UNKNOWN'
      ? 'OBSERVED'
      : (slots.evidence ?? slots.flexEvidence),
    maxActiveItems: slots.maxActiveItems,
    activeCapacityEvidence: slots.mechanicsEvidence,
    allowSellOnlyActions: overrides.allowSellOnlyActions ?? true,
    generateTargetedWaitActions: overrides.generateTargetedWaitActions ?? true,
  };
}

export function deriveAdaptiveSlotStateV1(
  itemIds: readonly number[],
  graph: RecommendationItemGraph,
  slotRules: AdaptiveSlotRulesV1,
  capacity: AdaptiveFlexCapacityInputV1 = { evidence: 'UNKNOWN' },
): AdaptiveSlotStateV1 {
  const baseSlotsByType: Record<InventorySlotType, number> = {
    weapon: Math.max(0, Math.floor(slotRules.baseSlotsByType.weapon)),
    vitality: Math.max(0, Math.floor(slotRules.baseSlotsByType.vitality)),
    spirit: Math.max(0, Math.floor(slotRules.baseSlotsByType.spirit)),
  };
  const baseSlots = Object.values(baseSlotsByType).reduce((sum, value) => sum + value, 0);
  const maxFlexSlots = Math.max(0, Math.floor(slotRules.maxFlexSlots));
  const maxActiveItems = Math.max(0, Math.floor(slotRules.maxActiveItems));
  const mechanicsEvidence = slotRules.evidence ?? 'RECONSTRUCTED';
  const fixedFlexCapacity = mechanicsEvidence !== 'UNKNOWN' && baseSlots === 0;
  const effectiveUnlockedFlexSlots = fixedFlexCapacity ? maxFlexSlots : capacity.unlockedFlexSlots;
  const effectiveFlexEvidence = fixedFlexCapacity ? mechanicsEvidence : capacity.evidence;
  const usage = recommendationSlotUsageFor(itemIds, graph, {
    baseSlots,
    baseSlotsByType,
    maxFlexSlots,
    unlockedFlexSlots: effectiveUnlockedFlexSlots,
    flexCapacityEvidence: effectiveFlexEvidence,
    maxActiveItems,
    allowSellOnlyActions: true,
    generateTargetedWaitActions: true,
  });
  const provedLowerBound = mechanicsEvidence === 'UNKNOWN'
    ? 0
    : Math.min(maxFlexSlots, usage.flexUsed);
  const unlocked = fixedFlexCapacity
    ? maxFlexSlots
    : capacity.evidence === 'UNKNOWN' || capacity.unlockedFlexSlots === undefined
      ? undefined
      : Math.min(maxFlexSlots, Math.max(provedLowerBound, Math.floor(capacity.unlockedFlexSlots)));
  const evidence = fixedFlexCapacity ? mechanicsEvidence : capacity.evidence;
  const freeBaseSlotsByType: Record<InventorySlotType, number> = {
    weapon: Math.max(0, baseSlotsByType.weapon - usage.usedByType.weapon),
    vitality: Math.max(0, baseSlotsByType.vitality - usage.usedByType.vitality),
    spirit: Math.max(0, baseSlotsByType.spirit - usage.usedByType.spirit),
  };

  return {
    baseSlots,
    baseSlotsByType,
    maxFlexSlots,
    maxActiveItems,
    unlockedFlexSlots: unlocked,
    usedSlots: usage.itemCount,
    usedSlotsByType: usage.usedByType,
    usedByType: usage.usedByType,
    overflowByType: usage.overflowByType,
    usedFlexSlots: usage.flexUsed,
    provedFlexLowerBound: provedLowerBound,
    freeBaseSlots: freeBaseSlotsByType.weapon + freeBaseSlotsByType.vitality + freeBaseSlotsByType.spirit,
    freeBaseSlotsByType,
    freeBaseByType: freeBaseSlotsByType,
    freeFlexSlots: unlocked === undefined ? undefined : Math.max(0, unlocked - usage.flexUsed),
    totalCapacity: unlocked === undefined ? undefined : baseSlots + unlocked,
    activeItemsUsed: usage.activeItemsUsed,
    usedActiveItems: usage.activeItemsUsed,
    freeActiveItemSlots: Math.max(0, maxActiveItems - usage.activeItemsUsed),
    mechanicsEvidence,
    flexEvidence: effectiveFlexEvidence,
    evidence,
  };
}

export function deriveAdaptiveInvestmentStateV1(
  itemIds: readonly number[],
  graph: RecommendationItemGraph,
  rules: RecommendationEconomyRulesV1 | undefined,
): AdaptiveInvestmentStateV1 {
  if (!rules) return unknownAdaptiveInvestmentStateV1();

  const totals: Record<AdaptiveInvestmentTypeV1, number> = { weapon: 0, vitality: 0, spirit: 0 };
  const valueMemo = new Map<number, number>();
  for (const itemId of itemIds) {
    const item = graph.getItem(itemId);
    if (!item) continue;
    totals[item.slotType] += investmentValueForItemV1(itemId, graph, valueMemo, new Set<number>());
  }

  return {
    tracks: {
      weapon: investmentTrack('weapon', totals.weapon, rules.investmentBreakpoints.weapon),
      vitality: investmentTrack('vitality', totals.vitality, rules.investmentBreakpoints.vitality),
      spirit: investmentTrack('spirit', totals.spirit, rules.investmentBreakpoints.spirit),
    },
    evidence: 'RECONSTRUCTED',
  };
}

function investmentValueForItemV1(
  itemId: number,
  graph: RecommendationItemGraph,
  memo: Map<number, number>,
  visiting: Set<number>,
): number {
  const cached = memo.get(itemId);
  if (cached !== undefined) return cached;
  if (visiting.has(itemId)) return 0;

  const item = graph.getItem(itemId);
  if (!item) return 0;

  visiting.add(itemId);
  const values: number[] = [];
  if (item.directPurchaseCost !== undefined) values.push(Math.max(0, item.directPurchaseCost));
  for (const recipe of item.upgradeRecipes) {
    values.push(
      Math.max(0, recipe.soulsCost) + recipe.consumedItemIds.reduce(
        (sum, componentId) => sum + investmentValueForItemV1(componentId, graph, memo, visiting),
        0,
      ),
    );
  }
  visiting.delete(itemId);

  const value = values.length === 0 ? 0 : Math.min(...values);
  memo.set(itemId, value);
  return value;
}

export function unknownAdaptiveInvestmentStateV1(): AdaptiveInvestmentStateV1 {
  return {
    tracks: {
      weapon: { type: 'weapon', currentValue: 0 },
      vitality: { type: 'vitality', currentValue: 0 },
      spirit: { type: 'spirit', currentValue: 0 },
    },
    evidence: 'UNKNOWN',
  };
}

export interface AdaptiveInvestmentDeltaV1 {
  type: AdaptiveInvestmentTypeV1;
  before: AdaptiveInvestmentTrackStateV1;
  after: AdaptiveInvestmentTrackStateV1;
  crossedBreakpoints: readonly number[];
}

export function deriveAdaptiveInvestmentDeltasV1(
  before: AdaptiveInvestmentStateV1,
  after: AdaptiveInvestmentStateV1,
): readonly AdaptiveInvestmentDeltaV1[] {
  if (before.evidence === 'UNKNOWN' || after.evidence === 'UNKNOWN') return [];
  return (['weapon', 'vitality', 'spirit'] as const).map((type) => {
    const previous = before.tracks[type];
    const next = after.tracks[type];
    const upper = next.achievedBreakpoint ?? 0;
    const lower = previous.achievedBreakpoint ?? 0;
    const crossed = upper > lower ? [upper] : [];
    return { type, before: previous, after: next, crossedBreakpoints: crossed };
  });
}

export function observedFlexCapacityV1(value: number, source: string): ObservedFact<number> {
  return { value, evidence: 'OBSERVED', source };
}

function investmentTrack(
  type: AdaptiveInvestmentTypeV1,
  currentValue: number,
  breakpoints: readonly number[],
): AdaptiveInvestmentTrackStateV1 {
  const normalized = [...new Set(breakpoints.filter((value) => Number.isFinite(value) && value > 0))].sort((a, b) => a - b);
  const achievedBreakpoint = [...normalized].reverse().find((value) => value <= currentValue);
  const nextBreakpoint = normalized.find((value) => value > currentValue);
  return {
    type,
    currentValue,
    achievedBreakpoint,
    nextBreakpoint,
    soulsToNextBreakpoint: nextBreakpoint === undefined ? undefined : Math.max(0, nextBreakpoint - currentValue),
  };
}

function parseRecommendationEconomyRuleV1(value: unknown): RecommendationEconomyRulesV1 | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.rulesetId !== 'string' || !value.rulesetId.trim()) return undefined;
  if (typeof value.catalogSha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value.catalogSha256.trim())) return undefined;
  if (!isSlotCountRecord(value.baseSlotsByType)) return undefined;
  if (!isNonNegativeInteger(value.maxFlexSlots) || !isNonNegativeInteger(value.maxActiveItems)) return undefined;
  if (!isRecord(value.investmentBreakpoints)) return undefined;

  const investmentBreakpoints = {
    weapon: parseBreakpoints(value.investmentBreakpoints.weapon),
    vitality: parseBreakpoints(value.investmentBreakpoints.vitality),
    spirit: parseBreakpoints(value.investmentBreakpoints.spirit),
  };
  if (!investmentBreakpoints.weapon || !investmentBreakpoints.vitality || !investmentBreakpoints.spirit) return undefined;
  const source = typeof value.source === 'string' && value.source.trim() ? value.source : 'environment';
  const upgradePricingPolicy = parseUpgradePricingPolicy(value.upgradePricingPolicy, source);
  if (value.upgradePricingPolicy !== undefined && !upgradePricingPolicy) return undefined;

  return {
    rulesetId: value.rulesetId,
    catalogSha256: value.catalogSha256.toLowerCase(),
    baseSlotsByType: normalizeBaseSlots(value.baseSlotsByType),
    maxFlexSlots: value.maxFlexSlots,
    maxActiveItems: value.maxActiveItems,
    investmentBreakpoints: {
      weapon: investmentBreakpoints.weapon,
      vitality: investmentBreakpoints.vitality,
      spirit: investmentBreakpoints.spirit,
    },
    upgradePricingPolicy,
    source,
  };
}

function parseUpgradePricingPolicy(
  value: unknown,
  source: string,
): RecommendationUpgradePricingPolicyV1 | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  if (value.mode !== 'TARGET_COST_MINUS_VERIFIED_COMPONENT_CREDIT') return undefined;
  if (typeof value.componentCreditRatio !== 'number' || !Number.isFinite(value.componentCreditRatio) ||
      value.componentCreditRatio < 0 || value.componentCreditRatio > 1) return undefined;
  const evidence = value.evidence;
  if (evidence !== 'OBSERVED' && evidence !== 'RECONSTRUCTED') return undefined;
  return {
    mode: value.mode,
    componentCreditRatio: value.componentCreditRatio,
    evidence,
    source: typeof value.source === 'string' && value.source.trim()
      ? value.source
      : `${source}:upgrade-pricing`,
  };
}

function parseBreakpoints(value: unknown): readonly number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((entry) => Number.isFinite(entry) && Number(entry) > 0)) return undefined;
  return [...new Set(value.map(Number))].sort((left, right) => left - right);
}

function isSlotCountRecord(value: unknown): value is Record<InventorySlotType, number> {
  if (!isRecord(value)) return false;
  return (['weapon', 'vitality', 'spirit'] as const).every((type) => isNonNegativeInteger(value[type]));
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function normalizeBaseSlots(
  value: Readonly<Record<InventorySlotType, number>>,
): Record<InventorySlotType, number> {
  return {
    weapon: Math.max(0, Math.floor(value.weapon)),
    vitality: Math.max(0, Math.floor(value.vitality)),
    spirit: Math.max(0, Math.floor(value.spirit)),
  };
}

function sumSlotValues(value: Readonly<Record<InventorySlotType, number>>): number {
  return value.weapon + value.vitality + value.spirit;
}

function isFactEvidence(value: unknown): value is FactEvidence {
  return value === 'OBSERVED' || value === 'RECONSTRUCTED' || value === 'UNKNOWN';
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null;
}
