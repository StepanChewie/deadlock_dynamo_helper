import { Injectable } from '@nestjs/common';
import type {
  InventoryItemInstanceSnapshot,
  MatchInventoryTimelineReplay,
  PlayerInventoryTimelineReplay,
} from './inventory-timeline-replay.service';
import type { CanonicalItemActionType } from './match-timeline-normalization.service';

export const EMPTY_INVENTORY_STATE_KEY = 'EMPTY';

export type CanonicalBuildActionType = Extract<
  CanonicalItemActionType,
  'BUY' | 'REBUY' | 'UPGRADE' | 'SELL'
>;

export interface CanonicalBuildStep {
  sequence: number;
  sourceSequence: number;
  gameTimeS: number;
  actionType: CanonicalBuildActionType;
  itemId: number;
  actionKey: string;
  beforeStateKey: string;
  afterStateKey: string;
  transitionKey: string;
}

export interface CanonicalPlayerBuildSequence {
  matchId: number;
  playerId: number;
  heroId: number;
  sourceActionCount: number;
  canonicalStepCount: number;
  ignoredActionCount: number;
  replayDiagnosticCount: number;
  initialStateKey: string;
  finalStateKey: string;
  actionSequenceKey: string;
  sequenceKey: string;
  steps: CanonicalBuildStep[];
}

export interface CanonicalMatchBuildSequences {
  matchId: number;
  startTime: Date;
  playerCount: number;
  sourceActionCount: number;
  canonicalStepCount: number;
  ignoredActionCount: number;
  replayDiagnosticCount: number;
  distinctSequenceCount: number;
  players: CanonicalPlayerBuildSequence[];
}

@Injectable()
export class CanonicalBuildSequenceService {
  canonicalizeMatch(replay: MatchInventoryTimelineReplay): CanonicalMatchBuildSequences {
    const players = replay.players.map((player) => this.canonicalizePlayer(player));

    return {
      matchId: replay.matchId,
      startTime: new Date(replay.startTime),
      playerCount: players.length,
      sourceActionCount: players.reduce(
        (total, player) => total + player.sourceActionCount,
        0,
      ),
      canonicalStepCount: players.reduce(
        (total, player) => total + player.canonicalStepCount,
        0,
      ),
      ignoredActionCount: players.reduce(
        (total, player) => total + player.ignoredActionCount,
        0,
      ),
      replayDiagnosticCount: players.reduce(
        (total, player) => total + player.replayDiagnosticCount,
        0,
      ),
      distinctSequenceCount: new Set(players.map((player) => player.sequenceKey)).size,
      players,
    };
  }

  canonicalizePlayer(replay: PlayerInventoryTimelineReplay): CanonicalPlayerBuildSequence {
    const steps: CanonicalBuildStep[] = [];
    let previousHeldInstances: InventoryItemInstanceSnapshot[] = [];
    let ignoredActionCount = 0;

    for (const replayStep of replay.steps) {
      const beforeStateKey = createInventoryStateKey(previousHeldInstances);
      const afterStateKey = createInventoryStateKey(replayStep.heldInstances);
      const action = replayStep.action;

      if (isCanonicalBuildActionType(action.type)) {
        const actionKey = createCanonicalActionKey(action.type, action.itemId);
        const transitionKey = createTransitionKey(
          beforeStateKey,
          actionKey,
          afterStateKey,
        );

        steps.push({
          sequence: steps.length + 1,
          sourceSequence: replayStep.sequence,
          gameTimeS: replayStep.gameTimeS,
          actionType: action.type,
          itemId: action.itemId,
          actionKey,
          beforeStateKey,
          afterStateKey,
          transitionKey,
        });
      } else {
        ignoredActionCount += 1;
      }

      previousHeldInstances = replayStep.heldInstances;
    }

    const actionSequenceKey = steps.map((step) => step.actionKey).join('>');
    const sequenceKey = steps.map((step) => step.transitionKey).join('||');

    return {
      matchId: replay.matchId,
      playerId: replay.playerId,
      heroId: replay.heroId,
      sourceActionCount: replay.actionCount,
      canonicalStepCount: steps.length,
      ignoredActionCount,
      replayDiagnosticCount: replay.diagnosticCount,
      initialStateKey: EMPTY_INVENTORY_STATE_KEY,
      finalStateKey: createInventoryStateKey(replay.finalInventory),
      actionSequenceKey,
      sequenceKey,
      steps,
    };
  }
}

export function createInventoryStateKey(
  heldInstances: readonly InventoryItemInstanceSnapshot[],
): string {
  if (heldInstances.length === 0) {
    return EMPTY_INVENTORY_STATE_KEY;
  }

  const countByItemId = new Map<number, number>();
  for (const instance of heldInstances) {
    countByItemId.set(instance.itemId, (countByItemId.get(instance.itemId) ?? 0) + 1);
  }

  return [...countByItemId.entries()]
    .sort(([leftItemId], [rightItemId]) => leftItemId - rightItemId)
    .map(([itemId, count]) => `${itemId}x${count}`)
    .join('|');
}

export function createCanonicalActionKey(
  actionType: CanonicalBuildActionType,
  itemId: number,
): string {
  return `${actionType}:${itemId}`;
}

function createTransitionKey(
  beforeStateKey: string,
  actionKey: string,
  afterStateKey: string,
): string {
  return `${beforeStateKey}>${actionKey}>${afterStateKey}`;
}

function isCanonicalBuildActionType(
  actionType: CanonicalItemActionType,
): actionType is CanonicalBuildActionType {
  return (
    actionType === 'BUY' ||
    actionType === 'REBUY' ||
    actionType === 'UPGRADE' ||
    actionType === 'SELL'
  );
}
