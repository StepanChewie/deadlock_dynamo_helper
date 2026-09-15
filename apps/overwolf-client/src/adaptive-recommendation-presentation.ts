import type {
  AdaptiveActionTypeV1,
  AdaptiveActionV1,
  AdaptivePlanActionStatusV1,
  AdaptivePlanActionV1,
  AdaptivePlanRequirementV1,
  AdaptivePlannedItemV1,
  AdaptiveRecommendationResultV1,
  AdaptiveSituationalContextV1,
} from '@deadlock-live-probe/shared';
import {
  ADAPTIVE_ITEM_CATALOG,
  AdaptiveItemCatalogEntry,
  AdaptiveItemSlot,
} from './generated/adaptive-item-catalog';
import { getAdaptiveHeroDisplayName } from './generated/adaptive-hero-catalog';

export interface AdaptivePresentedItem {
  readonly id: number;
  readonly name: string;
  readonly slot: AdaptiveItemSlot;
  readonly costLabel?: string;
  readonly tierLabel?: string;
  readonly diagnosticLabel?: string;
  readonly known: boolean;
}

export interface AdaptivePresentedPlanItem {
  readonly planActionId: string;
  readonly item: AdaptivePresentedItem;
  readonly position: number;
  readonly status: AdaptivePlanActionStatusV1;
  readonly statusLabel: string;
  readonly actionLabel: string;
  readonly requirements: readonly string[];
  readonly sourceItems: readonly AdaptivePresentedItem[];
  readonly replacedItem?: AdaptivePresentedItem;
  readonly situationalPurposeLabel?: string;
  readonly againstLabel?: string;
  readonly isCurrent: boolean;
}

export interface AdaptivePurchaseRouteRow extends AdaptivePresentedPlanItem {}

export interface AdaptivePresentedAlternative {
  readonly actionLabel: string;
  readonly headline: string;
  readonly item?: AdaptivePresentedItem;
  readonly replacedItem?: AdaptivePresentedItem;
  readonly scoreLabel: string;
}

export interface AdaptiveRecommendationPresentation {
  readonly sourceLabel: string;
  readonly stateLabel: string;
  readonly stateTone: 'ahead' | 'even' | 'behind' | 'unknown';
  readonly healthLabel: string;
  readonly healthTone: 'live' | 'degraded' | 'waiting';
  readonly actionLabel: string;
  readonly headline: string;
  readonly primaryItem?: AdaptivePresentedItem;
  readonly replacedItem?: AdaptivePresentedItem;
  readonly confidence: { readonly label: string; readonly value: number };
  readonly reasons: readonly string[];
  readonly primaryRequirements: readonly string[];
  readonly situationalPurposeLabel?: string;
  readonly againstLabel?: string;
  readonly currentPlanActionId?: string;
  readonly plan: {
    readonly items: readonly AdaptivePresentedPlanItem[];
    readonly remainingCount: number;
  };
  readonly alternatives: readonly AdaptivePresentedAlternative[];
  readonly evidenceLabel: string;
}

const REASON_LABELS: Readonly<Record<string, string>> = {
  PLAN_HYSTERESIS: 'Current plan is still the safest choice',
  CORE_TARGET_PENDING: 'Keep saving for the next core item',
  NO_USABLE_STATLOCKER_EVIDENCE: 'Waiting for reliable Statlocker data',
  STATLOCKER_UNAVAILABLE_PRESERVE_PLAN: 'Statlocker is updating; keeping the last safe plan',
  FRESH_LEGALITY_FALLBACK: 'Adjusted to a legal purchase',
  NO_FRESH_LEGAL_TRANSACTION: 'No safe purchase is available right now',
  PLAN_REQUIREMENTS_BLOCKED: 'Waiting for the requirements of the next purchase',
  SEMANTIC_TRANSACTION_PATH: 'Following the legal upgrade path',
  MULTI_STEP_UPGRADE_PATH: 'Complete the next upgrade step first',
};

const GAME_STATE_LABELS = {
  AHEAD: 'Playing ahead',
  EVEN: 'Even game',
  BEHIND: 'Playing from behind',
  UNKNOWN: 'Game state updating',
} as const;

const PLAN_ACTION_STATUS_LABELS: Readonly<Record<AdaptivePlanActionStatusV1, string>> = {
  OWNED: 'Owned',
  READY: 'Ready',
  BLOCKED: 'Blocked',
  PLANNED: 'Planned',
  COMPLETED: 'Completed',
};

const BUILD_STATUS_LABELS = {
  OWNED: 'Owned',
  NEXT: 'Next',
  PLANNED: 'Planned',
} as const;

const SITUATIONAL_PURPOSE_LABELS: Readonly<Record<string, string>> = {
  CATCH: 'Catch',
  ANTI_CC: 'Anti-CC',
  CLEANSE: 'Cleanse',
  ANTI_BULLET: 'Anti-bullet',
  ANTI_SPIRIT: 'Anti-spirit',
  ANTI_BURST: 'Anti-burst',
  ANTI_HEAL: 'Anti-heal',
  MOBILITY: 'Mobility',
  TEAM_UTILITY: 'Team utility',
  SURVIVAL: 'Survival',
};

const ALTERNATIVE_DISPLAY_LIMIT = 3;

export function buildAdaptiveRecommendationPresentation(
  recommendation: AdaptiveRecommendationResultV1,
): AdaptiveRecommendationPresentation {
  const primaryItemId = resolveActionItemId(
    recommendation.nextAction,
    recommendation.nextTargetItemId,
  );
  const primaryItem = primaryItemId === undefined
    ? undefined
    : presentItem(primaryItemId);
  const replacedItem = recommendation.nextAction.type === 'REPLACE'
    ? presentActionSellItem(recommendation.nextAction)
    : undefined;
  const confidenceValue = toPercent(recommendation.confidence);
  const freshEvidenceCount = recommendation.evidence.families.filter(
    (family) => family.freshness === 'FRESH',
  ).length;
  const hasDegradedEvidence = recommendation.evidence.families.some(
    (family) => family.freshness !== 'FRESH',
  ) || recommendation.evidence.degradedReasons.length > 0;
  const primaryPlanAction = resolveCurrentPlanAction(recommendation);
  const primarySituational = primaryPlanAction?.situational;
  const semanticPlan = buildPresentedSemanticPlan(recommendation, primaryPlanAction);

  return {
    sourceLabel: 'Statlocker Adaptive',
    stateLabel: GAME_STATE_LABELS[recommendation.gameState] ?? GAME_STATE_LABELS.UNKNOWN,
    stateTone: recommendation.gameState.toLowerCase() as AdaptiveRecommendationPresentation['stateTone'],
    healthLabel: recommendation.ready
      ? hasDegradedEvidence ? 'Degraded' : 'Live'
      : 'Waiting',
    healthTone: recommendation.ready
      ? hasDegradedEvidence ? 'degraded' : 'live'
      : 'waiting',
    actionLabel: humanizeActionType(recommendation.nextAction.type),
    headline: buildHeadline(recommendation.nextAction, primaryItem, replacedItem),
    primaryItem,
    replacedItem,
    confidence: {
      label: confidenceLabel(recommendation.nextAction.type, confidenceValue),
      value: confidenceValue,
    },
    reasons: recommendation.nextAction.reasonCodes
      .slice(0, 3)
      .map(humanizeReasonCode),
    primaryRequirements: primaryPlanAction?.requirements.map(presentRequirement) ?? [],
    situationalPurposeLabel: presentSituationalPurpose(primarySituational),
    againstLabel: presentAgainst(primarySituational),
    currentPlanActionId: primaryPlanAction?.planActionId,
    plan: {
      items: semanticPlan,
      remainingCount: 0,
    },
    alternatives: buildAlternatives(recommendation, primaryItemId),
    evidenceLabel: freshEvidenceCount > 0
      ? `${freshEvidenceCount} fresh Statlocker signal${freshEvidenceCount === 1 ? '' : 's'}`
      : 'Statlocker evidence is updating',
  };
}

export function buildAdaptivePurchaseRoute(
  view: AdaptiveRecommendationPresentation,
  limit = 5,
): readonly AdaptivePurchaseRouteRow[] {
  const purchasable = view.plan.items.filter(
    (item) => item.status !== 'OWNED' && item.status !== 'COMPLETED',
  );
  const current = purchasable.find((item) => item.isCurrent);
  const currentRow = current ?? (view.primaryItem ? {
    planActionId: view.currentPlanActionId ?? `current:${view.primaryItem.id}`,
    item: view.primaryItem,
    position: 0,
    status: 'READY' as const,
    statusLabel: 'Ready',
    actionLabel: view.actionLabel,
    requirements: view.primaryRequirements,
    sourceItems: [],
    replacedItem: view.replacedItem,
    situationalPurposeLabel: view.situationalPurposeLabel,
    againstLabel: view.againstLabel,
    isCurrent: true,
  } : undefined);
  if (!currentRow) {
    return Number.isFinite(limit) ? purchasable.slice(0, Math.max(0, limit)) : purchasable;
  }
  const currentIndex = view.plan.items.indexOf(currentRow);
  const subsequent = currentIndex < 0
    ? purchasable
    : view.plan.items.slice(currentIndex + 1).filter(
      (item) => item.status !== 'OWNED' && item.status !== 'COMPLETED',
    );
  const rows = [currentRow, ...subsequent];
  return Number.isFinite(limit) ? rows.slice(0, Math.max(0, limit)) : rows;
}

function buildPresentedSemanticPlan(
  recommendation: AdaptiveRecommendationResultV1,
  primaryPlanAction: AdaptivePlanActionV1 | undefined,
): readonly AdaptivePresentedPlanItem[] {
  const semantic = recommendation.planActions;
  if (semantic && semantic.length > 0) {
    const seen = new Set<string>();
    return [...semantic]
      .sort((left, right) => left.sequence - right.sequence || left.planActionId.localeCompare(right.planActionId))
      .filter((action) => {
        if (seen.has(action.planActionId)) return false;
        seen.add(action.planActionId);
        return true;
      })
      .map((action) => presentPlanAction(
        action,
        primaryPlanAction?.planActionId === action.planActionId,
      ))
      .filter((entry): entry is AdaptivePresentedPlanItem => entry !== undefined);
  }

  if (recommendation.recommendedBuild.length > 0) {
    const seenItemIds = new Set<number>();
    return [...recommendation.recommendedBuild]
      .sort((left, right) => left.position - right.position || left.itemId - right.itemId)
      .filter((plannedItem) => {
        if (seenItemIds.has(plannedItem.itemId)) return false;
        seenItemIds.add(plannedItem.itemId);
        return true;
      })
      .map((plannedItem) => presentRecommendedBuildItem(
        plannedItem,
        recommendation,
        primaryPlanAction,
      ));
  }

  return [];
}

function presentRecommendedBuildItem(
  plannedItem: AdaptivePlannedItemV1,
  recommendation: AdaptiveRecommendationResultV1,
  primaryPlanAction: AdaptivePlanActionV1 | undefined,
): AdaptivePresentedPlanItem {
  const currentAction = plannedItem.status === 'NEXT'
    && primaryPlanAction
    && resolvePlanActionItemId(primaryPlanAction) === plannedItem.itemId
    ? primaryPlanAction
    : undefined;
  const status: AdaptivePlanActionStatusV1 = plannedItem.status === 'OWNED'
    ? 'OWNED'
    : plannedItem.status === 'PLANNED'
      ? 'PLANNED'
      : currentAction?.status ?? 'READY';
  const replacedItem = currentAction?.action.type === 'REPLACE'
    ? presentActionSellItem(currentAction.action)
    : undefined;

  return {
    planActionId: currentAction?.planActionId
      ?? `build:${plannedItem.position}:${plannedItem.itemId}`,
    item: presentItem(plannedItem.itemId),
    position: plannedItem.position,
    status,
    statusLabel: BUILD_STATUS_LABELS[plannedItem.status],
    actionLabel: plannedItem.status === 'OWNED'
      ? 'Owned'
      : plannedItem.status === 'PLANNED'
        ? 'Planned'
        : humanizeActionType(recommendation.nextAction.type),
    requirements: currentAction?.requirements.map(presentRequirement) ?? [],
    sourceItems: currentAction?.sourceItemIds.map(presentItem) ?? [],
    replacedItem,
    situationalPurposeLabel: presentSituationalPurpose(currentAction?.situational),
    againstLabel: presentAgainst(currentAction?.situational),
    isCurrent: plannedItem.status === 'NEXT',
  };
}

function presentPlanAction(
  action: AdaptivePlanActionV1,
  isCurrentAction: boolean,
): AdaptivePresentedPlanItem | undefined {
  const itemId = resolvePlanActionItemId(action);
  if (itemId === undefined) return undefined;
  const replacedItem = action.action.type === 'REPLACE'
    ? presentActionSellItem(action.action)
    : undefined;

  return {
    planActionId: action.planActionId,
    item: presentItem(itemId),
    position: action.sequence,
    status: action.status,
    statusLabel: PLAN_ACTION_STATUS_LABELS[action.status],
    actionLabel: action.status === 'OWNED'
      ? 'Owned'
      : isCurrentAction
        ? humanizeActionType(action.action.type)
        : 'Planned',
    requirements: action.requirements.map(presentRequirement),
    sourceItems: action.sourceItemIds.map(presentItem),
    replacedItem,
    situationalPurposeLabel: presentSituationalPurpose(action.situational),
    againstLabel: presentAgainst(action.situational),
    isCurrent: isCurrentAction,
  };
}

function resolveCurrentPlanAction(
  recommendation: AdaptiveRecommendationResultV1,
): AdaptivePlanActionV1 | undefined {
  const planActions = [...(recommendation.planActions ?? [])]
    .sort((left, right) => left.sequence - right.sequence || left.planActionId.localeCompare(right.planActionId));
  if (planActions.length === 0) return undefined;

  const exact = planActions.find(
    (planAction) => planAction.action.actionKey === recommendation.nextAction.actionKey,
  );
  if (exact) return exact;

  const primaryItemId = resolveActionItemId(
    recommendation.nextAction,
    recommendation.nextTargetItemId,
  );
  if (primaryItemId === undefined) return undefined;

  return planActions.find(
    (planAction) => (
      planAction.status === 'READY' || planAction.status === 'BLOCKED'
    ) && resolvePlanActionItemId(planAction) === primaryItemId,
  ) ?? planActions.find(
    (planAction) => resolvePlanActionItemId(planAction) === primaryItemId,
  );
}

function resolvePlanActionItemId(action: AdaptivePlanActionV1): number | undefined {
  const value = action.targetItemId
    ?? resolveActionItemId(action.action)
    ?? action.sourceItemIds[0];
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function presentRequirement(requirement: AdaptivePlanRequirementV1): string {
  switch (requirement.type) {
    case 'SOULS':
      return requirement.evidence === 'UNKNOWN'
        ? `Need ${formatSouls(requirement.requiredSouls)} souls - current souls unknown`
        : `Save until ${formatSouls(requirement.requiredSouls)} souls`;
    case 'FLEX_SLOT':
      return requirement.evidence === 'UNKNOWN'
        ? 'Requires flex slot - unlock state unknown'
        : `Requires ${requirement.requiredFlexSlots} flex slot${requirement.requiredFlexSlots === 1 ? '' : 's'}`;
    case 'SELL_ITEM':
      return `Sell ${describeItem(presentItem(requirement.itemId), `item #${requirement.itemId}`)} before purchase`;
    case 'UPGRADE_COMPONENT': {
      const names = requirement.itemIds.map((itemId) => describeItem(presentItem(itemId), `item #${itemId}`));
      return `Upgrade ${names.join(' + ')}`;
    }
    case 'SHOP_OPPORTUNITY':
      return requirement.evidence === 'UNKNOWN'
        ? 'Wait for a confirmed shop opportunity'
        : requirement.available === false
          ? 'Reach the shop before purchase'
          : 'Shop available';
  }
}

function presentSituationalPurpose(context: AdaptiveSituationalContextV1 | undefined): string | undefined {
  if (!context) return undefined;
  return SITUATIONAL_PURPOSE_LABELS[context.purpose] ?? humanizeReasonCode(context.purpose);
}

function presentAgainst(context: AdaptiveSituationalContextV1 | undefined): string | undefined {
  if (!context) return undefined;
  const names = [...context.targetEnemies]
    .filter((target) => Number.isFinite(target.score) && target.score > 0 && Number.isFinite(target.confidence) && target.confidence > 0)
    .sort((left, right) => {
      const role = targetRoleOrder(left.role) - targetRoleOrder(right.role);
      if (role !== 0) return role;
      if (right.score !== left.score) return right.score - left.score;
      if (right.confidence !== left.confidence) return right.confidence - left.confidence;
      return left.enemyHeroId - right.enemyHeroId;
    })
    .map((target) => target.enemyHeroName?.trim() || getAdaptiveHeroDisplayName(target.enemyHeroId))
    .filter((name): name is string => Boolean(name));
  const unique = [...new Set(names)];
  return unique.length > 0 ? `vs ${unique.join(', ')}` : undefined;
}

function targetRoleOrder(role: 'PRIMARY' | 'SECONDARY'): number {
  return role === 'PRIMARY' ? 0 : 1;
}

function resolveActionItemId(
  action: AdaptiveActionV1,
  fallbackItemId?: number,
): number | undefined {
  const value = action.buyItemId
    ?? action.itemId
    ?? action.targetItemId
    ?? action.sellItemId
    ?? fallbackItemId;
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function presentItem(itemId: number): AdaptivePresentedItem {
  const catalogItem: AdaptiveItemCatalogEntry | undefined = ADAPTIVE_ITEM_CATALOG[itemId];
  if (!catalogItem) {
    return {
      id: itemId,
      name: 'Unknown item',
      slot: 'unknown',
      diagnosticLabel: `#${itemId}`,
      known: false,
    };
  }

  return {
    id: itemId,
    name: catalogItem.name,
    slot: catalogItem.slot,
    costLabel: `${catalogItem.cost.toLocaleString('en-US')} souls`,
    tierLabel: `Tier ${catalogItem.tier}`,
    known: true,
  };
}

function buildHeadline(
  action: AdaptiveActionV1,
  item: AdaptivePresentedItem | undefined,
  replacedItem?: AdaptivePresentedItem,
): string {
  const itemName = item?.known ? item.name : undefined;
  switch (action.type) {
    case 'BUY':
      return itemName ? `Buy ${itemName}` : 'Choose the next item';
    case 'UPGRADE':
      return itemName ? `Upgrade to ${itemName}` : 'Upgrade the current item';
    case 'SELL':
      return itemName ? `Sell ${itemName}` : 'Free a flex slot';
    case 'REPLACE':
      return describeReplacement(replacedItem, item);
    case 'HOLD':
      return itemName ? `Hold for ${itemName}` : 'Hold your souls';
    case 'WAIT':
      return itemName ? `Wait for ${itemName}` : 'Wait before buying';
    case 'CONTINUE_CORE':
      return itemName ? `Continue toward ${itemName}` : 'Continue the core build';
    case 'ABSTAIN':
      return 'No safe purchase yet';
  }
}

function buildAlternatives(
  recommendation: AdaptiveRecommendationResultV1,
  primaryItemId: number | undefined,
): readonly AdaptivePresentedAlternative[] {
  const alternatives: AdaptivePresentedAlternative[] = [];
  const seen = new Set<string>();

  for (const candidate of recommendation.rankedImmediateCandidates) {
    const itemId = resolveActionItemId(candidate.action);
    const key = itemId === undefined
      ? `action:${candidate.action.type}`
      : `item:${itemId}`;
    if (
      candidate.action.actionKey === recommendation.nextAction.actionKey
      || itemId === primaryItemId
      || seen.has(key)
    ) {
      continue;
    }

    seen.add(key);
    const item = itemId === undefined ? undefined : presentItem(itemId);
    const replacedItem = candidate.action.type === 'REPLACE'
      ? presentActionSellItem(candidate.action)
      : undefined;
    alternatives.push({
      actionLabel: humanizeActionType(candidate.action.type),
      headline: buildHeadline(candidate.action, item, replacedItem),
      item,
      replacedItem,
      scoreLabel: `${toPercent(candidate.score)}% fit`,
    });
    if (alternatives.length === ALTERNATIVE_DISPLAY_LIMIT) {
      break;
    }
  }

  return alternatives;
}

function presentActionSellItem(action: AdaptiveActionV1): AdaptivePresentedItem | undefined {
  return Number.isSafeInteger(action.sellItemId) && Number(action.sellItemId) > 0
    ? presentItem(Number(action.sellItemId))
    : undefined;
}

function describeReplacement(
  replacedItem: AdaptivePresentedItem | undefined,
  targetItem: AdaptivePresentedItem | undefined,
): string {
  const from = describeItem(replacedItem, 'a weaker item');
  const to = describeItem(targetItem, 'a stronger item');
  return `Sell ${from} - Buy ${to}`;
}

function describeItem(item: AdaptivePresentedItem | undefined, fallback: string): string {
  if (!item) return fallback;
  return item.known ? item.name : `item ${item.diagnosticLabel}`;
}

function humanizeActionType(type: AdaptiveActionTypeV1): string {
  return {
    BUY: 'Buy now',
    UPGRADE: 'Upgrade',
    SELL: 'Sell',
    REPLACE: 'Replace',
    WAIT: 'Wait',
    HOLD: 'Hold',
    CONTINUE_CORE: 'Core path',
    ABSTAIN: 'Stand by',
  }[type];
}

function confidenceLabel(type: AdaptiveActionTypeV1, value: number): string {
  if (value === 0 && (type === 'HOLD' || type === 'WAIT' || type === 'ABSTAIN')) {
    return type === 'HOLD' ? 'Safe hold' : 'Safe fallback';
  }
  return `${value}% confidence`;
}

function humanizeReasonCode(code: string): string {
  if (REASON_LABELS[code]) return REASON_LABELS[code];
  const normalized = code.trim().toLowerCase().replace(/[_-]+/g, ' ');
  return normalized
    ? normalized.charAt(0).toUpperCase() + normalized.slice(1)
    : 'Recommendation updated';
}

function formatSouls(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString('en-US');
}

function toPercent(value: number): number {
  const finite = Number.isFinite(Number(value)) ? Number(value) : 0;
  return Math.round(Math.max(0, Math.min(1, finite)) * 100);
}
