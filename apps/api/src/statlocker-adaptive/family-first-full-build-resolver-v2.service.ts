import { createHash } from 'crypto';
import { Injectable, Optional } from '@nestjs/common';
import { RecommendationItemGraph } from '@deadlock-live-probe/build-domain';
import {
  BuildDesiredStateV2Service,
  DesiredBuildStateV2,
  DesiredFamilyStateV2,
} from './build-desired-state-v2.service';
import { BuildItemUtilityV2Service } from './build-item-utility-v2.service';
import { FullBuildHysteresisV2Service } from './full-build-hysteresis-v2.service';
import {
  FullBuildLifetimeResolverV2Input,
  FullBuildResolutionV2,
  FullBuildResolverV2Input,
  FullBuildResolverV2Service,
} from './full-build-resolver-v2.service';
import {
  FullBuildTransitionIntentV2,
  ResolvedFullBuildPlanV2,
} from './full-build-plan-v2';
import { simulateFullBuildInventoryV2 } from './full-build-inventory-simulator-v2';
import { FullBuildSemanticValidatorV2Service } from './full-build-semantic-validator-v2.service';
import { FullBuildTransactionPlannerV2Service } from './full-build-transaction-planner-v2.service';
import type { MatchupCandidateV2 } from './matchup-candidate-discovery-v2.service';
import { STATLOCKER_BUILD_V2_CONFIG } from './statlocker-build-v2.config';
import { StatlockerHeroItemLifecycleV1 } from './statlocker-adaptive.types';
import { ThreatWeightedMatchupV1Service } from './threat-weighted-matchup-v1.service';

export interface FamilyFirstFullBuildLifetimeResolverV2Input extends FullBuildLifetimeResolverV2Input {
  previousPlan?: ResolvedFullBuildPlanV2;
  /**
   * Verified current-patch Statlocker lifecycle rows for the hero. Loaded by
   * the async caller (like vsHeroRows) and forwarded to the transaction
   * planner's replacement context; the resolver and planner never query
   * repositories themselves.
   */
  lifecycleEvidence?: readonly StatlockerHeroItemLifecycleV1[];
}

interface OutsideCompetitionV2 {
  desiredState: DesiredBuildStateV2;
  selectedOutsideCandidates: readonly MatchupCandidateV2[];
  rejectedOutsideCandidates: readonly MatchupCandidateV2[];
}

@Injectable()
export class FamilyFirstFullBuildResolverV2Service extends FullBuildResolverV2Service {
  private readonly desiredState = new BuildDesiredStateV2Service(new ThreatWeightedMatchupV1Service());
  private readonly transactionPlanner: FullBuildTransactionPlannerV2Service;
  private readonly semanticValidator = new FullBuildSemanticValidatorV2Service();
  private readonly hysteresis = new FullBuildHysteresisV2Service();

  constructor(
    itemUtility: BuildItemUtilityV2Service,
    @Optional() transactionPlanner?: FullBuildTransactionPlannerV2Service,
  ) {
    super(itemUtility);
    this.transactionPlanner = transactionPlanner ?? new FullBuildTransactionPlannerV2Service();
  }

  override resolve(input: FamilyFirstFullBuildLifetimeResolverV2Input): ResolvedFullBuildPlanV2;
  override resolve(input: FullBuildResolverV2Input): FullBuildResolutionV2;
  override resolve(
    input: FamilyFirstFullBuildLifetimeResolverV2Input | FullBuildResolverV2Input,
  ): ResolvedFullBuildPlanV2 | FullBuildResolutionV2 {
    if (!isLifetimeInput(input)) return super.resolve(input);
    if ((input.archetype.families ?? []).length === 0) {
      throw new Error('Family-first full build resolver v2 requires family semantics');
    }
    return this.resolveFamilyFirstLifetime(input);
  }

  private resolveFamilyFirstLifetime(input: FamilyFirstFullBuildLifetimeResolverV2Input): ResolvedFullBuildPlanV2 {
    const degradedReasons = new Set<string>();
    if (input.vsHeroRows.length === 0) degradedReasons.add('MATCHUP_WPA_UNAVAILABLE');
    if (!input.t4Chains) degradedReasons.add('T4_CHAINS_UNAVAILABLE');

    input.trace?.record({
      stage: 'LIVE_CONTEXT',
      reasonCodes: [],
      payload: {
        gameTimeSec: input.gameTimeSec,
        inventoryItemIds: [...input.currentInventoryItemIds],
        capacity: input.capacity,
        enemyThreats: input.enemyThreats.map((enemy) => ({
          heroId: enemy.heroId,
          threatMultiplier: enemy.threatMultiplier,
          completeness: enemy.completeness,
          reasonCodes: [...enemy.reasonCodes],
        })),
      },
    });

    const baseDesiredState = this.desiredState.resolve({
      heroId: input.heroId,
      archetype: input.archetype,
      enemyHeroIds: input.enemyHeroIds,
      enemyThreats: input.enemyThreats.map((enemy) => ({
        heroId: enemy.heroId,
        threatMultiplier: enemy.threatMultiplier,
      })),
      vsHeroRows: input.vsHeroRows,
      flexGoalCapacity: input.capacity,
      flexInvestment: buildFlexInvestmentContext(input.itemGraph, input.currentInventoryItemIds),
    });
    const outsideCompetition = resolveOutsideCompetition(
      baseDesiredState,
      input.outsideCandidates ?? [],
      input.capacity,
    );
    const desiredState = outsideCompetition.desiredState;

    input.trace?.record({
      stage: 'DESIRED_STATE',
      reasonCodes: [...desiredState.reasonCodes],
      payload: {
        families: desiredState.families.map((family) => ({ ...family })),
        selectedChoiceFamilyIdsByGroup: desiredState.selectedChoiceFamilyIdsByGroup,
        reasonCodes: [...desiredState.reasonCodes],
      },
    });

    if ((input.outsideCandidates ?? []).length > 0) {
      const selectedIds = new Set(outsideCompetition.selectedOutsideCandidates.map((candidate) => candidate.targetItemId));
      input.trace?.record({
        stage: 'CANDIDATE_DISCOVERY',
        reasonCodes: [],
        payload: {
          candidates: (input.outsideCandidates ?? []).map((candidate) => ({
            candidateId: `outside:${candidate.targetItemId}`,
            itemId: candidate.targetItemId,
            score: candidate.utility.total,
            confidence: candidate.matchup.confidence,
            coverage: candidate.matchup.coverage,
            disposition: selectedIds.has(candidate.targetItemId) ? 'SELECTED' : 'REJECTED',
            reasonCodes: selectedIds.has(candidate.targetItemId)
              ? uniqueStrings([...candidate.reasonCodes, 'OUTSIDE_SITUATIONAL_SELECTED'])
              : uniqueStrings([...candidate.reasonCodes, 'OUTSIDE_SITUATIONAL_NOT_SELECTED']),
            insideLockedArchetype: false,
          })),
        },
      });
    }

    const transactionPlan = this.transactionPlanner.plan({
      archetype: input.archetype,
      desiredState,
      itemGraph: input.itemGraph,
      rulesetId: input.rulesetId,
      capacity: input.capacity,
      currentInventoryItemIds: input.currentInventoryItemIds,
      replacementContext: {
        heroId: input.heroId,
        gameTimeSec: input.gameTimeSec,
        enemyHeroIds: input.enemyHeroIds,
        enemyThreats: input.enemyThreats,
        vsHeroRows: input.vsHeroRows,
        ...(input.wpaPatchData === undefined ? {} : { wpaPatchData: input.wpaPatchData }),
        ...(input.t4Chains === undefined ? {} : { t4Chains: input.t4Chains }),
        lifecycleEvidence: input.lifecycleEvidence ?? [],
      },
    });
    for (const reasonCode of transactionPlan.reasonCodes) degradedReasons.add(reasonCode);

    const actions = [...transactionPlan.actions];
    const rejectedOutsideReasonCodes = new Set<string>();
    for (const candidate of outsideCompetition.selectedOutsideCandidates) {
      const action = outsideCandidateAction(candidate);
      if (!action) {
        rejectedOutsideReasonCodes.add('OUTSIDE_CANDIDATE_ACTION_UNSUPPORTED');
        continue;
      }
      const trialActions = [...actions, action];
      const trialSimulation = simulateFullBuildInventoryV2({
        rulesetId: input.rulesetId,
        itemGraph: input.itemGraph,
        capacity: input.capacity,
        initialInventoryItemIds: input.currentInventoryItemIds,
        actions: trialActions,
      });
      if (!trialSimulation.validation.valid) {
        rejectedOutsideReasonCodes.add('OUTSIDE_CANDIDATE_MECHANICALLY_INVALID');
        continue;
      }
      const trialSemanticValidation = this.semanticValidator.validate({
        archetype: input.archetype,
        desiredState,
        initialInventoryItemIds: input.currentInventoryItemIds,
        steps: trialSimulation.steps,
        itemGraph: input.itemGraph,
      });
      if (!trialSemanticValidation.valid) {
        for (const reasonCode of trialSemanticValidation.reasonCodes) {
          rejectedOutsideReasonCodes.add(reasonCode);
        }
        rejectedOutsideReasonCodes.add('OUTSIDE_CANDIDATE_SEMANTICALLY_INVALID');
        continue;
      }
      actions.push(action);
    }
    for (const reasonCode of rejectedOutsideReasonCodes) degradedReasons.add(reasonCode);

    input.trace?.record({
      stage: 'PLAN_SEARCH',
      reasonCodes: uniqueStrings([...transactionPlan.reasonCodes, ...rejectedOutsideReasonCodes]),
      payload: {
        branches: actions.map((action, index) => ({
          sequence: index + 1,
          targetItemId: action.buyItemId,
          action: action.action,
          disposition: 'SELECTED' as const,
          reasonCodes: [...action.reasonCodes],
        })),
      },
    });

    const simulation = simulateFullBuildInventoryV2({
      rulesetId: input.rulesetId,
      itemGraph: input.itemGraph,
      capacity: input.capacity,
      initialInventoryItemIds: input.currentInventoryItemIds,
      actions,
    });
    const semanticValidation = this.semanticValidator.validate({
      archetype: input.archetype,
      desiredState,
      initialInventoryItemIds: input.currentInventoryItemIds,
      steps: simulation.steps,
      itemGraph: input.itemGraph,
    });
    input.trace?.record({
      stage: 'SEMANTIC_VALIDATION',
      reasonCodes: [...semanticValidation.reasonCodes],
      payload: {
        valid: semanticValidation.valid,
        reasonCodes: [...semanticValidation.reasonCodes],
        finalFamilyStates: semanticValidation.finalFamilyStates.map((state) => ({ ...state })),
      },
    });

    const validationReasonCodes = uniqueStrings([
      ...simulation.validation.reasonCodes,
      ...semanticValidation.reasonCodes,
    ]).sort();
    const validation = {
      valid: simulation.validation.valid && semanticValidation.valid,
      reasonCodes: validationReasonCodes,
    };
    const planRevision = createPlanRevision(input, actions);
    const candidate: ResolvedFullBuildPlanV2 = {
      planRevision,
      matchId: input.matchId,
      heroId: input.heroId,
      archetypeId: input.archetype.archetypeId,
      stateRevision: input.stateRevision,
      steps: simulation.steps,
      degradedReasons: [...degradedReasons].sort(),
      validation,
      desiredState,
      mechanicalValidation: simulation.validation,
      semanticValidation,
    };

    const selected = this.applyPreviousPlanHysteresis(input, candidate);
    input.trace?.record({
      stage: 'FINAL_PLAN',
      reasonCodes: [...selected.reasonCodes, ...selected.plan.validation.reasonCodes],
      payload: {
        planRevision: selected.plan.planRevision,
        stepCount: selected.plan.steps.length,
        degradedReasons: [...selected.plan.degradedReasons],
        valid: selected.plan.validation.valid,
        validationReasonCodes: [...selected.plan.validation.reasonCodes],
      },
    });
    return selected.plan;
  }

  private applyPreviousPlanHysteresis(
    input: FamilyFirstFullBuildLifetimeResolverV2Input,
    candidate: ResolvedFullBuildPlanV2,
  ): { plan: ResolvedFullBuildPlanV2; reasonCodes: readonly string[] } {
    const previous = input.previousPlan;
    if (
      !previous ||
      !previous.validation.valid ||
      previous.matchId !== candidate.matchId ||
      previous.heroId !== candidate.heroId ||
      previous.archetypeId !== candidate.archetypeId ||
      previous.stateRevision !== candidate.stateRevision
    ) {
      return { plan: candidate, reasonCodes: [] };
    }

    const decision = this.hysteresis.choose(previous, candidate, {
      improvement: desiredStateScore(candidate) - desiredStateScore(previous),
      coreReplacement: false,
      recentPurchaseProtected: hasProtectedRecentPurchase(input),
    });
    return { plan: decision.selected, reasonCodes: decision.reasonCodes };
  }
}

function resolveOutsideCompetition(
  desiredState: DesiredBuildStateV2,
  outsideCandidates: readonly MatchupCandidateV2[],
  capacity: number,
): OutsideCompetitionV2 {
  const mandatoryFamilies = desiredState.families.filter((family) =>
    family.requirement === 'REQUIRED' || family.requirement === 'CHOICE',
  );
  const adaptiveFamilies = desiredState.families.filter((family) =>
    family.requirement === 'OPTIONAL' || family.requirement === 'SITUATIONAL',
  );
  const eligibleOutside = dedupeOutsideCandidates(outsideCandidates)
    .filter((candidate) =>
      candidate.candidate.action.type === 'BUY_ITEM' ||
      candidate.utility.total >= candidate.requiredImprovement,
    );
  const adaptiveCapacity = Math.max(0, capacity - mandatoryFamilies.length);
  const competitors = [
    ...adaptiveFamilies.map((family) => ({
      kind: 'FAMILY' as const,
      score: family.score,
      confidence: family.confidence,
      stableId: family.familyId,
      family,
    })),
    ...eligibleOutside.map((candidate) => ({
      kind: 'OUTSIDE' as const,
      score: candidate.utility.total,
      confidence: candidate.matchup.confidence,
      stableId: candidate.targetItemId,
      candidate,
    })),
  ].sort((left, right) =>
    right.score - left.score ||
    right.confidence - left.confidence ||
    left.stableId - right.stableId,
  );
  const selectedCompetitors = competitors.slice(0, adaptiveCapacity);
  const selectedFamilyIds = new Set(
    selectedCompetitors
      .filter((entry): entry is Extract<typeof entry, { kind: 'FAMILY' }> => entry.kind === 'FAMILY')
      .map((entry) => entry.family.familyId),
  );
  const selectedOutsideCandidates = selectedCompetitors
    .filter((entry): entry is Extract<typeof entry, { kind: 'OUTSIDE' }> => entry.kind === 'OUTSIDE')
    .map((entry) => entry.candidate);
  const selectedOutsideIds = new Set(selectedOutsideCandidates.map((candidate) => candidate.targetItemId));
  const selectedFamilies = [
    ...mandatoryFamilies,
    ...adaptiveFamilies.filter((family) => selectedFamilyIds.has(family.familyId)),
  ];
  const reasonCodes = new Set(desiredState.reasonCodes);
  if (selectedOutsideCandidates.length > 0) reasonCodes.add('OUTSIDE_SITUATIONAL_SELECTED');
  if (selectedFamilies.length + selectedOutsideCandidates.length < capacity) {
    reasonCodes.add('DESIRED_STATE_UNDER_CAPACITY');
  }

  return {
    desiredState: {
      ...desiredState,
      families: selectedFamilies,
      reasonCodes: [...reasonCodes].sort(),
    },
    selectedOutsideCandidates,
    rejectedOutsideCandidates: eligibleOutside.filter((candidate) => !selectedOutsideIds.has(candidate.targetItemId)),
  };
}

function dedupeOutsideCandidates(candidates: readonly MatchupCandidateV2[]): MatchupCandidateV2[] {
  const byTarget = new Map<number, MatchupCandidateV2>();
  for (const candidate of candidates) {
    const current = byTarget.get(candidate.targetItemId);
    if (
      !current ||
      candidate.utility.total > current.utility.total ||
      (
        candidate.utility.total === current.utility.total &&
        candidate.matchup.confidence > current.matchup.confidence
      )
    ) {
      byTarget.set(candidate.targetItemId, candidate);
    }
  }
  return [...byTarget.values()];
}

function outsideCandidateAction(candidate: MatchupCandidateV2): FullBuildTransitionIntentV2 | undefined {
  const action = candidate.candidate.action;
  if (action.type === 'BUY_ITEM') {
    return {
      action: 'BUY',
      buyItemId: action.itemId,
      reasonCodes: uniqueStrings([...candidate.reasonCodes, 'OUTSIDE_SITUATIONAL_SELECTED']),
    };
  }
  if (action.type === 'REPLACE_ITEM') {
    return {
      action: 'REPLACE',
      sellItemId: action.sellItemId,
      buyItemId: action.buyItemId,
      reasonCodes: uniqueStrings([...candidate.reasonCodes, 'OUTSIDE_SITUATIONAL_SELECTED']),
    };
  }
  return undefined;
}

function isLifetimeInput(
  input: FamilyFirstFullBuildLifetimeResolverV2Input | FullBuildResolverV2Input,
): input is FamilyFirstFullBuildLifetimeResolverV2Input {
  return 'matchId' in input;
}

function createPlanRevision(
  input: FullBuildLifetimeResolverV2Input,
  actions: readonly { action: string; buyItemId: number; sellItemId?: number }[],
): string {
  const semantic = actions.map((action) =>
    action.action === 'REPLACE'
      ? `${action.action}:${action.sellItemId}->${action.buyItemId}`
      : `${action.action}:${action.buyItemId}`,
  );
  return createHash('sha256')
    .update(JSON.stringify({
      matchId: input.matchId,
      stateRevision: input.stateRevision,
      archetypeId: input.archetype.archetypeId,
      semantic,
    }))
    .digest('hex')
    .slice(0, 24);
}

function desiredStateScore(plan: ResolvedFullBuildPlanV2): number {
  return plan.desiredState?.families.reduce((sum, family) => sum + family.score, 0) ?? 0;
}

function hasProtectedRecentPurchase(input: FullBuildLifetimeResolverV2Input): boolean {
  return (input.recentPurchases ?? []).some((purchase) =>
    purchase.ageSec >= 0 &&
    purchase.ageSec <= STATLOCKER_BUILD_V2_CONFIG.fullBuildResolver.recentPurchaseProtectionS,
  );
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Current per-track invested souls for flex invest-closing ranking, valued at
 * each held item's verified direct purchase cost (upgraded items carry their
 * full purchase value).
 */
function buildFlexInvestmentContext(
  itemGraph: RecommendationItemGraph,
  currentInventoryItemIds: readonly number[],
): {
  slotTypeByItemId: (itemId: number) => 'weapon' | 'vitality' | 'spirit' | undefined;
  costByItemId: (itemId: number) => number | undefined;
  currentValueByType: Readonly<Record<'weapon' | 'vitality' | 'spirit', number>>;
} {
  const currentValueByType: Record<'weapon' | 'vitality' | 'spirit', number> = { weapon: 0, vitality: 0, spirit: 0 };
  for (const itemId of currentInventoryItemIds) {
    const item = itemGraph.getItem(itemId);
    if (!item) continue;
    currentValueByType[item.slotType] += Math.max(0, item.directPurchaseCost ?? 0);
  }
  return {
    slotTypeByItemId: (itemId) => itemGraph.getItem(itemId)?.slotType,
    costByItemId: (itemId) => itemGraph.getItem(itemId)?.directPurchaseCost,
    currentValueByType,
  };
}
