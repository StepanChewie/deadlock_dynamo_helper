import { Injectable } from '@nestjs/common';
import {
  RecommendationCandidate,
  RecommendationDecisionState,
  RecommendationItemGraph,
  generateRecommendationCandidates,
} from '@deadlock-live-probe/build-domain';
import {
  RecommendationActionFeatureV8,
  RecommendationBehavioralRuntimePredictorV1,
  RecommendationBehavioralV8Decision,
  RecommendationBehavioralV8LinearModel,
  RecommendationBehavioralV8Prediction,
  RecommendationDecisionCandidateV8,
  RecommendationFeatureStateV8,
  RecommendationPolicyDistributionV1,
  RecommendationPolicyV1Config,
  RecommendationValueV8Model,
  attachRecommendationPolicyScoresV1,
  buildRecommendationPolicyDistributionV1,
  createRecommendationBehavioralLinearRuntimePredictorV1,
  predictRecommendationBehavioralRuntimeV1,
  predictRecommendationValueV8,
  validateRawBehaviorProbabilityVectorV8,
} from '@deadlock-live-probe/shared';

export interface RecommendationEngineV8Input {
  state: RecommendationDecisionState;
  itemGraph: RecommendationItemGraph;
  featureState?: RecommendationFeatureStateV8;
  behavioralModel?: RecommendationBehavioralV8LinearModel;
  behavioralPredictor?: RecommendationBehavioralRuntimePredictorV1;
  behavioralPrediction?: RecommendationBehavioralV8Prediction;
  valueModel?: RecommendationValueV8Model;
  policyConfig?: RecommendationPolicyV1Config;
}

export interface RecommendationEngineBehavioralPreparationV8 {
  domainCandidates: readonly RecommendationCandidate[];
  decision: RecommendationBehavioralV8Decision;
}

export interface RecommendationEngineV8Result {
  domainCandidates: readonly RecommendationCandidate[];
  telemetryCandidates: readonly RecommendationDecisionCandidateV8[];
  policyAttempted: boolean;
  policyReady: boolean;
  policyBlockers: readonly string[];
  policyDistribution?: RecommendationPolicyDistributionV1;
}

@Injectable()
export class RecommendationEngineV8Service {
  prepareBehavioralDecision(input: {
    state: RecommendationDecisionState;
    itemGraph: RecommendationItemGraph;
    featureState: RecommendationFeatureStateV8;
  }): RecommendationEngineBehavioralPreparationV8 {
    const domainCandidates = generateRecommendationCandidates({
      state: input.state,
      itemGraph: input.itemGraph,
    });
    return {
      domainCandidates,
      decision: toBehavioralDecision(input.featureState, domainCandidates),
    };
  }

  evaluate(input: RecommendationEngineV8Input): RecommendationEngineV8Result {
    validateBehavioralSources(input);
    const domainCandidates = generateRecommendationCandidates({
      state: input.state,
      itemGraph: input.itemGraph,
    });
    const baseTelemetryCandidates = domainCandidates.map(toTelemetryCandidate);
    const behavioralPredictor = input.behavioralPredictor
      ?? (input.behavioralModel ? createRecommendationBehavioralLinearRuntimePredictorV1(input.behavioralModel) : undefined);
    const behaviorProbabilityByAction = input.behavioralPrediction
      ? externalBehaviorProbabilities(input.behavioralPrediction, input.featureState, domainCandidates)
      : behavioralPredictor && input.featureState
        ? predictBehaviorProbabilities(behavioralPredictor, input.featureState, domainCandidates)
        : undefined;
    let telemetryCandidates: RecommendationDecisionCandidateV8[] = baseTelemetryCandidates.map((candidate) => ({
      ...candidate,
      behaviorProbability: behaviorProbabilityByAction?.get(candidate.actionKey),
    }));

    const valueModel = input.valueModel;
    const featureState = input.featureState;
    if (valueModel && featureState) {
      telemetryCandidates = telemetryCandidates.map((candidate) => ({
        ...candidate,
        valueScore: candidate.feasible
          ? predictRecommendationValueV8(valueModel, featureState, toActionFeature(candidate)).value
          : undefined,
      }));
    }

    const policyAttempted = input.valueModel !== undefined || input.policyConfig !== undefined;
    if (!policyAttempted) {
      return {
        domainCandidates,
        telemetryCandidates,
        policyAttempted: false,
        policyReady: true,
        policyBlockers: [],
      };
    }
    if (!input.featureState) {
      return policyFailure(domainCandidates, telemetryCandidates, 'POLICY_FEATURE_STATE_MISSING');
    }
    if (!behaviorProbabilityByAction) {
      return policyFailure(domainCandidates, telemetryCandidates, 'POLICY_BEHAVIORAL_MODEL_MISSING');
    }
    if (!input.valueModel) {
      return policyFailure(domainCandidates, telemetryCandidates, 'POLICY_VALUE_MODEL_MISSING');
    }
    if (!input.policyConfig) {
      return policyFailure(domainCandidates, telemetryCandidates, 'POLICY_CONFIG_MISSING');
    }

    try {
      const policyDistribution = buildRecommendationPolicyDistributionV1(
        telemetryCandidates,
        input.policyConfig,
      );
      telemetryCandidates = attachRecommendationPolicyScoresV1(
        telemetryCandidates,
        policyDistribution,
      );
      return {
        domainCandidates,
        telemetryCandidates,
        policyAttempted: true,
        policyReady: true,
        policyBlockers: [],
        policyDistribution,
      };
    } catch (error) {
      return policyFailure(
        domainCandidates,
        telemetryCandidates,
        `POLICY_BUILD_FAILED:${errorMessage(error)}`,
      );
    }
  }
}

export function toTelemetryCandidate(candidate: RecommendationCandidate): RecommendationDecisionCandidateV8 {
  const reasons = new Set(candidate.reasons);
  const action = candidate.action;
  const transactionUnknown = reasons.has('SELL_TRANSITION_UNKNOWN')
    || reasons.has('SELL_RETURN_ITEM_UNKNOWN')
    || reasons.has('DIRECT_PURCHASE_NOT_SUPPORTED');
  const walletUnknown = reasons.has('SPENDABLE_SOULS_UNKNOWN');
  const shopUnknown = reasons.has('SHOP_OPPORTUNITY_UNKNOWN');
  const shopUnavailable = reasons.has('SHOP_UNAVAILABLE');
  const rulesetUnavailable = reasons.has('ITEM_UNAVAILABLE_IN_RULESET');
  const recipeIllegal = reasons.has('MISSING_UPGRADE_COMPONENT')
    || reasons.has('DIRECT_PURCHASE_NOT_SUPPORTED')
    || reasons.has('SELL_RETURN_ITEM_UNKNOWN');

  return {
    actionKey: candidate.actionId,
    actionType: action.type,
    targetItemId: action.type === 'BUY_ITEM'
      || action.type === 'UPGRADE_ITEM'
      || action.type === 'SELL_ITEM'
      ? action.itemId
      : action.type === 'REPLACE_ITEM'
        ? action.buyItemId
        : action.targetItemId,
    sellItemId: action.type === 'REPLACE_ITEM' ? action.sellItemId : undefined,
    recipeId: action.type === 'UPGRADE_ITEM' ? action.recipeId : undefined,
    consumedItemIds: action.type === 'UPGRADE_ITEM' ? [...action.consumedItemIds] : undefined,
    effectiveCostSouls: candidate.effectiveCostSouls,
    spendableSoulsAfter: candidate.spendableSoulsAfter,
    resultingItemIds: [...candidate.resultingItemIds],
    feasible: candidate.feasible,
    feasibilityReasons: [...candidate.reasons],
    affordable: action.type === 'SELL_ITEM' || action.type === 'WAIT_SAVE'
      ? true
      : walletUnknown
        ? 'UNKNOWN'
        : !reasons.has('UNAFFORDABLE'),
    slotLegal: !reasons.has('SLOT_LIMIT_EXCEEDED'),
    recipeLegal: !recipeIllegal,
    shopLegal: shopUnknown ? 'UNKNOWN' : !shopUnavailable,
    rulesetLegal: !rulesetUnavailable,
    transactionMechanicsKnown: !transactionUnknown,
    evidence: {
      spendableSouls: candidate.evidence.spendableSouls,
      shopOpportunity: candidate.evidence.shopOpportunity,
      inventory: candidate.evidence.inventory,
      ruleset: candidate.evidence.ruleset,
      transaction: transactionUnknown ? 'UNKNOWN' : candidate.evidence.transaction,
    },
  };
}

function predictBehaviorProbabilities(
  predictor: RecommendationBehavioralRuntimePredictorV1,
  featureState: RecommendationFeatureStateV8,
  candidates: readonly RecommendationCandidate[],
): Map<string, number> {
  const decision = toBehavioralDecision(featureState, candidates);
  const prediction = predictRecommendationBehavioralRuntimeV1(predictor, decision);
  return predictionMap(prediction, candidates);
}

function externalBehaviorProbabilities(
  prediction: RecommendationBehavioralV8Prediction,
  featureState: RecommendationFeatureStateV8 | undefined,
  candidates: readonly RecommendationCandidate[],
): Map<string, number> {
  if (!featureState) throw new Error('External Behavioral prediction requires featureState');
  if (prediction.decisionId !== featureState.decisionId) throw new Error('External Behavioral prediction decisionId mismatch');
  validateRawBehaviorProbabilityVectorV8(prediction, 1e-6);
  const expected = toBehavioralDecision(featureState, candidates).candidates.map((candidate) => candidate.actionKey).sort();
  const actual = prediction.candidates.map((candidate) => candidate.actionKey).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error('External Behavioral prediction must cover exactly the feasible choice set');
  }
  return predictionMap(prediction, candidates);
}

function predictionMap(
  prediction: RecommendationBehavioralV8Prediction,
  candidates: readonly RecommendationCandidate[],
): Map<string, number> {
  const probabilities = new Map(prediction.candidates.map((candidate) => [candidate.actionKey, candidate.probability]));
  for (const candidate of candidates) {
    if (!candidate.feasible) probabilities.set(candidate.actionId, 0);
  }
  return probabilities;
}

function toBehavioralDecision(
  featureState: RecommendationFeatureStateV8,
  candidates: readonly RecommendationCandidate[],
): RecommendationBehavioralV8Decision {
  const feasible = candidates.filter((candidate) => candidate.feasible);
  if (feasible.length === 0) throw new Error('Behavioral serving requires at least one feasible candidate');
  return {
    decisionId: featureState.decisionId,
    state: featureState,
    candidates: feasible.map((candidate) => ({
      ...toActionFeature(toTelemetryCandidate(candidate)),
      feasible: true as const,
    })),
  };
}

function toActionFeature(candidate: RecommendationDecisionCandidateV8): RecommendationActionFeatureV8 {
  return {
    actionKey: candidate.actionKey,
    actionType: candidate.actionType,
    targetItemId: candidate.targetItemId,
    sellItemId: candidate.sellItemId,
    recipeId: candidate.recipeId,
    effectiveCostSouls: candidate.effectiveCostSouls,
  };
}

function validateBehavioralSources(input: RecommendationEngineV8Input): void {
  const count = Number(input.behavioralModel !== undefined)
    + Number(input.behavioralPredictor !== undefined)
    + Number(input.behavioralPrediction !== undefined);
  if (count > 1) throw new Error('Provide exactly one Behavioral runtime source');
}

function policyFailure(
  domainCandidates: readonly RecommendationCandidate[],
  telemetryCandidates: readonly RecommendationDecisionCandidateV8[],
  blocker: string,
): RecommendationEngineV8Result {
  return {
    domainCandidates,
    telemetryCandidates: stripUnsafeValueOnlyScores(telemetryCandidates),
    policyAttempted: true,
    policyReady: false,
    policyBlockers: [blocker],
  };
}

function stripUnsafeValueOnlyScores(
  candidates: readonly RecommendationDecisionCandidateV8[],
): RecommendationDecisionCandidateV8[] {
  return candidates.map((candidate) => ({
    ...candidate,
    valueScore: undefined,
    policyScore: undefined,
  }));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
