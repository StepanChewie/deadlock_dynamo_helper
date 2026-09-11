import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import {
  BuildDesiredStateV2Service,
} from './build-desired-state-v2.service';
import { BuildItemUtilityV2Service } from './build-item-utility-v2.service';
import {
  FullBuildLifetimeResolverV2Input,
  FullBuildResolutionV2,
  FullBuildResolverV2Input,
  FullBuildResolverV2Service,
} from './full-build-resolver-v2.service';
import { ResolvedFullBuildPlanV2 } from './full-build-plan-v2';
import { simulateFullBuildInventoryV2 } from './full-build-inventory-simulator-v2';
import { FullBuildSemanticValidatorV2Service } from './full-build-semantic-validator-v2.service';
import { FullBuildTransactionPlannerV2Service } from './full-build-transaction-planner-v2.service';
import { ThreatWeightedMatchupV1Service } from './threat-weighted-matchup-v1.service';

@Injectable()
export class FamilyFirstFullBuildResolverV2Service extends FullBuildResolverV2Service {
  private readonly desiredState = new BuildDesiredStateV2Service(new ThreatWeightedMatchupV1Service());
  private readonly transactionPlanner = new FullBuildTransactionPlannerV2Service();
  private readonly semanticValidator = new FullBuildSemanticValidatorV2Service();

  constructor(itemUtility: BuildItemUtilityV2Service) {
    super(itemUtility);
  }

  override resolve(input: FullBuildLifetimeResolverV2Input): ResolvedFullBuildPlanV2;
  override resolve(input: FullBuildResolverV2Input): FullBuildResolutionV2;
  override resolve(
    input: FullBuildLifetimeResolverV2Input | FullBuildResolverV2Input,
  ): ResolvedFullBuildPlanV2 | FullBuildResolutionV2 {
    if (!isLifetimeInput(input) || (input.archetype.families ?? []).length === 0) {
      return super.resolve(input as FullBuildResolverV2Input);
    }
    return this.resolveFamilyFirstLifetime(input);
  }

  private resolveFamilyFirstLifetime(input: FullBuildLifetimeResolverV2Input): ResolvedFullBuildPlanV2 {
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

    const desiredState = this.desiredState.resolve({
      heroId: input.heroId,
      archetype: input.archetype,
      totalCapacity: input.capacity,
      enemyHeroIds: input.enemyHeroIds,
      enemyThreats: input.enemyThreats.map((enemy) => ({
        heroId: enemy.heroId,
        threatMultiplier: enemy.threatMultiplier,
      })),
      vsHeroRows: input.vsHeroRows,
    });
    input.trace?.record({
      stage: 'DESIRED_STATE',
      reasonCodes: [...desiredState.reasonCodes],
      payload: {
        families: desiredState.families.map((family) => ({ ...family })),
        selectedChoiceFamilyIdsByGroup: desiredState.selectedChoiceFamilyIdsByGroup,
        reasonCodes: [...desiredState.reasonCodes],
      },
    });

    const transactionPlan = this.transactionPlanner.plan({
      archetype: input.archetype,
      desiredState,
      itemGraph: input.itemGraph,
      rulesetId: input.rulesetId,
      capacity: input.capacity,
      currentInventoryItemIds: input.currentInventoryItemIds,
    });
    for (const reasonCode of transactionPlan.reasonCodes) degradedReasons.add(reasonCode);

    input.trace?.record({
      stage: 'PLAN_SEARCH',
      reasonCodes: [...transactionPlan.reasonCodes],
      payload: {
        branches: transactionPlan.actions.map((action, index) => ({
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
      actions: transactionPlan.actions,
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
    const planRevision = createPlanRevision(input, transactionPlan.actions);
    const plan: ResolvedFullBuildPlanV2 = {
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
    input.trace?.record({
      stage: 'FINAL_PLAN',
      reasonCodes: [...validation.reasonCodes],
      payload: {
        planRevision,
        stepCount: plan.steps.length,
        degradedReasons: [...plan.degradedReasons],
        valid: validation.valid,
        validationReasonCodes: [...validation.reasonCodes],
      },
    });
    return plan;
  }
}

function isLifetimeInput(
  input: FullBuildLifetimeResolverV2Input | FullBuildResolverV2Input,
): input is FullBuildLifetimeResolverV2Input {
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

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}
