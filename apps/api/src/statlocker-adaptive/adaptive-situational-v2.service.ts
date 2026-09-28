import { Injectable } from '@nestjs/common';
import {
  AdaptiveRecommendationRequestV2,
  AdaptiveSituationalItemV2,
  AdaptiveSituationalResultV2,
} from '@dynamo-lab/shared';
import {
  AdaptiveDecisionStateV1,
} from './adaptive-decision-state-v1.service';
import {
  AdaptiveRecommendationV2Service,
  lockSummary,
} from './adaptive-recommendation-v2.service';
import { EnemyThreatV1Service } from './enemy-threat-v1.service';
import { ConsensusSkeletonV1 } from './statlocker-adaptive.types';
import {
  SituationalCandidateV2,
  SituationalItemsSelectionV2Service,
} from './situational-items-selection-v2.service';

/**
 * The situational mode: the same lock and roster as the full-build mode, but a
 * different question — the items that beat *this* enemy team, ranked purely by
 * matchup, with no prescribed build. It shares the lock resolution (and so the
 * archetype and the enemy roster) with `AdaptiveRecommendationV2Service` so the
 * two modes cannot disagree about who the enemies are or what "core" means.
 */
@Injectable()
export class AdaptiveSituationalV2Service {
  constructor(
    private readonly recommendation: AdaptiveRecommendationV2Service,
    private readonly selection: SituationalItemsSelectionV2Service,
    private readonly enemyThreat: EnemyThreatV1Service,
  ) {}

  async recommend(request: AdaptiveRecommendationRequestV2): Promise<AdaptiveSituationalResultV2> {
    const resolution = await this.recommendation.resolveLockContext(request);
    if (!resolution.ok) {
      return notReadySituational(resolution.decision, resolution.blockers);
    }
    const { decision, context } = resolution;
    const { lock, snapshot, selection, enemyHeroIds, vsHeroRows, evidence } = context;

    // The whole feature is matchup evidence. An offline-default selection means
    // there is none, so an empty list would be a lie dressed as an answer.
    if (selection.mode === 'OFFLINE_DEFAULT') {
      return notReadySituational(decision, ['SITUATIONAL_EVIDENCE_UNAVAILABLE']);
    }

    const archetype = snapshot.archetypes.find((entry) => entry.archetypeId === lock.archetypeId);
    if (!archetype) {
      return notReadySituational(decision, ['LOCKED_ARCHETYPE_V2_UNAVAILABLE']);
    }

    const enemyThreats = this.enemyThreat.scoreEnemies(
      enemyHeroIds.map((heroId) =>
        decision.enemyLiveStates.find((enemy) => enemy.heroId === heroId) ?? {
          steamId: `enemy-hero:${heroId}`,
          heroId,
        },
      ),
    );

    // The hero's consensus build is what decides "buys anyway". The archetype
    // cannot answer that on its own: it is compiled per matchup and carries only
    // the items it models, so Infuser — a staple in the Viktor consensus build —
    // is absent from every Viktor archetype and slipped through a CORE-only
    // archetype filter into the situational list. The skeleton is per hero and
    // complete; when a hero has none yet, the archetype filter still applies.
    const skeleton = evidence.byDataset.CONSENSUS_SKELETON.payload as ConsensusSkeletonV1 | undefined;

    const candidates = this.selection.select({
      heroId: decision.state.heroId,
      rulesetId: decision.rulesetId,
      archetype,
      consensusItems: skeleton?.items ?? [],
      itemGraph: decision.itemGraph,
      ownedItemIds: [...decision.state.inventory.heldByItemId.keys()],
      enemyHeroIds,
      enemyThreats,
      vsHeroRows,
    });
    if (candidates.length === 0) {
      return notReadySituational(decision, ['SITUATIONAL_EVIDENCE_UNAVAILABLE']);
    }

    return {
      mode: 'situational',
      ready: true,
      blockers: [],
      decisionId: decision.state.decisionId,
      stateRevision: decision.stateRevision,
      heroId: decision.state.heroId,
      lock: lockSummary(lock, selection),
      situationalItems: candidates.map(toSituationalItem),
      degradedReasons: [...lock.degradedReasons],
    };
  }
}

function toSituationalItem(candidate: SituationalCandidateV2): AdaptiveSituationalItemV2 {
  return {
    itemId: candidate.itemId,
    score: candidate.score,
    confidence: candidate.confidence,
    coverage: candidate.coverage,
    against: candidate.against.map((target) => ({
      enemyHeroId: target.enemyHeroId,
      deltaWpa: target.deltaWpa,
      count: target.count,
    })),
  };
}

function notReadySituational(
  decision: AdaptiveDecisionStateV1,
  blockers: readonly string[],
): AdaptiveSituationalResultV2 {
  return {
    mode: 'situational',
    ready: false,
    blockers: [...blockers],
    decisionId: decision.state.decisionId,
    stateRevision: decision.stateRevision,
    heroId: decision.state.heroId,
    situationalItems: [],
    degradedReasons: [...blockers],
  };
}
