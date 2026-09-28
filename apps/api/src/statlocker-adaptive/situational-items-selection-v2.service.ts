import { Injectable } from '@nestjs/common';
import { RecommendationItemGraph } from '@dynamo-lab/build-domain';
import { BuildArchetypeV2 } from './build-archetype-v2';
import { STATLOCKER_BUILD_V2_CONFIG } from './statlocker-build-v2.config';
import { StatlockerVsHeroWpaAggregateSourceV1 } from './statlocker-vs-hero-wpa-repository-v1.service';
import {
  EnemyThreatWeightV1,
  ThreatWeightedMatchupV1Service,
} from './threat-weighted-matchup-v1.service';

export const SITUATIONAL_ITEM_LIMIT_V2 = 5;
export const SITUATIONAL_AGAINST_LIMIT_V2 = 3;

export interface SituationalSelectionInputV2 {
  heroId: number;
  rulesetId: string;
  archetype: BuildArchetypeV2;
  itemGraph: RecommendationItemGraph;
  ownedItemIds: readonly number[];
  enemyHeroIds: readonly number[];
  enemyThreats: readonly EnemyThreatWeightV1[];
  vsHeroRows: readonly StatlockerVsHeroWpaAggregateSourceV1[];
}

export interface SituationalTargetV2 {
  enemyHeroId: number;
  deltaWpa: number;
  count: number;
}

export interface SituationalCandidateV2 {
  itemId: number;
  score: number;
  confidence: number;
  coverage: number;
  against: readonly SituationalTargetV2[];
}

/**
 * Ranks the items that are best against *this* enemy team.
 *
 * Deliberately not `BuildItemUtilityV2Service`. Its `structure` layer rewards an
 * item for being core, and this list exists to exclude core items; its
 * `transition` layer measures replacing something in a prescribed build, and
 * this mode has no prescribed build. `baseWpa` is excluded for the reason the
 * mode exists at all: an item has to earn its place by being good against these
 * enemies, not by being generally strong on the hero.
 *
 * The gate is the existing `outsideMatchupDiscovery` coverage and support
 * thresholds, reused from config rather than re-derived, **minus its confidence
 * floor** — see the comment at the gate for the measurement that forced that.
 * `minNormalizedSupport` being 0 is what enforces "must help against them".
 */
@Injectable()
export class SituationalItemsSelectionV2Service {
  constructor(private readonly matchup: ThreatWeightedMatchupV1Service) {}

  select(input: SituationalSelectionInputV2): readonly SituationalCandidateV2[] {
    const config = STATLOCKER_BUILD_V2_CONFIG.outsideMatchupDiscovery;
    const coreItemIds = new Set(
      input.archetype.items
        .filter((item) => item.role === 'CORE')
        .map((item) => item.itemId),
    );
    const owned = new Set(input.ownedItemIds);

    const scored: { candidate: SituationalCandidateV2 }[] = [];

    for (const item of input.itemGraph.getAllItems()) {
      if (!item.active) continue;
      if (!item.availableRulesetIds.includes(input.rulesetId)) continue;
      if (owned.has(item.itemId)) continue;
      if (coreItemIds.has(item.itemId)) continue;

      const score = this.matchup.scoreItem({
        ourHeroId: input.heroId,
        itemId: item.itemId,
        enemyHeroIds: input.enemyHeroIds,
        rows: input.vsHeroRows,
        enemyThreats: input.enemyThreats,
      });
      // Coverage and a positive score, but deliberately **no confidence floor**.
      //
      // That floor was inherited from `discover()`, where it guards replacing an
      // item inside a prescribed build — a decision with real consequences and a
      // bar to match. Ranking the whole catalog is a different job and the bar
      // does not transfer. Measured against the real dataset the median
      // (hero, item, enemy) sample is 31 games, so `sampleConfidence` is ~0.06
      // and an item's confidence lands near 0.06 against a threshold of 0.35.
      // Even giving every item its six *best*-sampled enemies — an upper bound
      // no real roster can reach — only 10 of 81 items cleared it. The result
      // was an empty selection and `SITUATIONAL_EVIDENCE_UNAVAILABLE` for every
      // real match, which is exactly what the mode showed in testing.
      //
      // Thin evidence is already handled where it belongs: `sampleConfidence`
      // shrinks `normalized`, so a 31-game row scores an order of magnitude
      // below a 700-game one and cannot outrank it. The gate's remaining job is
      // to drop items with no evidence at all, which the two checks below do.
      if (score.coverage < config.minCoverage) continue;
      if (score.normalized <= config.minNormalizedSupport) continue;

      scored.push({
        candidate: {
          itemId: item.itemId,
          score: score.normalized,
          confidence: score.confidence,
          coverage: score.coverage,
          against: againstFor(score.contributions),
        },
      });
    }

    return scored
      .sort((a, b) =>
        b.candidate.score - a.candidate.score ||
        b.candidate.confidence - a.candidate.confidence ||
        b.candidate.coverage - a.candidate.coverage ||
        a.candidate.itemId - b.candidate.itemId)
      .slice(0, SITUATIONAL_ITEM_LIMIT_V2)
      .map((entry) => entry.candidate);
  }
}

function againstFor(
  contributions: readonly {
    enemyHeroId: number;
    rawDeltaWpa: number;
    count: number;
    weightedContribution: number;
  }[],
): readonly SituationalTargetV2[] {
  return contributions
    .filter((entry) => entry.weightedContribution > 0)
    .sort((a, b) =>
      b.weightedContribution - a.weightedContribution || a.enemyHeroId - b.enemyHeroId)
    .slice(0, SITUATIONAL_AGAINST_LIMIT_V2)
    .map((entry) => ({
      enemyHeroId: entry.enemyHeroId,
      deltaWpa: entry.rawDeltaWpa,
      count: entry.count,
    }));
}
