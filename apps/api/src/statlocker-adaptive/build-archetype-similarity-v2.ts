import {
  StatlockerBuildProfileItemV2,
  StatlockerBuildProfileV2,
} from './build-archetype-v2';

const TIER_WEIGHT: Readonly<Record<StatlockerBuildProfileItemV2['frequencyTier'], number>> = {
  CORE: 1,
  FREQUENT: 0.78,
  SOMETIMES: 0.48,
  FLEX: 0.22,
};

const PHASE_INDEX: Readonly<Record<StatlockerBuildProfileItemV2['phase'], number>> = {
  EARLY: 0,
  MID: 1,
  LATE: 2,
};

interface FamilyFeatureV2 {
  familyId: number;
  structuralWeight: number;
  tierWeight: number;
  phase: StatlockerBuildProfileItemV2['phase'];
  medianBuyTimeS: number;
}

export interface BuildArchetypeProfileSimilarityV2 {
  similarity: number;
  composition: number;
  role: number;
  timing: number;
  relationships?: number;
  explicitGroups?: number;
}

export function buildArchetypeProfileSimilarityV2(
  left: StatlockerBuildProfileV2,
  right: StatlockerBuildProfileV2,
): BuildArchetypeProfileSimilarityV2 {
  if (left.heroId !== right.heroId) {
    return { similarity: 0, composition: 0, role: 0, timing: 0 };
  }

  const leftFamilies = familyFeatures(left);
  const rightFamilies = familyFeatures(right);
  const composition = weightedJaccard(
    new Map([...leftFamilies].map(([familyId, feature]) => [familyId, feature.structuralWeight])),
    new Map([...rightFamilies].map(([familyId, feature]) => [familyId, feature.structuralWeight])),
  );
  const sharedFamilyIds = [...leftFamilies.keys()]
    .filter((familyId) => rightFamilies.has(familyId))
    .sort((a, b) => a - b);
  const role = sharedFamilyIds.length === 0
    ? 0
    : mean(sharedFamilyIds.map((familyId) =>
        1 - Math.abs(leftFamilies.get(familyId)!.tierWeight - rightFamilies.get(familyId)!.tierWeight),
      ));
  const timing = sharedFamilyIds.length === 0
    ? 0
    : mean(sharedFamilyIds.map((familyId) => timingAgreement(
        leftFamilies.get(familyId)!,
        rightFamilies.get(familyId)!,
      )));

  let numerator = composition * 0.70;
  let denominator = 0.70;
  if (sharedFamilyIds.length > 0) {
    numerator += role * 0.10 + timing * 0.10;
    denominator += 0.20;
  }

  const leftRelationships = relationshipWeights(left);
  const rightRelationships = relationshipWeights(right);
  const relationships = leftRelationships.size > 0 || rightRelationships.size > 0
    ? weightedJaccard(leftRelationships, rightRelationships)
    : undefined;
  if (relationships !== undefined) {
    numerator += relationships * 0.05;
    denominator += 0.05;
  }

  const leftGroups = explicitGroupTokens(left);
  const rightGroups = explicitGroupTokens(right);
  const explicitGroups = leftGroups.size > 0 || rightGroups.size > 0
    ? setJaccard(leftGroups, rightGroups)
    : undefined;
  if (explicitGroups !== undefined) {
    numerator += explicitGroups * 0.05;
    denominator += 0.05;
  }

  return {
    similarity: clamp01(numerator / denominator),
    composition,
    role,
    timing,
    ...(relationships === undefined ? {} : { relationships }),
    ...(explicitGroups === undefined ? {} : { explicitGroups }),
  };
}

function familyFeatures(profile: StatlockerBuildProfileV2): Map<number, FamilyFeatureV2> {
  const result = new Map<number, FamilyFeatureV2>();
  for (const item of profile.items) {
    const tierWeight = TIER_WEIGHT[item.frequencyTier];
    const structuralWeight = clamp01(item.purchaseRate) * tierWeight;
    const candidate: FamilyFeatureV2 = {
      familyId: item.familyId,
      structuralWeight,
      tierWeight,
      phase: item.phase,
      medianBuyTimeS: Math.max(0, item.medianBuyTimeS),
    };
    const current = result.get(item.familyId);
    if (!current || compareFamilyFeature(candidate, current) < 0) result.set(item.familyId, candidate);
  }
  return result;
}

function compareFamilyFeature(left: FamilyFeatureV2, right: FamilyFeatureV2): number {
  return right.structuralWeight - left.structuralWeight ||
    right.tierWeight - left.tierWeight ||
    left.medianBuyTimeS - right.medianBuyTimeS;
}

function timingAgreement(left: FamilyFeatureV2, right: FamilyFeatureV2): number {
  const phaseDistance = Math.abs(PHASE_INDEX[left.phase] - PHASE_INDEX[right.phase]);
  const phaseScore = phaseDistance === 0 ? 1 : phaseDistance === 1 ? 0.65 : 0.30;
  const leftTime = Math.max(60, left.medianBuyTimeS);
  const rightTime = Math.max(60, right.medianBuyTimeS);
  const logRatio = Math.abs(Math.log(leftTime / rightTime));
  const timeScore = clamp01(1 - logRatio / Math.log(4));
  return phaseScore * 0.65 + timeScore * 0.35;
}

function relationshipWeights(profile: StatlockerBuildProfileV2): Map<string, number> {
  const familyByItemId = new Map(profile.items.map((item) => [item.itemId, item.familyId]));
  const result = new Map<string, number>();
  for (const item of profile.items) {
    for (const relationship of item.relationships) {
      const targetFamilyId = familyByItemId.get(relationship.itemId) ?? relationship.itemId;
      const low = Math.min(item.familyId, targetFamilyId);
      const high = Math.max(item.familyId, targetFamilyId);
      if (low === high) continue;
      const key = `${low}:${high}`;
      result.set(key, Math.max(result.get(key) ?? 0, clamp01(relationship.strength)));
    }
  }
  return result;
}

function explicitGroupTokens(profile: StatlockerBuildProfileV2): Set<string> {
  const result = new Set<string>();
  for (const item of profile.items) {
    if (!item.explicitGroup) continue;
    const group = item.explicitGroup;
    result.add(`${group.type}:${group.groupKey}:${group.minSelect}:${group.maxSelect}:${item.familyId}`);
  }
  return result;
}

function weightedJaccard<TKey>(
  left: ReadonlyMap<TKey, number>,
  right: ReadonlyMap<TKey, number>,
): number {
  const keys = new Set([...left.keys(), ...right.keys()]);
  if (keys.size === 0) return 1;
  let minimum = 0;
  let maximum = 0;
  for (const key of keys) {
    const leftWeight = Math.max(0, left.get(key) ?? 0);
    const rightWeight = Math.max(0, right.get(key) ?? 0);
    minimum += Math.min(leftWeight, rightWeight);
    maximum += Math.max(leftWeight, rightWeight);
  }
  return maximum <= 0 ? 1 : clamp01(minimum / maximum);
}

function setJaccard<TKey>(left: ReadonlySet<TKey>, right: ReadonlySet<TKey>): number {
  const union = new Set([...left, ...right]);
  if (union.size === 0) return 1;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / union.size;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
