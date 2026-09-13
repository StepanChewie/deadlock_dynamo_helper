import { Injectable } from '@nestjs/common';
import type {
  CanonicalItemAction,
  CanonicalItemActionType,
  NormalizedMatchItemTimelines,
  NormalizedPlayerItemTimeline,
} from './match-timeline-normalization.service';

export type InventoryAcquisitionType = Extract<
  CanonicalItemActionType,
  'BUY' | 'REBUY' | 'UPGRADE'
>;

export type InventoryReplayDiagnosticCode =
  | 'DUPLICATE_INSTANCE_ACQUIRE'
  | 'MISSING_REMOVE_INSTANCE'
  | 'REMOVE_ITEM_MISMATCH'
  | 'MISSING_UPGRADE_COMPONENT'
  | 'UPGRADE_COMPONENT_ITEM_MISMATCH'
  | 'UPGRADE_COMPONENTS_ABSENT'
  | 'DUPLICATE_UPGRADE_PARENT_INSTANCE'
  | 'UNSUPPORTED_RECONCILE_ACTION';

export interface InventoryItemInstanceSnapshot {
  instanceId: string;
  itemId: number;
  sourceRowId: number;
  acquiredAtS: number;
  acquiredBy: InventoryAcquisitionType;
  slotOrder?: number;
}

export interface InventoryReplayDiagnostic {
  code: InventoryReplayDiagnosticCode;
  sequence: number;
  gameTimeS: number;
  actionType: CanonicalItemActionType;
  itemId: number;
  instanceId: string;
  details?: Record<string, string | number>;
}

export interface InventoryTimelineStep {
  sequence: number;
  gameTimeS: number;
  action: CanonicalItemAction;
  heldItemCount: number;
  heldInstances: InventoryItemInstanceSnapshot[];
}

export interface PlayerInventoryTimelineReplay {
  matchId: number;
  playerId: number;
  heroId: number;
  actionCount: number;
  stepCount: number;
  diagnosticCount: number;
  finalItemCount: number;
  steps: InventoryTimelineStep[];
  finalInventory: InventoryItemInstanceSnapshot[];
  diagnostics: InventoryReplayDiagnostic[];
}

export interface MatchInventoryTimelineReplay {
  matchId: number;
  startTime: Date;
  playerCount: number;
  actionCount: number;
  stepCount: number;
  diagnosticCount: number;
  finalItemCount: number;
  players: PlayerInventoryTimelineReplay[];
}

@Injectable()
export class InventoryTimelineReplayService {
  replayMatch(timelines: NormalizedMatchItemTimelines): MatchInventoryTimelineReplay {
    const players = timelines.players.map((player) => this.replayPlayer(player));

    return {
      matchId: timelines.matchId,
      startTime: new Date(timelines.startTime),
      playerCount: players.length,
      actionCount: players.reduce((total, player) => total + player.actionCount, 0),
      stepCount: players.reduce((total, player) => total + player.stepCount, 0),
      diagnosticCount: players.reduce((total, player) => total + player.diagnosticCount, 0),
      finalItemCount: players.reduce((total, player) => total + player.finalItemCount, 0),
      players,
    };
  }

  replayPlayer(timeline: NormalizedPlayerItemTimeline): PlayerInventoryTimelineReplay {
    const heldByInstanceId = new Map<string, InventoryItemInstanceSnapshot>();
    const diagnostics: InventoryReplayDiagnostic[] = [];
    const steps: InventoryTimelineStep[] = [];

    for (const action of timeline.actions) {
      this.applyAction(action, heldByInstanceId, diagnostics);
      const heldInstances = snapshotInventory(heldByInstanceId);
      steps.push({
        sequence: action.sequence,
        gameTimeS: action.gameTimeS,
        action: cloneAction(action),
        heldItemCount: heldInstances.length,
        heldInstances,
      });
    }

    const finalInventory = snapshotInventory(heldByInstanceId);
    return {
      matchId: timeline.matchId,
      playerId: timeline.playerId,
      heroId: timeline.heroId,
      actionCount: timeline.actions.length,
      stepCount: steps.length,
      diagnosticCount: diagnostics.length,
      finalItemCount: finalInventory.length,
      steps,
      finalInventory,
      diagnostics,
    };
  }

  private applyAction(
    action: CanonicalItemAction,
    heldByInstanceId: Map<string, InventoryItemInstanceSnapshot>,
    diagnostics: InventoryReplayDiagnostic[],
  ): void {
    switch (action.type) {
      case 'BUY':
      case 'REBUY':
        this.acquire(action, action.type, heldByInstanceId, diagnostics);
        return;
      case 'SELL':
      case 'CONSUME':
      case 'UNKNOWN_REMOVE':
        this.remove(action, heldByInstanceId, diagnostics);
        return;
      case 'UPGRADE':
        this.applyUpgrade(action, heldByInstanceId, diagnostics);
        return;
      case 'USE':
        return;
      case 'RECONCILE':
        diagnostics.push(createDiagnostic('UNSUPPORTED_RECONCILE_ACTION', action));
        return;
    }
  }

  private acquire(
    action: CanonicalItemAction,
    acquiredBy: InventoryAcquisitionType,
    heldByInstanceId: Map<string, InventoryItemInstanceSnapshot>,
    diagnostics: InventoryReplayDiagnostic[],
  ): void {
    if (heldByInstanceId.has(action.instanceId)) {
      diagnostics.push(createDiagnostic('DUPLICATE_INSTANCE_ACQUIRE', action));
      return;
    }

    heldByInstanceId.set(action.instanceId, createInstance(action, acquiredBy));
  }

  private remove(
    action: CanonicalItemAction,
    heldByInstanceId: Map<string, InventoryItemInstanceSnapshot>,
    diagnostics: InventoryReplayDiagnostic[],
  ): void {
    const heldInstance = heldByInstanceId.get(action.instanceId);
    if (!heldInstance) {
      diagnostics.push(createDiagnostic('MISSING_REMOVE_INSTANCE', action));
      return;
    }

    if (heldInstance.itemId !== action.itemId) {
      diagnostics.push(
        createDiagnostic('REMOVE_ITEM_MISMATCH', action, {
          heldItemId: heldInstance.itemId,
        }),
      );
    }

    heldByInstanceId.delete(action.instanceId);
  }

  private applyUpgrade(
    action: CanonicalItemAction,
    heldByInstanceId: Map<string, InventoryItemInstanceSnapshot>,
    diagnostics: InventoryReplayDiagnostic[],
  ): void {
    if (heldByInstanceId.has(action.instanceId)) {
      diagnostics.push(createDiagnostic('DUPLICATE_UPGRADE_PARENT_INSTANCE', action));
      return;
    }

    const componentInstanceIds = [...new Set(action.consumedComponentInstanceIds ?? [])];
    const componentItemIds = action.consumedComponentItemIds ?? [];

    if (componentInstanceIds.length === 0) {
      diagnostics.push(createDiagnostic('UPGRADE_COMPONENTS_ABSENT', action));
    }

    for (const [index, componentInstanceId] of componentInstanceIds.entries()) {
      const heldComponent = heldByInstanceId.get(componentInstanceId);
      const expectedComponentItemId = componentItemIds[index];
      if (!heldComponent) {
        const details: Record<string, string | number> = { componentInstanceId };
        if (expectedComponentItemId !== undefined) {
          details.expectedComponentItemId = expectedComponentItemId;
        }
        diagnostics.push(createDiagnostic('MISSING_UPGRADE_COMPONENT', action, details));
        continue;
      }

      if (
        expectedComponentItemId !== undefined &&
        heldComponent.itemId !== expectedComponentItemId
      ) {
        diagnostics.push(
          createDiagnostic('UPGRADE_COMPONENT_ITEM_MISMATCH', action, {
            componentInstanceId,
            expectedComponentItemId,
            heldComponentItemId: heldComponent.itemId,
          }),
        );
      }

      heldByInstanceId.delete(componentInstanceId);
    }

    heldByInstanceId.set(action.instanceId, createInstance(action, 'UPGRADE'));
  }
}

function createInstance(
  action: CanonicalItemAction,
  acquiredBy: InventoryAcquisitionType,
): InventoryItemInstanceSnapshot {
  return {
    instanceId: action.instanceId,
    itemId: action.itemId,
    sourceRowId: action.sourceRowId,
    acquiredAtS: action.gameTimeS,
    acquiredBy,
    slotOrder: action.slotOrder,
  };
}

function createDiagnostic(
  code: InventoryReplayDiagnosticCode,
  action: CanonicalItemAction,
  details?: Record<string, string | number>,
): InventoryReplayDiagnostic {
  return {
    code,
    sequence: action.sequence,
    gameTimeS: action.gameTimeS,
    actionType: action.type,
    itemId: action.itemId,
    instanceId: action.instanceId,
    details,
  };
}

function snapshotInventory(
  heldByInstanceId: ReadonlyMap<string, InventoryItemInstanceSnapshot>,
): InventoryItemInstanceSnapshot[] {
  return [...heldByInstanceId.values()]
    .map((instance) => ({ ...instance }))
    .sort((left, right) => {
      if (left.itemId !== right.itemId) {
        return left.itemId - right.itemId;
      }
      if (left.acquiredAtS !== right.acquiredAtS) {
        return left.acquiredAtS - right.acquiredAtS;
      }
      return left.instanceId.localeCompare(right.instanceId);
    });
}

function cloneAction(action: CanonicalItemAction): CanonicalItemAction {
  return {
    ...action,
    consumedComponentItemIds: action.consumedComponentItemIds
      ? [...action.consumedComponentItemIds]
      : undefined,
    consumedComponentInstanceIds: action.consumedComponentInstanceIds
      ? [...action.consumedComponentInstanceIds]
      : undefined,
  };
}
