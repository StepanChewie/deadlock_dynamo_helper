import { Injectable } from '@nestjs/common';
import { RecommendationItemGraph } from '@deadlock-live-probe/build-domain';
import { BuildArchetypeSnapshotV2, BuildArchetypeV2 } from './build-archetype-v2';
import { STATLOCKER_BUILD_V2_CONFIG } from './statlocker-build-v2.config';

export type BuildArchetypeQualityReasonCodeV2 =
  | 'SNAPSHOT_IDENTITY_INVALID'
  | 'SNAPSHOT_ARCHETYPES_EMPTY'
  | 'DUPLICATE_ARCHETYPE_ID'
  | 'ARCHETYPE_IDENTITY_MISMATCH'
  | 'INSUFFICIENT_SOURCE_PROFILES'
  | 'SOURCE_PROFILE_COUNT_MISMATCH'
  | 'QUALITY_METRICS_INVALID'
  | 'COHERENCE_BELOW_THRESHOLD'
  | 'INSUFFICIENT_SEPARATION'
  | 'DUPLICATE_SEMANTIC_FAMILY'
  | 'DUPLICATE_ITEM_ID'
  | 'ITEM_METRICS_INVALID'
  | 'UNKNOWN_ITEM'
  | 'ITEM_UNAVAILABLE_IN_RULESET'
  | 'DUPLICATE_GROUP_ID'
  | 'GROUP_UNKNOWN_ITEM'
  | 'CONFLICTING_GROUP_MEMBERSHIP'
  | 'INVALID_GROUP_BOUNDS'
  | 'DUPLICATE_ORDER_EDGE'
  | 'ORDER_EDGE_UNKNOWN_ITEM'
  | 'ORDER_GRAPH_SELF_EDGE'
  | 'ORDER_GRAPH_CYCLE'
  | 'RELATIONSHIP_UNKNOWN_ITEM'
  | 'RELATIONSHIP_SELF_EDGE'
  | 'MEANINGLESS_PROGRESSION';

export interface BuildArchetypeQualityCheckV2 {
  archetypeId: string;
  accepted: boolean;
  reasonCodes: readonly BuildArchetypeQualityReasonCodeV2[];
  details: {
    sourceProfileCount: number;
    semanticFamilyCount: number;
    itemCount: number;
    groupCount: number;
    orderEdgeCount: number;
  };
}

export interface BuildArchetypeQualityGateResultV2 {
  accepted: boolean;
  reasonCodes: readonly BuildArchetypeQualityReasonCodeV2[];
  archetypes: readonly BuildArchetypeQualityCheckV2[];
}

@Injectable()
export class BuildArchetypeQualityGateV2Service {
  evaluate(
    snapshot: BuildArchetypeSnapshotV2,
    graph: RecommendationItemGraph,
  ): BuildArchetypeQualityGateResultV2 {
    const snapshotReasons = new Set<BuildArchetypeQualityReasonCodeV2>();
    validateSnapshotIdentity(snapshot, snapshotReasons);

    if (snapshot.archetypes.length === 0) {
      snapshotReasons.add('SNAPSHOT_ARCHETYPES_EMPTY');
    }

    const archetypeIds = new Set<string>();
    for (const archetype of snapshot.archetypes) {
      if (archetypeIds.has(archetype.archetypeId)) snapshotReasons.add('DUPLICATE_ARCHETYPE_ID');
      archetypeIds.add(archetype.archetypeId);
    }

    const archetypes = snapshot.archetypes.map((archetype) =>
      evaluateArchetype(archetype, snapshot, graph, snapshot.archetypes.length > 1),
    );
    for (const result of archetypes) {
      for (const reason of result.reasonCodes) snapshotReasons.add(reason);
    }

    const reasonCodes = [...snapshotReasons].sort();
    return {
      accepted: reasonCodes.length === 0 && archetypes.every((entry) => entry.accepted),
      reasonCodes,
      archetypes,
    };
  }
}

function validateSnapshotIdentity(
  snapshot: BuildArchetypeSnapshotV2,
  reasons: Set<BuildArchetypeQualityReasonCodeV2>,
): void {
  const generatedAt = Date.parse(snapshot.generatedAt);
  const sourceIds = snapshot.sourceProfileAccountIds;
  if (
    snapshot.snapshotId.trim() === '' ||
    !Number.isInteger(snapshot.heroId) || snapshot.heroId <= 0 ||
    snapshot.rulesetVersion.trim() === '' ||
    snapshot.statlockerPatchId.trim() === '' ||
    !/^[a-f0-9]{64}$/i.test(snapshot.catalogSha256) ||
    !Number.isFinite(generatedAt) ||
    sourceIds.length === 0 ||
    new Set(sourceIds).size !== sourceIds.length ||
    sourceIds.some((accountId) => accountId.trim() === '')
  ) {
    reasons.add('SNAPSHOT_IDENTITY_INVALID');
  }
}

function evaluateArchetype(
  archetype: BuildArchetypeV2,
  snapshot: BuildArchetypeSnapshotV2,
  graph: RecommendationItemGraph,
  requireSeparation: boolean,
): BuildArchetypeQualityCheckV2 {
  const reasons = new Set<BuildArchetypeQualityReasonCodeV2>();
  const sourceProfileIds = new Set(archetype.sourceProfileAccountIds);
  const snapshotSourceProfileIds = new Set(snapshot.sourceProfileAccountIds);

  if (
    archetype.archetypeId.trim() === '' ||
    archetype.heroId !== snapshot.heroId ||
    archetype.rulesetVersion !== snapshot.rulesetVersion ||
    archetype.statlockerPatchId !== snapshot.statlockerPatchId ||
    archetype.catalogSha256.toLowerCase() !== snapshot.catalogSha256.toLowerCase()
  ) {
    reasons.add('ARCHETYPE_IDENTITY_MISMATCH');
  }

  if (
    sourceProfileIds.size !== archetype.sourceProfileAccountIds.length ||
    [...sourceProfileIds].some((accountId) => !snapshotSourceProfileIds.has(accountId)) ||
    archetype.sourceProfileAccountIds.some((accountId) => accountId.trim() === '')
  ) {
    reasons.add('SOURCE_PROFILE_COUNT_MISMATCH');
  }

  if (sourceProfileIds.size < STATLOCKER_BUILD_V2_CONFIG.minClusterSize) {
    reasons.add('INSUFFICIENT_SOURCE_PROFILES');
  }
  if (archetype.quality.sourceProfileCount !== sourceProfileIds.size) {
    reasons.add('SOURCE_PROFILE_COUNT_MISMATCH');
  }

  if (
    !inUnitRange(archetype.quality.support) ||
    !inUnitRange(archetype.quality.coherence) ||
    !inUnitRange(archetype.quality.separation)
  ) {
    reasons.add('QUALITY_METRICS_INVALID');
  }
  const minCoherence = requireSeparation
    ? STATLOCKER_BUILD_V2_CONFIG.minInternalSimilarity
    : STATLOCKER_BUILD_V2_CONFIG.minConsensusSimilarity;
  if (Number.isFinite(archetype.quality.coherence) && archetype.quality.coherence < minCoherence) {
    reasons.add('COHERENCE_BELOW_THRESHOLD');
  }
  if (
    requireSeparation &&
    Number.isFinite(archetype.quality.separation) &&
    archetype.quality.separation < STATLOCKER_BUILD_V2_CONFIG.minClusterSeparation
  ) {
    reasons.add('INSUFFICIENT_SEPARATION');
  }

  const itemIds = new Set<number>();
  const familyIds = new Set<number>();
  for (const item of archetype.items) {
    if (itemIds.has(item.itemId)) reasons.add('DUPLICATE_ITEM_ID');
    itemIds.add(item.itemId);
    if (familyIds.has(item.familyId)) reasons.add('DUPLICATE_SEMANTIC_FAMILY');
    familyIds.add(item.familyId);

    if (
      !Number.isInteger(item.itemId) || item.itemId <= 0 ||
      !Number.isInteger(item.familyId) || item.familyId <= 0 ||
      !Number.isInteger(item.sourceProfileCount) || item.sourceProfileCount <= 0 ||
      item.sourceProfileCount > sourceProfileIds.size ||
      !inUnitRange(item.profileCoverage) ||
      !inUnitRange(item.purchaseRate) ||
      !inUnitRange(item.structuralPriority) ||
      !Number.isFinite(item.timing.medianBuyTimeS) || item.timing.medianBuyTimeS < 0 ||
      !Number.isFinite(item.timing.spreadS) || item.timing.spreadS < 0
    ) {
      reasons.add('ITEM_METRICS_INVALID');
    }

    const definition = graph.getItem(item.itemId);
    if (!definition) {
      reasons.add('UNKNOWN_ITEM');
    } else if (!definition.availableRulesetIds.includes(snapshot.rulesetVersion)) {
      reasons.add('ITEM_UNAVAILABLE_IN_RULESET');
    }
  }

  validateGroups(archetype, itemIds, reasons);
  validateOrderGraph(archetype, itemIds, reasons);
  validateRelationships(archetype, itemIds, reasons);

  const hasStructuralProgression = archetype.items.some((item) => item.role === 'CORE' || item.role === 'FREQUENT') ||
    archetype.groups.some((group) => group.minSelect > 0);
  if (archetype.items.length === 0 || !hasStructuralProgression) {
    reasons.add('MEANINGLESS_PROGRESSION');
  }

  const reasonCodes = [...reasons].sort();
  return {
    archetypeId: archetype.archetypeId,
    accepted: reasonCodes.length === 0,
    reasonCodes,
    details: {
      sourceProfileCount: sourceProfileIds.size,
      semanticFamilyCount: familyIds.size,
      itemCount: archetype.items.length,
      groupCount: archetype.groups.length,
      orderEdgeCount: archetype.orderEdges.length,
    },
  };
}

function validateGroups(
  archetype: BuildArchetypeV2,
  itemIds: ReadonlySet<number>,
  reasons: Set<BuildArchetypeQualityReasonCodeV2>,
): void {
  const groupIds = new Set<string>();
  const groupByItemId = new Map<number, string>();
  for (const group of archetype.groups) {
    if (groupIds.has(group.groupId) || group.groupId.trim() === '') reasons.add('DUPLICATE_GROUP_ID');
    groupIds.add(group.groupId);

    const candidates = new Set(group.candidateItemIds);
    if (
      candidates.size !== group.candidateItemIds.length ||
      candidates.size === 0 ||
      !Number.isInteger(group.minSelect) || !Number.isInteger(group.maxSelect) ||
      group.minSelect < 0 || group.maxSelect < 1 || group.minSelect > group.maxSelect ||
      group.maxSelect > candidates.size ||
      ((group.type === 'REQUIRED' || group.type === 'CHOICE') && group.minSelect < 1) ||
      !inUnitRange(group.confidence)
    ) {
      reasons.add('INVALID_GROUP_BOUNDS');
    }

    for (const itemId of candidates) {
      if (!itemIds.has(itemId)) reasons.add('GROUP_UNKNOWN_ITEM');
      const previous = groupByItemId.get(itemId);
      if (previous !== undefined && previous !== group.groupId) reasons.add('CONFLICTING_GROUP_MEMBERSHIP');
      groupByItemId.set(itemId, group.groupId);
    }
  }
}

function validateOrderGraph(
  archetype: BuildArchetypeV2,
  itemIds: ReadonlySet<number>,
  reasons: Set<BuildArchetypeQualityReasonCodeV2>,
): void {
  const edgeKeys = new Set<string>();
  const adjacency = new Map<number, number[]>();
  for (const edge of archetype.orderEdges) {
    const key = `${edge.beforeItemId}:${edge.afterItemId}`;
    if (edgeKeys.has(key)) reasons.add('DUPLICATE_ORDER_EDGE');
    edgeKeys.add(key);
    if (!itemIds.has(edge.beforeItemId) || !itemIds.has(edge.afterItemId)) {
      reasons.add('ORDER_EDGE_UNKNOWN_ITEM');
      continue;
    }
    if (edge.beforeItemId === edge.afterItemId) {
      reasons.add('ORDER_GRAPH_SELF_EDGE');
      continue;
    }
    if (!inUnitRange(edge.confidence) || !Number.isInteger(edge.sourceProfileCount) || edge.sourceProfileCount <= 0) {
      reasons.add('QUALITY_METRICS_INVALID');
    }
    const next = adjacency.get(edge.beforeItemId) ?? [];
    next.push(edge.afterItemId);
    adjacency.set(edge.beforeItemId, next);
  }

  if (hasCycle(itemIds, adjacency)) reasons.add('ORDER_GRAPH_CYCLE');
}

function validateRelationships(
  archetype: BuildArchetypeV2,
  itemIds: ReadonlySet<number>,
  reasons: Set<BuildArchetypeQualityReasonCodeV2>,
): void {
  for (const relationship of archetype.relationships) {
    if (!itemIds.has(relationship.leftItemId) || !itemIds.has(relationship.rightItemId)) {
      reasons.add('RELATIONSHIP_UNKNOWN_ITEM');
    }
    if (relationship.leftItemId === relationship.rightItemId) reasons.add('RELATIONSHIP_SELF_EDGE');
    if (!inUnitRange(relationship.strength) ||
      !Number.isInteger(relationship.sourceProfileCount) || relationship.sourceProfileCount <= 0) {
      reasons.add('QUALITY_METRICS_INVALID');
    }
  }
}

function hasCycle(
  itemIds: ReadonlySet<number>,
  adjacency: ReadonlyMap<number, readonly number[]>,
): boolean {
  const visiting = new Set<number>();
  const visited = new Set<number>();

  const visit = (itemId: number): boolean => {
    if (visiting.has(itemId)) return true;
    if (visited.has(itemId)) return false;
    visiting.add(itemId);
    for (const next of adjacency.get(itemId) ?? []) {
      if (visit(next)) return true;
    }
    visiting.delete(itemId);
    visited.add(itemId);
    return false;
  };

  return [...itemIds].some((itemId) => visit(itemId));
}

function inUnitRange(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}
