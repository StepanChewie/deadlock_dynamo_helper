import { Injectable } from '@nestjs/common';
import {
  RecommendationCandidate,
  RecommendationItemGraph,
} from '@dynamo-lab/build-domain';
import {
  BuildArchetypeRoleV2,
  BuildArchetypeV2,
} from './build-archetype-v2';
import {
  BuildItemUtilityV2,
  BuildItemUtilityV2Service,
} from './build-item-utility-v2.service';
import { EnemyThreatScoreV1 } from './enemy-threat-v1.service';
import {
  StatlockerT4ChainsV1,
  StatlockerWpaPatchDataV1,
} from './statlocker-adaptive.types';
import { STATLOCKER_BUILD_V2_CONFIG } from './statlocker-build-v2.config';
import { StatlockerVsHeroWpaAggregateSourceV1 } from './statlocker-vs-hero-wpa-repository-v1.service';
import {
  ThreatWeightedMatchupScoreV1,
  ThreatWeightedMatchupV1Service,
} from './threat-weighted-matchup-v1.service';

export interface MatchupCandidateDiscoveryV2Input {
  heroId: number;
  archetype: BuildArchetypeV2;
  legalByTarget: ReadonlyMap<number, RecommendationCandidate>;
  itemGraph: RecommendationItemGraph;
  gameTimeSec: number;
  ownedItemIds: readonly number[];
  projectedItemIds: readonly number[];
  enemyHeroIds: readonly number[];
  enemyThreats: readonly EnemyThreatScoreV1[];
  vsHeroRows: readonly StatlockerVsHeroWpaAggregateSourceV1[];
  wpaPatchData?: StatlockerWpaPatchDataV1;
  t4Chains?: StatlockerT4ChainsV1;
}

export interface MatchupCandidateV2 {
  targetItemId: number;
  source: 'STATLOCKER_VS_HERO_WPA';
  candidate: RecommendationCandidate;
  matchup: ThreatWeightedMatchupScoreV1;
  utility: BuildItemUtilityV2;
  replacement: boolean;
  requiredImprovement: number;
  sellItemId?: number;
  reasonCodes: readonly string[];
}

@Injectable()
export class MatchupCandidateDiscoveryV2Service {
  constructor(
    private readonly itemUtility: BuildItemUtilityV2Service,
    private readonly matchup: ThreatWeightedMatchupV1Service,
  ) {}

  discover(input: MatchupCandidateDiscoveryV2Input): readonly MatchupCandidateV2[] {
    validateInput(input);
    if (input.enemyHeroIds.length === 0 || input.legalByTarget.size === 0) return [];

    const config = STATLOCKER_BUILD_V2_CONFIG.outsideMatchupDiscovery;
    const archetypeSemanticItemIds = semanticArchetypeItemIds(input.archetype, input.itemGraph);
    const results: MatchupCandidateV2[] = [];

    for (const targetItemId of [...input.legalByTarget.keys()].sort((a, b) => a - b)) {
      if (archetypeSemanticItemIds.has(targetItemId)) continue;
      if (!input.itemGraph.getItem(targetItemId)) continue;

      const candidate = input.legalByTarget.get(targetItemId);
      if (!candidate || !candidate.feasible || !candidate.recommendationEligible) continue;
      if (candidate.evidence.transaction === 'UNKNOWN') continue;

      const replacementAction = candidate.action.type === 'REPLACE_ITEM'
        ? candidate.action
        : undefined;
      const replacement = replacementAction !== undefined;
      const matchup = this.matchup.scoreItem({
        ourHeroId: input.heroId,
        itemId: targetItemId,
        enemyHeroIds: input.enemyHeroIds,
        rows: input.vsHeroRows,
        enemyThreats: input.enemyThreats.map((enemy) => ({
          heroId: enemy.heroId,
          threatMultiplier: enemy.threatMultiplier,
        })),
      });
      const minimumConfidence = replacement
        ? config.replacementMinConfidence
        : config.minConfidence;
      if (
        matchup.coverage < config.minCoverage ||
        matchup.confidence < minimumConfidence ||
        matchup.normalized <= config.minNormalizedSupport
      ) continue;

      const utility = this.itemUtility.scoreItem({
        heroId: input.heroId,
        itemId: targetItemId,
        archetype: input.archetype,
        gameTimeSec: input.gameTimeSec,
        ownedItemIds: input.ownedItemIds,
        projectedItemIds: input.projectedItemIds,
        enemyHeroIds: input.enemyHeroIds,
        enemyThreats: input.enemyThreats,
        vsHeroRows: input.vsHeroRows,
        wpaPatchData: input.wpaPatchData,
        t4Chains: input.t4Chains,
      });

      const soldRole = replacementAction
        ? archetypeRoleForItem(replacementAction.sellItemId, input.archetype, input.itemGraph)
        : undefined;
      const requiredImprovement = replacement
        ? soldRole === 'CORE'
          ? config.coreReplacementMinImprovement
          : config.replacementMinImprovement
        : config.buyMinImprovement;
      const reasonCodes = [
        'MATCHUP_DISCOVERY_OUTSIDE_ARCHETYPE',
        'MATCHUP_DISCOVERY_STATLOCKER_VS_HERO_WPA',
        ...(replacement ? ['MATCHUP_DISCOVERY_REPLACEMENT'] : []),
        ...(soldRole === 'CORE' ? ['MATCHUP_DISCOVERY_CORE_REPLACEMENT'] : []),
      ];

      results.push({
        targetItemId,
        source: 'STATLOCKER_VS_HERO_WPA',
        candidate,
        matchup,
        utility,
        replacement,
        requiredImprovement,
        ...(replacementAction ? { sellItemId: replacementAction.sellItemId } : {}),
        reasonCodes,
      });
    }

    return results.sort((left, right) =>
      right.utility.total - left.utility.total ||
      right.matchup.confidence - left.matchup.confidence ||
      right.matchup.coverage - left.matchup.coverage ||
      left.targetItemId - right.targetItemId,
    );
  }
}

function semanticArchetypeItemIds(
  archetype: BuildArchetypeV2,
  itemGraph: RecommendationItemGraph,
): Set<number> {
  const itemIds = new Set<number>();
  const addSemanticItem = (itemId: number): void => {
    itemIds.add(itemId);
    for (const componentId of itemGraph.getTransitiveComponentIds(itemId)) itemIds.add(componentId);
    for (const upgradeId of itemGraph.getTransitiveUpgradeIds(itemId)) itemIds.add(upgradeId);
  };

  for (const family of archetype.families ?? []) {
    for (const node of family.progressionNodes) addSemanticItem(node.itemId);
    for (const terminal of family.terminalCandidates) addSemanticItem(terminal.itemId);
  }
  for (const item of archetype.items) addSemanticItem(item.itemId);
  return itemIds;
}

function archetypeRoleForItem(
  itemId: number,
  archetype: BuildArchetypeV2,
  itemGraph: RecommendationItemGraph,
): BuildArchetypeRoleV2 | undefined {
  for (const family of archetype.families ?? []) {
    const familyItemIds = [
      ...family.progressionNodes.map((node) => node.itemId),
      ...family.terminalCandidates.map((terminal) => terminal.itemId),
    ];
    for (const familyItemId of familyItemIds) {
      if (
        familyItemId === itemId ||
        itemGraph.getTransitiveComponentIds(familyItemId).includes(itemId) ||
        itemGraph.getTransitiveUpgradeIds(familyItemId).includes(itemId)
      ) {
        if (family.requirement === 'REQUIRED') return 'CORE';
        if (family.requirement === 'SITUATIONAL') return 'SITUATIONAL';
        return 'FLEX';
      }
    }
  }
  for (const item of archetype.items) {
    if (item.itemId === itemId) return item.role;
    if (itemGraph.getTransitiveComponentIds(item.itemId).includes(itemId)) return item.role;
    if (itemGraph.getTransitiveUpgradeIds(item.itemId).includes(itemId)) return item.role;
  }
  return undefined;
}

function validateInput(input: MatchupCandidateDiscoveryV2Input): void {
  if (!Number.isInteger(input.heroId) || input.heroId <= 0) {
    throw new Error('Matchup candidate discovery v2: heroId must be a positive integer');
  }
  if (input.archetype.heroId !== input.heroId) {
    throw new Error('Matchup candidate discovery v2: archetype hero identity mismatch');
  }
  if (!Number.isFinite(input.gameTimeSec) || input.gameTimeSec < 0) {
    throw new Error('Matchup candidate discovery v2: gameTimeSec must be non-negative');
  }
}