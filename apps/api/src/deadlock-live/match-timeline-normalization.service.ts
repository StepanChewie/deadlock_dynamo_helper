import { Injectable } from '@nestjs/common';
import { RecipeAwareTimelineReconciliationService } from './recipe-aware-timeline-reconciliation.service';
import {
  RecentMatchItemSnapshot,
  RecentMatchPlayerSnapshot,
  RecentMatchSnapshot,
} from './recent-matches-window.service';

export type CanonicalItemActionType =
  | 'BUY'
  | 'UPGRADE'
  | 'SELL'
  | 'REBUY'
  | 'USE'
  | 'CONSUME'
  | 'RECONCILE'
  | 'UNKNOWN_REMOVE';

export type TimelineEvidenceLevel = 'OBSERVED' | 'DERIVED' | 'INFERRED';

export type TimelineDiagnosticCode =
  | 'INVALID_ITEM_ID'
  | 'MISSING_PURCHASE_TIME'
  | 'INVALID_PURCHASE_TIME'
  | 'INVALID_SOLD_TIME'
  | 'SOLD_BEFORE_PURCHASE';

export interface CanonicalItemAction {
  sequence: number;
  type: CanonicalItemActionType;
  gameTimeS: number;
  itemId: number;
  instanceId: string;
  sourceRowId: number;
  relatedItemId?: number;
  consumedComponentItemIds?: number[];
  consumedComponentInstanceIds?: string[];
  slotOrder?: number;
  evidence: 'purchaseTimeS' | 'soldTimeS' | 'recipeGraph';
  evidenceLevel: TimelineEvidenceLevel;
  confidence: number;
}

export interface TimelineDiagnostic {
  code: TimelineDiagnosticCode;
  sourceRowId: number;
  itemId?: number;
  details?: Record<string, number>;
}

export interface NormalizedPlayerItemTimeline {
  matchId: number;
  playerId: number;
  heroId: number;
  actions: CanonicalItemAction[];
  diagnostics: TimelineDiagnostic[];
}

export interface NormalizedMatchItemTimelines {
  matchId: number;
  startTime: Date;
  players: NormalizedPlayerItemTimeline[];
  actionCount: number;
  diagnosticCount: number;
  upgradeCount: number;
}

interface PendingAction extends Omit<CanonicalItemAction, 'sequence'> {
  insertionOrder: number;
  zeroDurationLifecycle: boolean;
}

interface PreviousPurchase {
  purchaseTimeS: number;
  soldTimeS?: number;
}

@Injectable()
export class MatchTimelineNormalizationService {
  constructor(
    private readonly recipeAwareTimelineReconciliationService?: RecipeAwareTimelineReconciliationService,
  ) {}

  normalizeMatch(match: RecentMatchSnapshot): NormalizedMatchItemTimelines {
    const players = match.players.map((player) => this.normalizeObservedPlayer(player));
    const observed: NormalizedMatchItemTimelines = {
      matchId: match.matchId,
      startTime: new Date(match.startTime),
      players,
      actionCount: players.reduce((total, player) => total + player.actions.length, 0),
      diagnosticCount: players.reduce((total, player) => total + player.diagnostics.length, 0),
      upgradeCount: 0,
    };

    return this.recipeAwareTimelineReconciliationService?.reconcileMatch(observed) ?? observed;
  }

  normalizePlayer(player: RecentMatchPlayerSnapshot): NormalizedPlayerItemTimeline {
    const observed = this.normalizeObservedPlayer(player);
    return this.recipeAwareTimelineReconciliationService?.reconcilePlayer(observed) ?? observed;
  }

  private normalizeObservedPlayer(
    player: RecentMatchPlayerSnapshot,
  ): NormalizedPlayerItemTimeline {
    const diagnostics: TimelineDiagnostic[] = [];
    const actions: PendingAction[] = [];
    const previousPurchasesByItemId = new Map<number, PreviousPurchase[]>();
    let insertionOrder = 0;

    const rows = [...player.itemPurchases].sort(compareItemRows);
    for (const row of rows) {
      const itemId = toPositiveInteger(row.itemId);
      if (itemId === undefined) {
        diagnostics.push({ code: 'INVALID_ITEM_ID', sourceRowId: row.id });
        continue;
      }

      const purchaseTimeS = toNonNegativeInteger(row.purchaseTimeS);
      if (row.purchaseTimeS === undefined) {
        diagnostics.push({
          code: 'MISSING_PURCHASE_TIME',
          sourceRowId: row.id,
          itemId,
        });
        continue;
      }
      if (purchaseTimeS === undefined) {
        diagnostics.push({
          code: 'INVALID_PURCHASE_TIME',
          sourceRowId: row.id,
          itemId,
        });
        continue;
      }

      const soldTimeS = this.resolveSoldTime(row, purchaseTimeS, itemId, diagnostics);
      const previousPurchases = previousPurchasesByItemId.get(itemId) ?? [];
      const isRebuy = previousPurchases.some(
        (previous) => previous.soldTimeS !== undefined && previous.soldTimeS <= purchaseTimeS,
      );
      const instanceId = `${player.id}:${row.id}`;
      const zeroDurationLifecycle = soldTimeS === purchaseTimeS;

      actions.push({
        type: isRebuy ? 'REBUY' : 'BUY',
        gameTimeS: purchaseTimeS,
        itemId,
        instanceId,
        sourceRowId: row.id,
        slotOrder: row.slotOrder,
        evidence: 'purchaseTimeS',
        evidenceLevel: 'OBSERVED',
        confidence: 1,
        insertionOrder: insertionOrder++,
        zeroDurationLifecycle,
      });

      if (soldTimeS !== undefined) {
        actions.push({
          type: 'SELL',
          gameTimeS: soldTimeS,
          itemId,
          instanceId,
          sourceRowId: row.id,
          slotOrder: row.slotOrder,
          evidence: 'soldTimeS',
          evidenceLevel: 'OBSERVED',
          confidence: 1,
          insertionOrder: insertionOrder++,
          zeroDurationLifecycle,
        });
      }

      previousPurchases.push({ purchaseTimeS, soldTimeS });
      previousPurchasesByItemId.set(itemId, previousPurchases);
    }

    actions.sort(compareActions);

    return {
      matchId: player.matchId,
      playerId: player.id,
      heroId: player.heroId,
      actions: actions.map(
        ({ insertionOrder: _insertionOrder, zeroDurationLifecycle: _zeroDurationLifecycle, ...action }, index) => ({
          ...action,
          sequence: index + 1,
        }),
      ),
      diagnostics,
    };
  }

  private resolveSoldTime(
    row: RecentMatchItemSnapshot,
    purchaseTimeS: number,
    itemId: number,
    diagnostics: TimelineDiagnostic[],
  ): number | undefined {
    if (row.soldTimeS === undefined || row.soldTimeS === 0) {
      return undefined;
    }

    const soldTimeS = toNonNegativeInteger(row.soldTimeS);
    if (soldTimeS === undefined) {
      diagnostics.push({
        code: 'INVALID_SOLD_TIME',
        sourceRowId: row.id,
        itemId,
      });
      return undefined;
    }

    if (soldTimeS < purchaseTimeS) {
      diagnostics.push({
        code: 'SOLD_BEFORE_PURCHASE',
        sourceRowId: row.id,
        itemId,
        details: { purchaseTimeS, soldTimeS },
      });
      return undefined;
    }

    return soldTimeS;
  }
}

function compareItemRows(left: RecentMatchItemSnapshot, right: RecentMatchItemSnapshot): number {
  const leftTime = left.purchaseTimeS ?? Number.MAX_SAFE_INTEGER;
  const rightTime = right.purchaseTimeS ?? Number.MAX_SAFE_INTEGER;
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  const leftSlot = left.slotOrder ?? Number.MAX_SAFE_INTEGER;
  const rightSlot = right.slotOrder ?? Number.MAX_SAFE_INTEGER;
  if (leftSlot !== rightSlot) {
    return leftSlot - rightSlot;
  }

  return left.id - right.id;
}

function compareActions(left: PendingAction, right: PendingAction): number {
  if (left.gameTimeS !== right.gameTimeS) {
    return left.gameTimeS - right.gameTimeS;
  }

  const typeDifference = actionPriority(left) - actionPriority(right);
  if (typeDifference !== 0) {
    return typeDifference;
  }

  return left.insertionOrder - right.insertionOrder;
}

function actionPriority(action: PendingAction): number {
  if ((action.type === 'BUY' || action.type === 'REBUY') && action.zeroDurationLifecycle) {
    return 0;
  }

  switch (action.type) {
    case 'SELL':
      return 1;
    case 'BUY':
    case 'REBUY':
      return 2;
    case 'UPGRADE':
      return 3;
    default:
      return 4;
  }
}

function toPositiveInteger(value: number | undefined): number | undefined {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function toNonNegativeInteger(value: number | undefined): number | undefined {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}
