import {
  StatlockerBuildProfileItemV2,
  StatlockerBuildProfileV2,
} from './build-archetype-v2';
import {
  BuildProfileSimilarityWeightsV2,
  STATLOCKER_BUILD_V2_CONFIG,
} from './statlocker-build-v2.config';

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

export interface BuildProfileSimilarityV2 {
  composition: number;
  tierAgreement: number;
  groupAgreement: number;
  relationshipAgreement: number;
  phaseAgreement: number;
  timingAgreement: number;
  total: number;
}

export function compareBuildProfilesV2(
  left: StatlockerBuildProfileV2,
  right: StatlockerBuildProfileV2,
  weights: BuildProfileSimilarityWeightsV2 = STATLOCKER_BUILD_V2_CONFIG.profileSimilarityWeights,
): BuildProfileSimilarityV2 {
  if (left.heroId !== right.heroId) {
    return {
      composition: 0,
      tierAgreement: 0,
      groupAgreement: 0,
      relationshipAgreement: 0,
      phaseAgreement: 0,
      timingAgreement: 0,
      total: 0,
    };
  }

  validateWeights(weights);
  const leftFamilies = familyFeatures(left);
  const rightFamilies = familyFeatures(right);
  const composition = weightedJaccard(
    new Map([...leftFamilies].map(([familyId, feature]) => [familyId, feature.structuralWeight])),
    new Map([...rightFamilies].map(([familyId, feature]) => [familyId, feature.structuralWeight])),
  );
  const sharedFamilyIds = [...leftFamilies.keys()]
    .filter((familyId) => rightFamilies.has(familyId))
    .sort((a, b) => a - b);

  const tierAgreement = sharedFamilyIds.length === 0
    ? 0
    : mean(sharedFamilyIds.map((familyId) =>
        1 - Math.abs(leftFamilies.get(familyId)!.tierWeight - rightFamilies.get(familyId)!.tierWeight),
      ));
  const phaseAgreement = sharedFamilyIds.length === 0
    ? 0
    : mean(sharedFamilyIds.map((familyId) => phaseScore(
        leftFamilies.get(familyId)!.phase,
        rightFamilies.get(familyId)!.phase,
      )));
  const timingAgreement = sharedFamilyIds.length === 0
    ? 0
    : mean(sharedFamilyIds.map((familyId) => timeScore(
        leftFamilies.get(familyId)!.medianBuyTimeS,
        rightFamilies.get(familyId)!.medianBuyTimeS,
      )));

  const leftRelationships = relationshipWeights(left);
  const rightRelationships = relationshipWeights(right);
  const hasRelationshipEvidence = leftRelationships.size > 0 || rightRelationships.size > 0;
  const relationshipAgreement = hasRelationshipEvidence
    ? weightedJaccard(leftRelationships, rightRelationships)
    : 0;

  const leftGroups = explicitGroupTokens(left);
  const rightGroups = explicitGroupTokens(right);
  const hasGroupEvidence = leftGroups.size > 0 || rightGroups.size > 0;
  const groupAgreement = hasGroupEvidence ? setJaccard(leftGroups, rightGroups) : 0;

  let numerator = composition * weights.composition;
  let denominator = weights.composition;
  if (sharedFamilyIds.length > 0) {
    numerator += tierAgreement * weights.tierAgreement;
    numerator += phaseAgreement * weights.phaseAgreement;
    numerator += timingAgreement * weights.timingAgreement;
    denominator += weights.tierAgreement + weights.phaseAgreement + weights.timingAgreement;
  }
  if (hasRelationshipEvidence) {
    numerator += relationshipAgreement * weights.relationshipAgreement;
    denominator += weights.relationshipAgreement;
  }
  if (hasGroupEvidence) {
    numerator += groupAgreement * weights.groupAgreement;
    denominator += weights.groupAgreement;
  }

  return {
    composition,
    tierAgreement,
    groupAgreement,
    relationshipAgreement,
    phaseAgreement,
    timingAgreement,
    total: denominator <= 0 ? 0 : clamp01(numerator / denominator),
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
    if (!current || isStrongerFamilyFeature(candidate, current)) result.set(item.familyId, candidate);
  }
  return result;
}

function isStrongerFamilyFeature(left: FamilyFeatureV2, right: FamilyFeatureV2): boolean {
  if (left.structuralWeight !== right.structuralWeight) return left.structuralWeight > right.structuralWeight;
  if (left.tierWeight !== right.tierWeight) return left.tierWeight > right.tierWeight;
  return left.medianBuyTimeS < right.medianBuyTimeS;
}

function phaseScore(
  left: StatlockerBuildProfileItemV2['phase'],
  right: StatlockerBuildProfileItemV2['phase'],
): number {
  const distance = Math.abs(PHASE_INDEX[left] - PHASE_INDEX[right]);
  return distance === 0 ? 1 : distance === 1 ? 0.65 : 0.30;
}

function timeScore(left: number, right: number): number {
  const safeLeft = Math.max(60, left);
  const safeRight = Math.max(60, right);
  const logRatio = Math.abs(Math.log(safeLeft / safeRight));
  return clamp01(1 - logRatio / Math.log(4));
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

function validateWeights(weights: BuildProfileSimilarityWeightsV2): void {
  const values = Object.values(weights);
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('Build archetype v2: similarity weights must be finite and non-negative');
  }
  if (weights.composition <= 0) {
    throw new Error('Build archetype v2: composition similarity weight must be positive');
  }
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
