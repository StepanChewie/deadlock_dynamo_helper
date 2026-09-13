import { Injectable } from '@nestjs/common';

import { StatlockerHeroItemLifecycleV1 } from './statlocker-adaptive.types';

export interface FullBuildSellCandidateV1 {
  itemId: number;
  generalWpa: number;
  averagePurchaseTimeS: number;
}

export interface RankedFullBuildSellCandidateV1 extends FullBuildSellCandidateV1 {
  paretoFront: number;
  timeSellPercentile: number;
  wpaSellPercentile: number;
  tieBreakScore: number;
}

/** First and last ascending-sort index of one raw coordinate value. */
interface CoordinateValueBlockV1 {
  firstIndex: number;
  lastIndex: number;
}

/**
 * Builds a deterministic total order over lifecycle sell candidates by
 * iteratively peeling Pareto fronts: front 0 holds the non-dominated
 * most-sellable candidates, and lower front numbers always rank first.
 * Dominance prefers earlier purchases and lower WPA; inside one front the
 * 50/50 blend of distribution-relative sell percentiles breaks ties, then
 * the item id. Percentiles always use the full verified hero distribution
 * rather than only the held candidates, and lower raw coordinate values are
 * more sellable on both axes. Pure: no inventory-capacity, matchup, or
 * repository dependency.
 */
@Injectable()
export class FullBuildSellRankerV1Service {
  rank(
    candidates: readonly FullBuildSellCandidateV1[],
    heroDistribution: readonly StatlockerHeroItemLifecycleV1[],
  ): readonly RankedFullBuildSellCandidateV1[] {
    // Item ids are unique in well-formed input; if duplicates slip in, drop
    // later occurrences and keep the first so the order stays deterministic.
    const seenItemIds = new Set<number>();
    const uniqueCandidates: FullBuildSellCandidateV1[] = [];
    for (const candidate of candidates) {
      if (seenItemIds.has(candidate.itemId)) continue;
      seenItemIds.add(candidate.itemId);
      uniqueCandidates.push(candidate);
    }

    const timeBlocks = this.buildCoordinateValueBlocks(
      heroDistribution.map((row) => row.averagePurchaseTimeS),
    );
    const wpaBlocks = this.buildCoordinateValueBlocks(
      heroDistribution.map((row) => row.generalWpa),
    );

    const ranked: RankedFullBuildSellCandidateV1[] = [];
    let remaining = uniqueCandidates;
    let front = 0;

    while (remaining.length > 0) {
      const dominated = new Set<FullBuildSellCandidateV1>();
      for (const target of remaining) {
        for (const other of remaining) {
          if (other === target) continue;
          if (this.dominates(other, target)) {
            dominated.add(target);
            break;
          }
        }
      }

      const frontCandidates = remaining.filter(
        (candidate) => !dominated.has(candidate),
      );
      const frontSet = new Set(frontCandidates);
      remaining = remaining.filter((candidate) => !frontSet.has(candidate));

      const rankedFront = frontCandidates
        .map((candidate) => {
          const timeSellPercentile = this.sellPercentile(
            timeBlocks,
            candidate.averagePurchaseTimeS,
            heroDistribution.length,
          );
          const wpaSellPercentile = this.sellPercentile(
            wpaBlocks,
            candidate.generalWpa,
            heroDistribution.length,
          );
          return {
            ...candidate,
            paretoFront: front,
            timeSellPercentile,
            wpaSellPercentile,
            tieBreakScore: 0.5 * timeSellPercentile + 0.5 * wpaSellPercentile,
          };
        })
        .sort(
          (a, b) => b.tieBreakScore - a.tieBreakScore || a.itemId - b.itemId,
        );

      ranked.push(...rankedFront);
      front += 1;
    }

    return ranked;
  }

  /**
   * True when A is no later and no higher-WPA than B with at least one
   * strict comparison, so A is strictly more sellable on the Pareto front.
   */
  private dominates(
    a: FullBuildSellCandidateV1,
    b: FullBuildSellCandidateV1,
  ): boolean {
    const timeDominates = a.averagePurchaseTimeS <= b.averagePurchaseTimeS;
    const wpaDominates = a.generalWpa <= b.generalWpa;
    const strictlyBetter =
      a.averagePurchaseTimeS < b.averagePurchaseTimeS ||
      a.generalWpa < b.generalWpa;
    return timeDominates && wpaDominates && strictlyBetter;
  }

  /** Indexes the ascending-sorted coordinate vector by raw value. */
  private buildCoordinateValueBlocks(
    values: readonly number[],
  ): Map<number, CoordinateValueBlockV1> {
    const sorted = [...values].sort((a, b) => a - b);
    const blocks = new Map<number, CoordinateValueBlockV1>();
    sorted.forEach((value, index) => {
      const block = blocks.get(value);
      if (block) {
        block.lastIndex = index;
      } else {
        blocks.set(value, { firstIndex: index, lastIndex: index });
      }
    });
    return blocks;
  }

  /**
   * Tie-aware sell percentile for one raw coordinate value against the full
   * hero distribution: equal raw values share the midrank of their block, so
   * the lowest observation is 1 and the highest is 0.
   */
  private sellPercentile(
    blocks: Map<number, CoordinateValueBlockV1>,
    value: number,
    distributionLength: number,
  ): number {
    if (distributionLength <= 1) return 0.5;
    const block = blocks.get(value);
    // A candidate coordinate missing from the hero distribution has no
    // distribution rank, so it receives the neutral mid-point percentile 0.5.
    if (!block) return 0.5;
    const midrank = (block.firstIndex + block.lastIndex) / 2;
    return 1 - midrank / (distributionLength - 1);
  }
}
