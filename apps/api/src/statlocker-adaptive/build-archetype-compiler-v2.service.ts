import { Injectable } from '@nestjs/common';
import { RecommendationItemGraph } from '@dynamo-lab/build-domain';
import {
  BuildArchetypeFamilyV2,
  BuildArchetypeGroupV2,
  BuildArchetypeItemV2,
  BuildArchetypeRelationshipV2,
  BuildArchetypeV2,
  BuildObservedProgressionEdgeV2,
  BuildOrderEdgeV2,
  BuildPhaseV2,
  BuildProgressionNodeV2,
  StatlockerBuildProfileItemV2,
  StatlockerBuildProfileV2,
} from './build-archetype-v2';
import { BuildArchetypeClusterV2 } from './build-archetype-miner-v2.service';
import { STATLOCKER_BUILD_V2_CONFIG } from './statlocker-build-v2.config';

export interface BuildArchetypeCompilerV2Input {
  cluster: BuildArchetypeClusterV2;
  profiles: readonly StatlockerBuildProfileV2[];
  rulesetVersion: string;
  statlockerPatchId: string;
  catalogSha256: string;
  itemGraph?: RecommendationItemGraph;
}

interface FamilyEvidenceV2 {
  familyId: number;
  profiles: Map<string, readonly StatlockerBuildProfileItemV2[]>;
}

interface ProfileFamilyEvidenceV2 {
  accountId: string;
  representative: StatlockerBuildProfileItemV2;
  purchaseRate: number;
  frequencyTier: StatlockerBuildProfileItemV2['frequencyTier'];
  medianBuyTimeS: number;
  phase: BuildPhaseV2;
}

interface RelationshipAccumulatorV2 {
  leftFamilyId: number;
  rightFamilyId: number;
  valuesByProfile: Map<string, number>;
}

const TIER_SCORE: Readonly<Record<StatlockerBuildProfileItemV2['frequencyTier'], number>> = {
  CORE: 1,
  FREQUENT: 0.78,
  SOMETIMES: 0.48,
  FLEX: 0.22,
};

const PHASE_ORDER: readonly BuildPhaseV2[] = ['EARLY', 'MID', 'LATE'];

@Injectable()
export class BuildArchetypeCompilerV2Service {
  compile(input: BuildArchetypeCompilerV2Input): BuildArchetypeV2 {
    validateIdentity(input);
    const members = resolveClusterMembers(input.cluster, input.profiles);
    const familyEvidence = collectFamilyEvidence(members);
    const families = compileFamilies(familyEvidence, members.length, input.itemGraph);
    const items = compileItems(familyEvidence, members.length);
    if (families.length === 0 || items.length === 0) {
      throw new Error(`Build archetype v2 compiler: cluster ${input.cluster.clusterId} contains no semantic items`);
    }

    const representativeByFamily = new Map(items.map((item) => [item.familyId, item.itemId]));
    const itemToFamily = buildItemToFamilyMap(members);
    const relationships = compileRelationships(members, itemToFamily, representativeByFamily);
    const groups = compileGroups(members, items, itemToFamily, relationships);
    const orderEdges = compileOrderEdges(members, familyEvidence, representativeByFamily);

    return {
      archetypeId: `archetype:${input.cluster.clusterId}`,
      heroId: input.cluster.heroId,
      rulesetVersion: input.rulesetVersion,
      catalogSha256: input.catalogSha256.toLowerCase(),
      statlockerPatchId: input.statlockerPatchId,
      sourceProfileAccountIds: members.map((profile) => profile.accountId).sort(),
      families,
      items,
      groups,
      orderEdges,
      relationships,
      quality: {
        support: input.cluster.support,
        coherence: input.cluster.internalSimilarity,
        separation: input.cluster.separation,
        sourceProfileCount: members.length,
      },
    };
  }
}

function validateIdentity(input: BuildArchetypeCompilerV2Input): void {
  if (!input.cluster.clusterId) throw new Error('Build archetype v2 compiler: clusterId is required');
  if (!Number.isInteger(input.cluster.heroId) || input.cluster.heroId <= 0) {
    throw new Error('Build archetype v2 compiler: heroId must be a positive integer');
  }
  if (!input.rulesetVersion) throw new Error('Build archetype v2 compiler: rulesetVersion is required');
  if (!input.statlockerPatchId) throw new Error('Build archetype v2 compiler: statlockerPatchId is required');
  if (!/^[a-f0-9]{64}$/i.test(input.catalogSha256)) {
    throw new Error('Build archetype v2 compiler: catalogSha256 must be a 64-character hex digest');
  }
  if (input.cluster.profileAccountIds.length === 0) {
    throw new Error('Build archetype v2 compiler: cluster has no profiles');
  }
}

function resolveClusterMembers(
  cluster: BuildArchetypeClusterV2,
  profiles: readonly StatlockerBuildProfileV2[],
): StatlockerBuildProfileV2[] {
  const byAccountId = new Map<string, StatlockerBuildProfileV2>();
  for (const profile of profiles) {
    if (byAccountId.has(profile.accountId)) {
      throw new Error(`Build archetype v2 compiler: duplicate supplied profile ${profile.accountId}`);
    }
    byAccountId.set(profile.accountId, profile);
  }

  const memberIds = [...new Set(cluster.profileAccountIds)].sort();
  if (memberIds.length !== cluster.profileAccountIds.length) {
    throw new Error(`Build archetype v2 compiler: cluster ${cluster.clusterId} contains duplicate profile IDs`);
  }

  return memberIds.map((accountId) => {
    const profile = byAccountId.get(accountId);
    if (!profile) throw new Error(`Build archetype v2 compiler: missing cluster profile ${accountId}`);
    if (profile.heroId !== cluster.heroId) {
      throw new Error(`Build archetype v2 compiler: profile ${accountId} hero mismatch`);
    }
    if (profile.items.length === 0) {
      throw new Error(`Build archetype v2 compiler: profile ${accountId} has no items`);
    }
    return profile;
  });
}

function collectFamilyEvidence(
  profiles: readonly StatlockerBuildProfileV2[],
): Map<number, FamilyEvidenceV2> {
  const result = new Map<number, FamilyEvidenceV2>();
  for (const profile of profiles) {
    const byFamily = new Map<number, StatlockerBuildProfileItemV2[]>();
    for (const item of profile.items) {
      const current = byFamily.get(item.familyId) ?? [];
      current.push(item);
      byFamily.set(item.familyId, current);
    }
    for (const [familyId, values] of byFamily) {
      const aggregate = result.get(familyId) ?? { familyId, profiles: new Map() };
      aggregate.profiles.set(
        profile.accountId,
        [...values].sort((left, right) => left.itemId - right.itemId),
      );
      result.set(familyId, aggregate);
    }
  }
  return result;
}

function compileFamilies(
  familyEvidence: ReadonlyMap<number, FamilyEvidenceV2>,
  profileCount: number,
  itemGraph?: RecommendationItemGraph,
): BuildArchetypeFamilyV2[] {
  return [...familyEvidence.values()]
    .map((family) => compileFamily(family, profileCount, itemGraph))
    .sort((left, right) =>
      firstFamilyTiming(left) - firstFamilyTiming(right) || left.familyId - right.familyId,
    );
}

function compileFamily(
  family: FamilyEvidenceV2,
  profileCount: number,
  itemGraph?: RecommendationItemGraph,
): BuildArchetypeFamilyV2 {
  const observedByItemId = new Map<number, StatlockerBuildProfileItemV2[]>();
  for (const values of family.profiles.values()) {
    for (const item of values) {
      const observed = observedByItemId.get(item.itemId) ?? [];
      observed.push(item);
      observedByItemId.set(item.itemId, observed);
    }
  }

  const rawNodes = orderProgressionNodes(
    [...observedByItemId.entries()].map(([itemId, observed]) =>
      compileProgressionNode(itemId, observed, profileCount),
    ),
    itemGraph,
  );
  const strongTerminalIndexes = rawNodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => node.rawFrequencyTier === 'CORE' || node.rawFrequencyTier === 'FREQUENT')
    .map(({ index }) => index);
  const defaultTerminalIndex = strongTerminalIndexes.length > 0
    ? strongTerminalIndexes[strongTerminalIndexes.length - 1]
    : rawNodes.length - 1;

  const progressionNodes = rawNodes.map((node, index): BuildProgressionNodeV2 => ({
    ...node,
    progressionRole: index === defaultTerminalIndex
      ? 'DEFAULT_TERMINAL'
      : index > defaultTerminalIndex
        ? 'OPTIONAL_TERMINAL'
        : index === 0
          ? 'ENTRY'
          : 'INTERMEDIATE',
  }));
  const progressionEdges = compileProgressionEdges(family, progressionNodes, itemGraph);
  const defaultTerminal = progressionNodes[defaultTerminalIndex];
  const optionalTerminals = progressionNodes.filter((node) => node.progressionRole === 'OPTIONAL_TERMINAL');

  const perProfileTiers = [...family.profiles.values()].map((items) => modeTier(items.map((item) => item.frequencyTier)));
  const aggregateFrequencyTier = modeTier(perProfileTiers);
  const sourceProfileCount = family.profiles.size;
  const profileCoverage = sourceProfileCount / Math.max(1, profileCount);
  const profilePurchaseRates = [...family.profiles.values()].map((items) =>
    Math.max(...items.map((item) => item.purchaseRate)),
  );
  const purchaseRate = clamp01(mean(profilePurchaseRates));

  return {
    familyId: family.familyId,
    requirement: familyRequirement(family, profileCoverage, aggregateFrequencyTier),
    aggregateFrequencyTier,
    sourceProfileCount,
    profileCoverage,
    purchaseRate,
    structuralPriority: clamp01(
      profileCoverage * 0.45 +
      purchaseRate * 0.35 +
      TIER_SCORE[aggregateFrequencyTier] * 0.20,
    ),
    progressionNodes,
    progressionEdges,
    terminalCandidates: [
      terminalCandidate(defaultTerminal, 'DEFAULT_TERMINAL'),
      ...optionalTerminals.map((node) => terminalCandidate(node, 'OPTIONAL_TERMINAL')),
    ],
  };
}

function compileProgressionEdges(
  family: FamilyEvidenceV2,
  nodes: readonly BuildProgressionNodeV2[],
  itemGraph?: RecommendationItemGraph,
): BuildObservedProgressionEdgeV2[] {
  if (!itemGraph || nodes.length < 2) return [];
  const itemIds = nodes.map((node) => node.itemId).sort((a, b) => a - b);
  const observedIds = new Set(itemIds);
  const edges: BuildObservedProgressionEdgeV2[] = [];

  for (const fromItemId of itemIds) {
    for (const toItemId of itemGraph.getDirectUpgradeIds(fromItemId)) {
      if (!observedIds.has(toItemId)) continue;
      const supporting: Array<{ from: number; to: number }> = [];
      let reverseCount = 0;

      for (const values of family.profiles.values()) {
        const from = values.find((item) => item.itemId === fromItemId);
        const to = values.find((item) => item.itemId === toItemId);
        if (!from || !to) continue;
        if (from.medianBuyTimeS + STATLOCKER_BUILD_V2_CONFIG.orderTimingToleranceS < to.medianBuyTimeS) {
          supporting.push({ from: from.medianBuyTimeS, to: to.medianBuyTimeS });
        } else if (to.medianBuyTimeS + STATLOCKER_BUILD_V2_CONFIG.orderTimingToleranceS < from.medianBuyTimeS) {
          reverseCount += 1;
        }
      }

      const sourceProfileCount = supporting.length + reverseCount;
      if (sourceProfileCount < STATLOCKER_BUILD_V2_CONFIG.minOrderSourceProfiles) continue;
      const orderConfidence = supporting.length / sourceProfileCount;
      if (orderConfidence < STATLOCKER_BUILD_V2_CONFIG.softOrderConfidence) continue;

      const fromTimes = supporting.map((entry) => entry.from);
      const toTimes = supporting.map((entry) => entry.to);
      const fromMedianBuyTimeS = median(fromTimes);
      const toMedianBuyTimeS = median(toTimes);
      edges.push({
        fromItemId,
        toItemId,
        sourceProfileCount,
        orderedProfileCount: supporting.length,
        orderConfidence,
        timing: {
          fromMedianBuyTimeS,
          toMedianBuyTimeS,
          fromSpreadS: median(fromTimes.map((value) => Math.abs(value - fromMedianBuyTimeS))),
          toSpreadS: median(toTimes.map((value) => Math.abs(value - toMedianBuyTimeS))),
        },
        evidence: 'STATLOCKER_SAME_PROFILE',
      });
    }
  }

  return edges.sort((left, right) =>
    left.fromItemId - right.fromItemId || left.toItemId - right.toItemId,
  );
}

function compileProgressionNode(
  itemId: number,
  observed: readonly StatlockerBuildProfileItemV2[],
  profileCount: number,
): Omit<BuildProgressionNodeV2, 'progressionRole'> {
  const times = observed.map((item) => item.medianBuyTimeS);
  const timingMedian = weightedMedian(
    observed.map((item) => ({ value: item.medianBuyTimeS, weight: item.purchaseRate })),
  );
  return {
    itemId,
    rawFrequencyTier: modeTier(observed.map((item) => item.frequencyTier)),
    sourceProfileCount: observed.length,
    profileCoverage: observed.length / Math.max(1, profileCount),
    purchaseRate: clamp01(mean(observed.map((item) => item.purchaseRate))),
    timing: {
      medianBuyTimeS: timingMedian,
      spreadS: median(times.map((value) => Math.abs(value - timingMedian))),
      phase: modePhase(observed.map((item) => item.phase)),
    },
  };
}

function orderProgressionNodes(
  nodes: readonly Omit<BuildProgressionNodeV2, 'progressionRole'>[],
  itemGraph?: RecommendationItemGraph,
): Omit<BuildProgressionNodeV2, 'progressionRole'>[] {
  const fallback = [...nodes].sort(compareProgressionNodeFallback);
  if (!itemGraph || nodes.length < 2) return fallback;

  const byId = new Map(nodes.map((node) => [node.itemId, node]));
  const indegree = new Map(nodes.map((node) => [node.itemId, 0]));
  const outgoing = new Map<number, Set<number>>();

  for (const ancestor of nodes) {
    for (const descendant of nodes) {
      if (ancestor.itemId === descendant.itemId) continue;
      if (!itemGraph.isComponentAncestor(ancestor.itemId, descendant.itemId)) continue;
      const next = outgoing.get(ancestor.itemId) ?? new Set<number>();
      if (next.has(descendant.itemId)) continue;
      next.add(descendant.itemId);
      outgoing.set(ancestor.itemId, next);
      indegree.set(descendant.itemId, (indegree.get(descendant.itemId) ?? 0) + 1);
    }
  }

  const ready = nodes
    .filter((node) => (indegree.get(node.itemId) ?? 0) === 0)
    .sort(compareProgressionNodeFallback);
  const ordered: Omit<BuildProgressionNodeV2, 'progressionRole'>[] = [];

  while (ready.length > 0) {
    const current = ready.shift()!;
    ordered.push(current);
    for (const nextId of [...(outgoing.get(current.itemId) ?? [])].sort((a, b) => a - b)) {
      const nextIndegree = (indegree.get(nextId) ?? 0) - 1;
      indegree.set(nextId, nextIndegree);
      if (nextIndegree !== 0) continue;
      const next = byId.get(nextId);
      if (!next) continue;
      ready.push(next);
      ready.sort(compareProgressionNodeFallback);
    }
  }

  return ordered.length === nodes.length ? ordered : fallback;
}

function compareProgressionNodeFallback(
  left: Omit<BuildProgressionNodeV2, 'progressionRole'>,
  right: Omit<BuildProgressionNodeV2, 'progressionRole'>,
): number {
  return left.timing.medianBuyTimeS - right.timing.medianBuyTimeS || left.itemId - right.itemId;
}

function terminalCandidate(
  node: BuildProgressionNodeV2,
  kind: 'DEFAULT_TERMINAL' | 'OPTIONAL_TERMINAL',
): BuildArchetypeFamilyV2['terminalCandidates'][number] {
  return {
    itemId: node.itemId,
    kind,
    sourceProfileCount: node.sourceProfileCount,
    profileCoverage: node.profileCoverage,
    purchaseRate: node.purchaseRate,
    rawFrequencyTier: node.rawFrequencyTier,
  };
}

function familyRequirement(
  family: FamilyEvidenceV2,
  profileCoverage: number,
  aggregateFrequencyTier: StatlockerBuildProfileItemV2['frequencyTier'],
): BuildArchetypeFamilyV2['requirement'] {
  const explicitTypes = new Set(
    [...family.profiles.values()].flatMap((items) =>
      items.flatMap((item) => item.explicitGroup ? [item.explicitGroup.type] : []),
    ),
  );
  if (explicitTypes.has('REQUIRED')) return 'REQUIRED';
  if (explicitTypes.has('OPTIONAL') || explicitTypes.has('CHOICE')) return 'OPTIONAL';
  if (profileCoverage === 1 && aggregateFrequencyTier === 'CORE') return 'REQUIRED';
  if (aggregateFrequencyTier === 'FREQUENT') return 'OPTIONAL';
  return 'SITUATIONAL';
}

function firstFamilyTiming(family: BuildArchetypeFamilyV2): number {
  return family.progressionNodes[0]?.timing.medianBuyTimeS ?? 0;
}

function compileItems(
  familyEvidence: ReadonlyMap<number, FamilyEvidenceV2>,
  profileCount: number,
): BuildArchetypeItemV2[] {
  return [...familyEvidence.values()]
    .map((family) => compileItem(family, profileCount))
    .sort((left, right) =>
      left.timing.medianBuyTimeS - right.timing.medianBuyTimeS ||
      left.itemId - right.itemId,
    );
}

function compileItem(family: FamilyEvidenceV2, profileCount: number): BuildArchetypeItemV2 {
  const exactItemStats = new Map<number, { profileIds: Set<string>; purchaseRates: number[]; strongestTier: number }>();
  for (const [accountId, values] of family.profiles) {
    for (const item of values) {
      const stat = exactItemStats.get(item.itemId) ?? {
        profileIds: new Set<string>(),
        purchaseRates: [],
        strongestTier: 0,
      };
      stat.profileIds.add(accountId);
      stat.purchaseRates.push(item.purchaseRate);
      stat.strongestTier = Math.max(stat.strongestTier, TIER_SCORE[item.frequencyTier]);
      exactItemStats.set(item.itemId, stat);
    }
  }

  const representativeItemId = [...exactItemStats.entries()]
    .sort(([leftId, left], [rightId, right]) =>
      right.profileIds.size - left.profileIds.size ||
      mean(right.purchaseRates) - mean(left.purchaseRates) ||
      right.strongestTier - left.strongestTier ||
      leftId - rightId,
    )[0][0];

  const perProfile = [...family.profiles.entries()]
    .map(([accountId, values]) => profileFamilyEvidence(accountId, values, representativeItemId))
    .sort((left, right) => left.accountId.localeCompare(right.accountId));
  const tier = modeTier(perProfile.map((entry) => entry.frequencyTier));
  const timingValues = perProfile.map((entry) => entry.medianBuyTimeS);
  const timingMedian = weightedMedian(
    perProfile.map((entry) => ({ value: entry.medianBuyTimeS, weight: entry.purchaseRate })),
  );

  return {
    itemId: representativeItemId,
    familyId: family.familyId,
    role: roleForTier(tier),
    sourceProfileCount: perProfile.length,
    profileCoverage: perProfile.length / Math.max(1, profileCount),
    purchaseRate: clamp01(mean(perProfile.map((entry) => entry.purchaseRate))),
    timing: {
      medianBuyTimeS: timingMedian,
      spreadS: median(timingValues.map((value) => Math.abs(value - timingMedian))),
      phase: modePhase(perProfile.map((entry) => entry.phase)),
    },
    structuralPriority: clamp01(
      (perProfile.length / Math.max(1, profileCount)) * 0.45 +
      mean(perProfile.map((entry) => entry.purchaseRate)) * 0.35 +
      TIER_SCORE[tier] * 0.20,
    ),
  };
}

function profileFamilyEvidence(
  accountId: string,
  items: readonly StatlockerBuildProfileItemV2[],
  representativeItemId: number,
): ProfileFamilyEvidenceV2 {
  const representative = items.find((item) => item.itemId === representativeItemId)
    ?? [...items].sort((left, right) =>
      TIER_SCORE[right.frequencyTier] - TIER_SCORE[left.frequencyTier] ||
      right.purchaseRate - left.purchaseRate ||
      right.itemId - left.itemId,
    )[0];
  const tier = modeTier(items.map((item) => item.frequencyTier));
  const purchaseRate = Math.max(...items.map((item) => item.purchaseRate));
  const times = items.map((item) => item.medianBuyTimeS);
  return {
    accountId,
    representative,
    purchaseRate,
    frequencyTier: tier,
    medianBuyTimeS: representative.itemId === representativeItemId
      ? representative.medianBuyTimeS
      : median(times),
    phase: representative.itemId === representativeItemId
      ? representative.phase
      : modePhase(items.map((item) => item.phase)),
  };
}

function buildItemToFamilyMap(
  profiles: readonly StatlockerBuildProfileV2[],
): Map<number, number> {
  const result = new Map<number, number>();
  for (const profile of profiles) {
    for (const item of profile.items) {
      const existing = result.get(item.itemId);
      if (existing !== undefined && existing !== item.familyId) {
        throw new Error(`Build archetype v2 compiler: item ${item.itemId} maps to conflicting semantic families`);
      }
      result.set(item.itemId, item.familyId);
    }
  }
  return result;
}

function compileRelationships(
  profiles: readonly StatlockerBuildProfileV2[],
  itemToFamily: ReadonlyMap<number, number>,
  representativeByFamily: ReadonlyMap<number, number>,
): BuildArchetypeRelationshipV2[] {
  const accumulators = new Map<string, RelationshipAccumulatorV2>();
  for (const profile of profiles) {
    const perProfile = new Map<string, number>();
    for (const item of profile.items) {
      for (const relationship of item.relationships) {
        const targetFamily = itemToFamily.get(relationship.itemId);
        if (targetFamily === undefined || targetFamily === item.familyId) continue;
        const leftFamilyId = Math.min(item.familyId, targetFamily);
        const rightFamilyId = Math.max(item.familyId, targetFamily);
        const key = `${leftFamilyId}:${rightFamilyId}`;
        perProfile.set(key, Math.max(perProfile.get(key) ?? 0, clamp01(relationship.strength)));
      }
    }
    for (const [key, strength] of perProfile) {
      const [leftFamilyId, rightFamilyId] = key.split(':').map(Number);
      const aggregate = accumulators.get(key) ?? {
        leftFamilyId,
        rightFamilyId,
        valuesByProfile: new Map<string, number>(),
      };
      aggregate.valuesByProfile.set(profile.accountId, strength);
      accumulators.set(key, aggregate);
    }
  }

  return [...accumulators.values()]
    .flatMap((entry) => {
      const leftItemId = representativeByFamily.get(entry.leftFamilyId);
      const rightItemId = representativeByFamily.get(entry.rightFamilyId);
      if (leftItemId === undefined || rightItemId === undefined) return [];
      return [{
        leftFamilyId: entry.leftFamilyId,
        rightFamilyId: entry.rightFamilyId,
        leftItemId: Math.min(leftItemId, rightItemId),
        rightItemId: Math.max(leftItemId, rightItemId),
        strength: mean([...entry.valuesByProfile.values()]),
        sourceProfileCount: entry.valuesByProfile.size,
      } satisfies BuildArchetypeRelationshipV2];
    })
    .sort((left, right) => left.leftItemId - right.leftItemId || left.rightItemId - right.rightItemId);
}

function compileGroups(
  profiles: readonly StatlockerBuildProfileV2[],
  items: readonly BuildArchetypeItemV2[],
  itemToFamily: ReadonlyMap<number, number>,
  relationships: readonly BuildArchetypeRelationshipV2[],
): BuildArchetypeGroupV2[] {
  const representativeByFamily = new Map(items.map((item) => [item.familyId, item.itemId]));
  const explicit = compileExplicitGroups(profiles, itemToFamily, representativeByFamily);
  const explicitItemIds = new Set(explicit.flatMap((group) => group.candidateItemIds));
  const inferred = compileInferredChoiceGroups(profiles, items, relationships, explicitItemIds);
  return [...explicit, ...inferred].sort((left, right) => left.groupId.localeCompare(right.groupId));
}

function compileExplicitGroups(
  profiles: readonly StatlockerBuildProfileV2[],
  itemToFamily: ReadonlyMap<number, number>,
  representativeByFamily: ReadonlyMap<number, number>,
): BuildArchetypeGroupV2[] {
  const byKey = new Map<string, {
    type: BuildArchetypeGroupV2['type'];
    minSelect: number;
    maxSelect: number;
    profileIds: Set<string>;
    familyIds: Set<number>;
  }>();

  for (const profile of profiles) {
    for (const item of profile.items) {
      const group = item.explicitGroup;
      if (!group) continue;
      const current = byKey.get(group.groupKey);
      if (current && (
        current.type !== group.type ||
        current.minSelect !== group.minSelect ||
        current.maxSelect !== group.maxSelect
      )) {
        throw new Error(`Build archetype v2 compiler: conflicting explicit group ${group.groupKey}`);
      }
      const aggregate = current ?? {
        type: group.type,
        minSelect: group.minSelect,
        maxSelect: group.maxSelect,
        profileIds: new Set<string>(),
        familyIds: new Set<number>(),
      };
      aggregate.profileIds.add(profile.accountId);
      aggregate.familyIds.add(itemToFamily.get(item.itemId) ?? item.familyId);
      byKey.set(group.groupKey, aggregate);
    }
  }

  return [...byKey.entries()]
    .map(([groupId, value]) => ({
      groupId,
      type: value.type,
      candidateFamilyIds: [...value.familyIds].sort((a, b) => a - b),
      candidateItemIds: [...value.familyIds]
        .map((familyId) => representativeByFamily.get(familyId))
        .filter((itemId): itemId is number => itemId !== undefined)
        .sort((a, b) => a - b),
      minSelect: value.minSelect,
      maxSelect: value.maxSelect,
      source: 'STATLOCKER_EXPLICIT' as const,
      confidence: value.profileIds.size / Math.max(1, profiles.length),
    }));
}

function compileInferredChoiceGroups(
  profiles: readonly StatlockerBuildProfileV2[],
  items: readonly BuildArchetypeItemV2[],
  relationships: readonly BuildArchetypeRelationshipV2[],
  explicitItemIds: ReadonlySet<number>,
): BuildArchetypeGroupV2[] {
  const candidates = items
    .filter((item) => !explicitItemIds.has(item.itemId))
    .filter((item) => item.role === 'SITUATIONAL' || item.role === 'FLEX')
    .sort((a, b) => a.itemId - b.itemId);
  const familyByRepresentative = new Map(items.map((item) => [item.itemId, item.familyId]));
  const profileFamilies = profiles.map((profile) => new Set(profile.items.map((item) => item.familyId)));
  const neighbors = relationshipNeighbors(relationships);
  const used = new Set<number>();
  const result: BuildArchetypeGroupV2[] = [];

  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    const left = candidates[leftIndex];
    if (used.has(left.itemId)) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const right = candidates[rightIndex];
      if (used.has(right.itemId)) continue;
      if (left.timing.phase !== right.timing.phase) continue;
      if (Math.abs(left.timing.medianBuyTimeS - right.timing.medianBuyTimeS) > STATLOCKER_BUILD_V2_CONFIG.inferredChoiceMaxTimingGapS) continue;

      const leftFamilyId = familyByRepresentative.get(left.itemId)!;
      const rightFamilyId = familyByRepresentative.get(right.itemId)!;
      const leftPresence = profileFamilies.filter((families) => families.has(leftFamilyId)).length;
      const rightPresence = profileFamilies.filter((families) => families.has(rightFamilyId)).length;
      const cooccurrence = profileFamilies.filter((families) => families.has(leftFamilyId) && families.has(rightFamilyId)).length;
      const cooccurrenceRate = cooccurrence / Math.max(1, Math.min(leftPresence, rightPresence));
      if (cooccurrenceRate > STATLOCKER_BUILD_V2_CONFIG.inferredChoiceMaxCooccurrence) continue;

      const sharedNeighborStrength = strongestSharedNeighbor(
        neighbors.get(left.itemId),
        neighbors.get(right.itemId),
      );
      if (sharedNeighborStrength < STATLOCKER_BUILD_V2_CONFIG.inferredChoiceMinRelationshipStrength) continue;

      used.add(left.itemId);
      used.add(right.itemId);
      result.push({
        groupId: `inferred-choice:${left.itemId}:${right.itemId}`,
        type: 'CHOICE',
        candidateFamilyIds: [leftFamilyId, rightFamilyId].sort((a, b) => a - b),
        candidateItemIds: [left.itemId, right.itemId],
        minSelect: 1,
        maxSelect: 1,
        source: 'INFERRED_CONSENSUS',
        confidence: clamp01((1 - cooccurrenceRate) * 0.6 + sharedNeighborStrength * 0.4),
      });
      break;
    }
  }
  return result;
}

function relationshipNeighbors(
  relationships: readonly BuildArchetypeRelationshipV2[],
): Map<number, Map<number, number>> {
  const result = new Map<number, Map<number, number>>();
  for (const relationship of relationships) {
    const left = result.get(relationship.leftItemId) ?? new Map<number, number>();
    left.set(relationship.rightItemId, Math.max(left.get(relationship.rightItemId) ?? 0, relationship.strength));
    result.set(relationship.leftItemId, left);
    const right = result.get(relationship.rightItemId) ?? new Map<number, number>();
    right.set(relationship.leftItemId, Math.max(right.get(relationship.leftItemId) ?? 0, relationship.strength));
    result.set(relationship.rightItemId, right);
  }
  return result;
}

function strongestSharedNeighbor(
  left: ReadonlyMap<number, number> | undefined,
  right: ReadonlyMap<number, number> | undefined,
): number {
  if (!left || !right) return 0;
  let strength = 0;
  for (const [neighbor, leftStrength] of left) {
    const rightStrength = right.get(neighbor);
    if (rightStrength === undefined) continue;
    strength = Math.max(strength, Math.min(leftStrength, rightStrength));
  }
  return strength;
}

function compileOrderEdges(
  profiles: readonly StatlockerBuildProfileV2[],
  familyEvidence: ReadonlyMap<number, FamilyEvidenceV2>,
  representativeByFamily: ReadonlyMap<number, number>,
): BuildOrderEdgeV2[] {
  const families = [...familyEvidence.keys()].sort((a, b) => a - b);
  const candidates: BuildOrderEdgeV2[] = [];
  for (let leftIndex = 0; leftIndex < families.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < families.length; rightIndex += 1) {
      const leftFamily = families[leftIndex];
      const rightFamily = families[rightIndex];
      let leftBefore = 0;
      let rightBefore = 0;
      let sharedProfiles = 0;

      for (const profile of profiles) {
        const leftItems = familyEvidence.get(leftFamily)?.profiles.get(profile.accountId);
        const rightItems = familyEvidence.get(rightFamily)?.profiles.get(profile.accountId);
        if (!leftItems || !rightItems) continue;
        sharedProfiles += 1;
        const leftTime = familyTime(leftItems, representativeByFamily.get(leftFamily)!);
        const rightTime = familyTime(rightItems, representativeByFamily.get(rightFamily)!);
        if (leftTime + STATLOCKER_BUILD_V2_CONFIG.orderTimingToleranceS < rightTime) leftBefore += 1;
        else if (rightTime + STATLOCKER_BUILD_V2_CONFIG.orderTimingToleranceS < leftTime) rightBefore += 1;
      }

      if (sharedProfiles < STATLOCKER_BUILD_V2_CONFIG.minOrderSourceProfiles) continue;
      const directional = leftBefore + rightBefore;
      if (directional === 0) continue;
      const majority = Math.max(leftBefore, rightBefore);
      const confidence = majority / directional;
      if (confidence < STATLOCKER_BUILD_V2_CONFIG.softOrderConfidence) continue;

      const beforeFamily = leftBefore >= rightBefore ? leftFamily : rightFamily;
      const afterFamily = leftBefore >= rightBefore ? rightFamily : leftFamily;
      candidates.push({
        beforeFamilyId: beforeFamily,
        afterFamilyId: afterFamily,
        beforeItemId: representativeByFamily.get(beforeFamily)!,
        afterItemId: representativeByFamily.get(afterFamily)!,
        confidence,
        sourceProfileCount: sharedProfiles,
        strength: confidence >= STATLOCKER_BUILD_V2_CONFIG.hardOrderConfidence ? 'HARD' : 'SOFT',
      });
    }
  }

  return pruneOrderCycles(candidates).sort((left, right) =>
    left.beforeItemId - right.beforeItemId ||
    left.afterItemId - right.afterItemId,
  );
}

function pruneOrderCycles(candidates: readonly BuildOrderEdgeV2[]): BuildOrderEdgeV2[] {
  const accepted: BuildOrderEdgeV2[] = [];
  const ordered = [...candidates].sort((left, right) =>
    (left.strength === right.strength ? 0 : left.strength === 'HARD' ? -1 : 1) ||
    right.confidence - left.confidence ||
    right.sourceProfileCount - left.sourceProfileCount ||
    left.beforeItemId - right.beforeItemId ||
    left.afterItemId - right.afterItemId,
  );

  for (const candidate of ordered) {
    if (wouldCreateOrderCycle(accepted, candidate)) continue;
    accepted.push(candidate);
  }
  return accepted;
}

function wouldCreateOrderCycle(
  accepted: readonly BuildOrderEdgeV2[],
  candidate: BuildOrderEdgeV2,
): boolean {
  if (candidate.beforeItemId === candidate.afterItemId) return true;
  const adjacency = new Map<number, number[]>();
  for (const edge of accepted) {
    const next = adjacency.get(edge.beforeItemId) ?? [];
    next.push(edge.afterItemId);
    adjacency.set(edge.beforeItemId, next);
  }

  const pending = [candidate.afterItemId];
  const visited = new Set<number>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === candidate.beforeItemId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of adjacency.get(current) ?? []) pending.push(next);
  }
  return false;
}

function familyTime(
  items: readonly StatlockerBuildProfileItemV2[],
  representativeItemId: number,
): number {
  return items.find((item) => item.itemId === representativeItemId)?.medianBuyTimeS
    ?? median(items.map((item) => item.medianBuyTimeS));
}

function roleForTier(tier: StatlockerBuildProfileItemV2['frequencyTier']): BuildArchetypeItemV2['role'] {
  if (tier === 'CORE') return 'CORE';
  if (tier === 'FREQUENT') return 'FREQUENT';
  if (tier === 'SOMETIMES') return 'SITUATIONAL';
  return 'FLEX';
}

function modeTier(
  values: readonly StatlockerBuildProfileItemV2['frequencyTier'][],
): StatlockerBuildProfileItemV2['frequencyTier'] {
  const counts = new Map<StatlockerBuildProfileItemV2['frequencyTier'], number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([leftTier, leftCount], [rightTier, rightCount]) =>
      rightCount - leftCount || TIER_SCORE[rightTier] - TIER_SCORE[leftTier],
    )[0][0];
}

function modePhase(values: readonly BuildPhaseV2[]): BuildPhaseV2 {
  const counts = new Map<BuildPhaseV2, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([leftPhase, leftCount], [rightPhase, rightCount]) =>
      rightCount - leftCount || PHASE_ORDER.indexOf(leftPhase) - PHASE_ORDER.indexOf(rightPhase),
    )[0][0];
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function weightedMedian(observations: readonly { value: number; weight: number }[]): number {
  const values = observations.map((observation) => observation.value);
  const totalWeight = observations.reduce((sum, observation) => sum + observation.weight, 0);
  if (!Number.isFinite(totalWeight) || totalWeight <= 0) return median(values);
  // Equal weights must keep matching the legacy even-count median, which averages the middle pair.
  if (observations.every((observation) => observation.weight === observations[0].weight)) {
    return median(values);
  }
  const sorted = [...observations].sort((left, right) => left.value - right.value);
  const halfWeight = totalWeight / 2;
  let cumulative = 0;
  for (const observation of sorted) {
    cumulative += observation.weight;
    if (cumulative >= halfWeight) return observation.value;
  }
  return sorted[sorted.length - 1].value;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
