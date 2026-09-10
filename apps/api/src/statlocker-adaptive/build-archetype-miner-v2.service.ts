import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { StatlockerBuildProfileV2 } from './build-archetype-v2';
import { compareBuildProfilesV2 } from './build-archetype-similarity-v2';
import {
  STATLOCKER_BUILD_V2_CONFIG,
  StatlockerBuildV2Config,
} from './statlocker-build-v2.config';

export type BuildArchetypeClusterRejectionReasonV2 =
  | 'CLUSTER_TOO_SMALL'
  | 'INSUFFICIENT_INTERNAL_SIMILARITY'
  | 'INSUFFICIENT_SEPARATION'
  | 'ORDER_ONLY_VARIATION'
  | 'MAX_ARCHETYPES_EXCEEDED'
  | 'INSUFFICIENT_SOURCE_PROFILES'
  | 'NO_COHERENT_ARCHETYPE';

export interface BuildArchetypeClusterV2 {
  clusterId: string;
  heroId: number;
  profileAccountIds: readonly string[];
  support: number;
  internalSimilarity: number;
  separation: number;
  reasonCodes: readonly string[];
}

export interface RejectedBuildArchetypeClusterV2 {
  clusterId: string;
  heroId: number;
  profileAccountIds: readonly string[];
  support: number;
  internalSimilarity: number;
  separation: number;
  reasonCodes: readonly BuildArchetypeClusterRejectionReasonV2[];
}

export interface BuildArchetypeMiningResultV2 {
  heroId?: number;
  accepted: readonly BuildArchetypeClusterV2[];
  rejected: readonly RejectedBuildArchetypeClusterV2[];
  pairwiseSimilarities: Readonly<Record<string, number>>;
}

@Injectable()
export class BuildArchetypeMinerV2Service {
  mine(
    sourceProfiles: readonly StatlockerBuildProfileV2[],
    config: Partial<StatlockerBuildV2Config> = {},
  ): BuildArchetypeMiningResultV2 {
    if (sourceProfiles.length === 0) {
      return { accepted: [], rejected: [], pairwiseSimilarities: {} };
    }

    const resolved = resolveConfig(config);
    const profiles = validateAndSortProfiles(sourceProfiles);
    const heroId = profiles[0].heroId;
    const similarities = pairwiseSimilarities(profiles, resolved);
    const pairwiseRecord = Object.fromEntries([...similarities.entries()].sort(([a], [b]) => a.localeCompare(b)));

    if (profiles.length < resolved.minClusterSize) {
      return {
        heroId,
        accepted: [],
        rejected: [rejectedCluster(
          profiles,
          profiles,
          similarities,
          ['INSUFFICIENT_SOURCE_PROFILES'],
        )],
        pairwiseSimilarities: pairwiseRecord,
      };
    }

    const components = connectedComponents(profiles, similarities, resolved.profileLinkSimilarity);
    const preliminaryAccepted: StatlockerBuildProfileV2[][] = [];
    const rejected: RejectedBuildArchetypeClusterV2[] = [];

    for (const component of components) {
      const internalSimilarity = clusterInternalSimilarity(component, similarities);
      const reasons: BuildArchetypeClusterRejectionReasonV2[] = [];
      if (component.length < resolved.minClusterSize) reasons.push('CLUSTER_TOO_SMALL');
      if (component.length >= resolved.minClusterSize && internalSimilarity < resolved.minInternalSimilarity) {
        reasons.push('INSUFFICIENT_INTERNAL_SIMILARITY');
      }
      if (reasons.length > 0) {
        rejected.push(rejectedCluster(component, profiles, similarities, reasons, components));
      } else {
        preliminaryAccepted.push(component);
      }
    }

    if (preliminaryAccepted.length === 0) {
      const consensusSimilarity = clusterInternalSimilarity(profiles, similarities);
      if (consensusSimilarity >= resolved.minConsensusSimilarity) {
        return {
          heroId,
          accepted: [acceptedCluster(
            profiles,
            profiles,
            similarities,
            components,
            ['WEAK_SPLIT_COLLAPSED_TO_CONSENSUS'],
          )],
          rejected,
          pairwiseSimilarities: pairwiseRecord,
        };
      }
      return {
        heroId,
        accepted: [],
        rejected: sortRejected([
          ...rejected,
          rejectedCluster(profiles, profiles, similarities, ['NO_COHERENT_ARCHETYPE'], components),
        ]),
        pairwiseSimilarities: pairwiseRecord,
      };
    }

    if (preliminaryAccepted.length === 1) {
      const only = preliminaryAccepted[0];
      if (components.length === 1) {
        return {
          heroId,
          accepted: [acceptedCluster(only, profiles, similarities, components)],
          rejected,
          pairwiseSimilarities: pairwiseRecord,
        };
      }

      const consensusSimilarity = clusterInternalSimilarity(profiles, similarities);
      if (consensusSimilarity >= resolved.minConsensusSimilarity) {
        return {
          heroId,
          accepted: [acceptedCluster(
            profiles,
            profiles,
            similarities,
            components,
            ['WEAK_SPLIT_COLLAPSED_TO_CONSENSUS'],
          )],
          rejected,
          pairwiseSimilarities: pairwiseRecord,
        };
      }

      return {
        heroId,
        accepted: [acceptedCluster(only, profiles, similarities, components)],
        rejected: sortRejected(rejected),
        pairwiseSimilarities: pairwiseRecord,
      };
    }

    const separated: StatlockerBuildProfileV2[][] = [];
    for (const component of preliminaryAccepted) {
      const separation = clusterSeparation(component, preliminaryAccepted, similarities);
      if (separation < resolved.minClusterSeparation) {
        rejected.push(rejectedCluster(
          component,
          profiles,
          similarities,
          ['INSUFFICIENT_SEPARATION'],
          preliminaryAccepted,
        ));
      } else {
        separated.push(component);
      }
    }

    if (separated.length < 2) {
      const consensusSimilarity = clusterInternalSimilarity(profiles, similarities);
      if (consensusSimilarity >= resolved.minConsensusSimilarity) {
        return {
          heroId,
          accepted: [acceptedCluster(
            profiles,
            profiles,
            similarities,
            components,
            ['WEAK_SPLIT_COLLAPSED_TO_CONSENSUS'],
          )],
          rejected: sortRejected(rejected),
          pairwiseSimilarities: pairwiseRecord,
        };
      }
    }

    const ranked = [...separated].sort((left, right) =>
      right.length - left.length ||
      clusterInternalSimilarity(right, similarities) - clusterInternalSimilarity(left, similarities) ||
      firstAccountId(left).localeCompare(firstAccountId(right)),
    );
    const kept = ranked.slice(0, resolved.maxPublishedArchetypes);
    for (const component of ranked.slice(resolved.maxPublishedArchetypes)) {
      rejected.push(rejectedCluster(
        component,
        profiles,
        similarities,
        ['MAX_ARCHETYPES_EXCEEDED'],
        ranked,
      ));
    }

    const accepted = kept
      .map((component) => acceptedCluster(component, profiles, similarities, kept))
      .sort((left, right) =>
        right.profileAccountIds.length - left.profileAccountIds.length ||
        right.internalSimilarity - left.internalSimilarity ||
        left.profileAccountIds[0].localeCompare(right.profileAccountIds[0]),
      );

    return {
      heroId,
      accepted,
      rejected: sortRejected(rejected),
      pairwiseSimilarities: pairwiseRecord,
    };
  }
}

function resolveConfig(config: Partial<StatlockerBuildV2Config>): StatlockerBuildV2Config {
  const resolved: StatlockerBuildV2Config = {
    ...STATLOCKER_BUILD_V2_CONFIG,
    ...config,
    profileSimilarityWeights: {
      ...STATLOCKER_BUILD_V2_CONFIG.profileSimilarityWeights,
      ...(config.profileSimilarityWeights ?? {}),
    },
  };
  if (resolved.profileLinkSimilarity < 0 || resolved.profileLinkSimilarity > 1) {
    throw new Error('Build archetype v2: profileLinkSimilarity must be within [0, 1]');
  }
  if (!Number.isInteger(resolved.minClusterSize) || resolved.minClusterSize < 2) {
    throw new Error('Build archetype v2: minClusterSize must be an integer >= 2');
  }
  if (resolved.minInternalSimilarity < 0 || resolved.minInternalSimilarity > 1) {
    throw new Error('Build archetype v2: minInternalSimilarity must be within [0, 1]');
  }
  if (resolved.minConsensusSimilarity < 0 || resolved.minConsensusSimilarity > 1) {
    throw new Error('Build archetype v2: minConsensusSimilarity must be within [0, 1]');
  }
  if (resolved.minClusterSeparation < 0 || resolved.minClusterSeparation > 1) {
    throw new Error('Build archetype v2: minClusterSeparation must be within [0, 1]');
  }
  if (!Number.isInteger(resolved.maxPublishedArchetypes) || resolved.maxPublishedArchetypes < 1) {
    throw new Error('Build archetype v2: maxPublishedArchetypes must be an integer >= 1');
  }
  return resolved;
}

function validateAndSortProfiles(
  sourceProfiles: readonly StatlockerBuildProfileV2[],
): StatlockerBuildProfileV2[] {
  const profiles = [...sourceProfiles].sort((a, b) => a.accountId.localeCompare(b.accountId));
  const heroId = profiles[0].heroId;
  const accountIds = new Set<string>();
  for (const profile of profiles) {
    if (profile.heroId !== heroId) throw new Error('Build archetype v2: profiles must belong to one hero');
    if (profile.items.length === 0) throw new Error(`Build archetype v2: profile ${profile.accountId} has no items`);
    if (accountIds.has(profile.accountId)) {
      throw new Error(`Build archetype v2: duplicate profile account ${profile.accountId}`);
    }
    accountIds.add(profile.accountId);
  }
  return profiles;
}

function pairwiseSimilarities(
  profiles: readonly StatlockerBuildProfileV2[],
  config: StatlockerBuildV2Config,
): Map<string, number> {
  const result = new Map<string, number>();
  for (let leftIndex = 0; leftIndex < profiles.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < profiles.length; rightIndex += 1) {
      const left = profiles[leftIndex];
      const right = profiles[rightIndex];
      result.set(
        pairKey(left.accountId, right.accountId),
        compareBuildProfilesV2(left, right, config.profileSimilarityWeights).total,
      );
    }
  }
  return result;
}

function connectedComponents(
  profiles: readonly StatlockerBuildProfileV2[],
  similarities: ReadonlyMap<string, number>,
  linkSimilarity: number,
): StatlockerBuildProfileV2[][] {
  const byAccountId = new Map(profiles.map((profile) => [profile.accountId, profile]));
  const remaining = new Set(byAccountId.keys());
  const result: StatlockerBuildProfileV2[][] = [];

  while (remaining.size > 0) {
    const seed = [...remaining].sort()[0];
    remaining.delete(seed);
    const queue = [seed];
    const memberIds = [seed];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const candidate of [...remaining].sort()) {
        if ((similarities.get(pairKey(current, candidate)) ?? 0) < linkSimilarity) continue;
        remaining.delete(candidate);
        queue.push(candidate);
        memberIds.push(candidate);
      }
    }
    result.push(memberIds.sort().map((accountId) => byAccountId.get(accountId)!));
  }

  return result.sort((left, right) => firstAccountId(left).localeCompare(firstAccountId(right)));
}

function acceptedCluster(
  members: readonly StatlockerBuildProfileV2[],
  allProfiles: readonly StatlockerBuildProfileV2[],
  similarities: ReadonlyMap<string, number>,
  comparisonClusters: readonly (readonly StatlockerBuildProfileV2[])[],
  reasonCodes: readonly string[] = [],
): BuildArchetypeClusterV2 {
  const accountIds = members.map((profile) => profile.accountId).sort();
  return {
    clusterId: clusterId(members[0].heroId, accountIds),
    heroId: members[0].heroId,
    profileAccountIds: accountIds,
    support: members.length / allProfiles.length,
    internalSimilarity: clusterInternalSimilarity(members, similarities),
    separation: clusterSeparation(members, comparisonClusters, similarities),
    reasonCodes: [...reasonCodes],
  };
}

function rejectedCluster(
  members: readonly StatlockerBuildProfileV2[],
  allProfiles: readonly StatlockerBuildProfileV2[],
  similarities: ReadonlyMap<string, number>,
  reasonCodes: readonly BuildArchetypeClusterRejectionReasonV2[],
  comparisonClusters: readonly (readonly StatlockerBuildProfileV2[])[] = [members],
): RejectedBuildArchetypeClusterV2 {
  const accountIds = members.map((profile) => profile.accountId).sort();
  return {
    clusterId: clusterId(members[0].heroId, accountIds),
    heroId: members[0].heroId,
    profileAccountIds: accountIds,
    support: members.length / allProfiles.length,
    internalSimilarity: clusterInternalSimilarity(members, similarities),
    separation: clusterSeparation(members, comparisonClusters, similarities),
    reasonCodes: [...reasonCodes],
  };
}

function clusterInternalSimilarity(
  members: readonly StatlockerBuildProfileV2[],
  similarities: ReadonlyMap<string, number>,
): number {
  if (members.length <= 1) return 1;
  const values: number[] = [];
  for (let leftIndex = 0; leftIndex < members.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < members.length; rightIndex += 1) {
      values.push(similarities.get(pairKey(members[leftIndex].accountId, members[rightIndex].accountId)) ?? 0);
    }
  }
  return mean(values);
}

function clusterSeparation(
  members: readonly StatlockerBuildProfileV2[],
  clusters: readonly (readonly StatlockerBuildProfileV2[])[],
  similarities: ReadonlyMap<string, number>,
): number {
  const memberIds = new Set(members.map((profile) => profile.accountId));
  let maximumCrossSimilarity: number | undefined;
  for (const other of clusters) {
    if (other.some((profile) => memberIds.has(profile.accountId))) continue;
    for (const left of members) {
      for (const right of other) {
        const similarity = similarities.get(pairKey(left.accountId, right.accountId)) ?? 0;
        maximumCrossSimilarity = maximumCrossSimilarity === undefined
          ? similarity
          : Math.max(maximumCrossSimilarity, similarity);
      }
    }
  }
  return maximumCrossSimilarity === undefined ? 0 : 1 - maximumCrossSimilarity;
}

function sortRejected(
  rejected: readonly RejectedBuildArchetypeClusterV2[],
): RejectedBuildArchetypeClusterV2[] {
  return [...rejected].sort((left, right) =>
    right.profileAccountIds.length - left.profileAccountIds.length ||
    left.profileAccountIds[0].localeCompare(right.profileAccountIds[0]),
  );
}

function pairKey(left: string, right: string): string {
  return left < right ? `${left}\u0000${right}` : `${right}\u0000${left}`;
}

function clusterId(heroId: number, accountIds: readonly string[]): string {
  const signature = createHash('sha256').update([...accountIds].sort().join('\n')).digest('hex').slice(0, 16);
  return `hero:${heroId}:cluster:${signature}`;
}

function firstAccountId(profiles: readonly StatlockerBuildProfileV2[]): string {
  return profiles.map((profile) => profile.accountId).sort()[0];
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}
