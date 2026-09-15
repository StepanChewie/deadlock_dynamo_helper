import { Injectable, Optional } from '@nestjs/common';
import { RecommendationItemGraph } from '@dynamo-lab/build-domain';
import {
  ADAPTIVE_INVESTMENT_TYPES_V1,
  investmentItemValueV1,
} from './adaptive-economy-v1';
import {
  BuildArchetypeFamilyV2,
  BuildArchetypeV2,
  BuildObservedProgressionEdgeV2,
} from './build-archetype-v2';
import { DesiredFamilyStateV2 } from './build-desired-state-v2.service';
import { EnemyThreatScoreV1 } from './enemy-threat-v1.service';
import { FullBuildMatchupProtectionV1Service } from './full-build-matchup-protection-v1.service';
import { FullBuildSellRankerV1Service } from './full-build-sell-ranker-v1.service';
import {
  FullBuildTransitionValueV2Service,
  replacementImprovementThreshold,
} from './full-build-transition-value-v2.service';
import {
  StatlockerHeroItemLifecycleV1,
  StatlockerT4ChainsV1,
  StatlockerWpaPatchDataV1,
} from './statlocker-adaptive.types';
import { StatlockerBuildV2Config, STATLOCKER_BUILD_V2_CONFIG } from './statlocker-build-v2.config';
import { StatlockerVsHeroWpaAggregateSourceV1 } from './statlocker-vs-hero-wpa-repository-v1.service';

export interface FullBuildReplacementContextV2 {
  heroId: number;
  gameTimeSec: number;
  enemyHeroIds: readonly number[];
  enemyThreats: readonly EnemyThreatScoreV1[];
  vsHeroRows: readonly StatlockerVsHeroWpaAggregateSourceV1[];
  wpaPatchData?: StatlockerWpaPatchDataV1;
  t4Chains?: StatlockerT4ChainsV1;
  /** Verified per-hero Statlocker lifecycle rows (the brief's StatlockerItemLifecycleEvidenceV1). */
  lifecycleEvidence: readonly StatlockerHeroItemLifecycleV1[];
}

export interface FullBuildReplacementV2Input {
  archetype: BuildArchetypeV2;
  desiredFamily: DesiredFamilyStateV2;
  buyItemId: number;
  projectedInventoryItemIds: readonly number[];
  activeProgressionProtectedItemIds: ReadonlySet<number>;
  itemGraph: RecommendationItemGraph;
  rulesetId: string;
  context: FullBuildReplacementContextV2;
}

export type FullBuildReplacementV2Result =
  | {
      kind: 'REPLACE';
      sellItemId: number;
      reasonCodes: readonly string[];
    }
  | {
      kind: 'BLOCKED';
      reasonCodes: readonly string[];
    };

interface RankedSellCandidateV2 {
  itemId: number;
  generalWpa: number;
  averagePurchaseTimeS: number;
}

const ITEM_META_EVIDENCE_MISSING = 'ITEM_META_EVIDENCE_MISSING';
const SELL_CANDIDATE_LIFECYCLE_MISSING = 'SELL_CANDIDATE_LIFECYCLE_MISSING';
const REPLACEMENT_GAIN_BELOW_THRESHOLD = 'REPLACEMENT_GAIN_BELOW_THRESHOLD';
const REPLACEMENT_CONFIDENCE_BELOW_MINIMUM = 'REPLACEMENT_CONFIDENCE_BELOW_MINIMUM';

/**
 * Decides which held item a new-slot BUY must replace once the planner has
 * established a full inventory. It never decides when replacement begins.
 * The decision runs the exact brief order: held items, minus active-progression
 * protection, minus dependencies of the executed target progression (no
 * catalog sellability filter until a verified sellability fact exists), minus
 * team matchup protection, joined to verified lifecycle evidence, gated by the
 * incoming goal kind over the exact REPLACE simulation, then Pareto-ranked on
 * the full hero lifecycle distribution. Historical REQUIRED status of a held
 * item is not permanent protection: only the caller-supplied active-progression
 * set, confirmed progression dependencies, and matchup evidence protect.
 */
@Injectable()
export class FullBuildReplacementV2Service {
  constructor(
    private readonly transitionValue: FullBuildTransitionValueV2Service,
    private readonly matchupProtection: FullBuildMatchupProtectionV1Service,
    private readonly sellRanker: FullBuildSellRankerV1Service,
    @Optional() private readonly config: StatlockerBuildV2Config = STATLOCKER_BUILD_V2_CONFIG,
  ) {}

  decide(input: FullBuildReplacementV2Input): FullBuildReplacementV2Result {
    const config = this.config ?? STATLOCKER_BUILD_V2_CONFIG;
    const diagnostics: string[] = [];

    // Steps 1-3: held items, minus active-progression protection, minus
    // held dependencies of the target progression being executed.
    const dependencies = progressionDependencyItemIds(
      resolveDesiredFamily(input.archetype, input.desiredFamily)?.progressionEdges ?? [],
      input.buyItemId,
    );
    const candidates = dedupeItemIds(input.projectedInventoryItemIds)
      .filter((itemId) => !input.activeProgressionProtectedItemIds.has(itemId))
      .filter((itemId) => !dependencies.has(itemId))
      .filter((itemId) => {
        // Hard invest guard: a sale that would drop an already-closed invest
        // track below the breakpoint is forbidden unless the same-step buy
        // restores the track. Sold items may still exit through an
        // invest-neutral REPLACE.
        const closed = investTracksAtOrAboveBreakpoint(
          input.projectedInventoryItemIds,
          input.itemGraph,
          config.investBreakpointSouls,
        );
        if (closed.size === 0) return true;
        const resulting = replaceItemId(input.projectedInventoryItemIds, itemId, input.buyItemId);
        const after = investTracksAtOrAboveBreakpoint(resulting, input.itemGraph, config.investBreakpointSouls);
        const breaks = [...closed].some((slotType) => !after.has(slotType));
        if (breaks) diagnostics.push('INVEST_PROTECTED');
        return !breaks;
      });

    // Step 5: team matchup protection. Only protected=true removes a
    // candidate; missing rows never protect, and all diagnostics are retained.
    const protectedItemIds = new Set<number>();
    for (const itemId of candidates) {
      const protection = this.matchupProtection.evaluate(
        {
          ourHeroId: input.context.heroId,
          itemId,
          enemyHeroIds: input.context.enemyHeroIds,
          rows: input.context.vsHeroRows,
        },
        config.sellMatchupProtection,
      );
      for (const code of protection.reasonCodes) {
        if (!diagnostics.includes(code)) diagnostics.push(code);
      }
      if (protection.protected) protectedItemIds.add(itemId);
    }
    const unprotected = candidates.filter((itemId) => !protectedItemIds.has(itemId));

    // Step 6: join the remaining candidates to verified lifecycle evidence for
    // this hero. Without evidence a candidate has no sell coordinates and is
    // ineligible for ranking.
    const heroEvidence = input.context.lifecycleEvidence.filter(
      (row) => row.heroId === input.context.heroId,
    );
    const evidenceByItemId = new Map(heroEvidence.map((row) => [row.itemId, row]));
    const rankable: RankedSellCandidateV2[] = [];
    let lifecycleMissing = false;
    for (const itemId of unprotected) {
      const row = evidenceByItemId.get(itemId);
      if (!row) {
        lifecycleMissing = true;
        continue;
      }
      rankable.push({
        itemId,
        generalWpa: row.generalWpa,
        averagePurchaseTimeS: row.averagePurchaseTimeS,
      });
    }
    if (rankable.length === 0) {
      // No surviving candidate carries lifecycle evidence, so no REPLACE pair
      // can be simulated or ranked.
      return { kind: 'BLOCKED', reasonCodes: [ITEM_META_EVIDENCE_MISSING, ...diagnostics] };
    }

    // Steps 7-9: simulate the exact REPLACE result per candidate and gate by
    // the incoming goal kind. REQUIRED and selected CHOICE goals accept any
    // non-negative marginal gain; OPTIONAL and SITUATIONAL goals must clear
    // the sold-role improvement threshold and the configured confidence
    // minimum. Neither path bypasses the step 2-5 hard protections.
    const bypassGainThreshold =
      input.desiredFamily.goalKind === 'REQUIRED' ||
      input.desiredFamily.goalKind === 'CHOICE_SELECTED';
    const minConfidence = config.outsideMatchupDiscovery.replacementMinConfidence;
    const survivors: RankedSellCandidateV2[] = [];
    let gainBelowThreshold = false;
    let confidenceBelowMinimum = false;
    for (const candidate of rankable) {
      const evaluation = this.transitionValue.evaluate({
        heroId: input.context.heroId,
        archetype: input.archetype,
        itemGraph: input.itemGraph,
        gameTimeSec: input.context.gameTimeSec,
        currentInventoryItemIds: input.projectedInventoryItemIds,
        resultingInventoryItemIds: replaceItemId(
          input.projectedInventoryItemIds,
          candidate.itemId,
          input.buyItemId,
        ),
        targetItemId: input.buyItemId,
        enemyHeroIds: input.context.enemyHeroIds,
        enemyThreats: input.context.enemyThreats,
        vsHeroRows: input.context.vsHeroRows,
        ...(input.context.wpaPatchData === undefined ? {} : { wpaPatchData: input.context.wpaPatchData }),
        ...(input.context.t4Chains === undefined ? {} : { t4Chains: input.context.t4Chains }),
      });
      const soldRole = input.archetype.items.find(
        (item) => item.itemId === candidate.itemId,
      )?.role;
      if (bypassGainThreshold) {
        if (evaluation.marginalGain < 0) {
          gainBelowThreshold = true;
          continue;
        }
      } else {
        if (evaluation.marginalGain < replacementImprovementThreshold(soldRole)) {
          gainBelowThreshold = true;
          continue;
        }
        if (evaluation.confidence < minConfidence) {
          confidenceBelowMinimum = true;
          continue;
        }
      }
      survivors.push(candidate);
    }

    if (survivors.length === 0) {
      const gateCodes: string[] = [];
      if (gainBelowThreshold) gateCodes.push(REPLACEMENT_GAIN_BELOW_THRESHOLD);
      if (confidenceBelowMinimum) gateCodes.push(REPLACEMENT_CONFIDENCE_BELOW_MINIMUM);
      return {
        kind: 'BLOCKED',
        reasonCodes: [...gateCodes, ...diagnostics, ...(lifecycleMissing ? [SELL_CANDIDATE_LIFECYCLE_MISSING] : [])],
      };
    }

    // Step 10: Pareto-rank the survivors against the full hero lifecycle
    // distribution; the first ranked entry is the pick.
    const ranked = this.sellRanker.rank(survivors, heroEvidence);
    const pick = ranked[0];
    const reasonCodes = [...diagnostics];
    if (lifecycleMissing) reasonCodes.push(SELL_CANDIDATE_LIFECYCLE_MISSING);
    return { kind: 'REPLACE', sellItemId: pick.itemId, reasonCodes };
  }
}

function resolveDesiredFamily(
  archetype: BuildArchetypeV2,
  desiredFamily: DesiredFamilyStateV2,
): BuildArchetypeFamilyV2 | undefined {
  return archetype.families?.find((family) => family.familyId === desiredFamily.familyId);
}

/**
 * Held items that are progression ancestors of the buy target inside the
 * executed family's confirmed edges: a held from-item leading toward the buy
 * target is still needed by the pending confirmed upgrade.
 */
function progressionDependencyItemIds(
  edges: readonly BuildObservedProgressionEdgeV2[],
  buyItemId: number,
): ReadonlySet<number> {
  const dependencies = new Set<number>();
  const visited = new Set<number>([buyItemId]);
  const pending = [buyItemId];
  while (pending.length > 0) {
    const current = pending.shift()!;
    for (const edge of edges) {
      if (edge.toItemId !== current || visited.has(edge.fromItemId)) continue;
      visited.add(edge.fromItemId);
      dependencies.add(edge.fromItemId);
      pending.push(edge.fromItemId);
    }
  }
  return dependencies;
}

function dedupeItemIds(itemIds: readonly number[]): number[] {
  return [...new Set(itemIds)];
}

/** Exact REPLACE projection: the sell item is swapped for the buy item in place. */
function replaceItemId(
  inventoryItemIds: readonly number[],
  sellItemId: number,
  buyItemId: number,
): number[] {
  const result = [...inventoryItemIds];
  const index = result.indexOf(sellItemId);
  if (index >= 0) result[index] = buyItemId;
  else result.push(buyItemId);
  return result;
}

/** Tracks whose invested souls already reach the invest breakpoint. */
function investTracksAtOrAboveBreakpoint(
  inventoryItemIds: readonly number[],
  itemGraph: RecommendationItemGraph,
  breakpointSouls: number,
): Set<'weapon' | 'vitality' | 'spirit'> {
  const totals: Record<'weapon' | 'vitality' | 'spirit', number> = { weapon: 0, vitality: 0, spirit: 0 };
  for (const itemId of inventoryItemIds) {
    const item = itemGraph.getItem(itemId);
    if (!item) continue;
    totals[item.slotType] += investmentItemValueV1(itemId, itemGraph);
  }
  const closed = new Set<'weapon' | 'vitality' | 'spirit'>();
  for (const track of ADAPTIVE_INVESTMENT_TYPES_V1) {
    if (totals[track] >= breakpointSouls) closed.add(track);
  }
  return closed;
}
