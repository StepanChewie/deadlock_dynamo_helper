import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ItemComponent } from './entities/item-component.entity';
import type {
  CanonicalItemAction,
  NormalizedMatchItemTimelines,
  NormalizedPlayerItemTimeline,
} from './match-timeline-normalization.service';

export const TIMELINE_RECIPE_REFRESH_INTERVAL_MS = 5 * 60_000;

interface UpgradeProposal {
  parentAction: CanonicalItemAction;
  componentSellActions: CanonicalItemAction[];
}

@Injectable()
export class RecipeAwareTimelineReconciliationService implements OnModuleInit {
  private readonly logger = new Logger(RecipeAwareTimelineReconciliationService.name);
  private componentItemIdsByParent = new Map<number, readonly number[]>();

  constructor(
    @InjectRepository(ItemComponent)
    private readonly itemComponentRepository: Repository<ItemComponent>,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.refreshRecipes();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Timeline reconciliation started without recipes: ${message}`);
    }
  }

  @Interval('recipe-aware-timeline-reconciliation-refresh', TIMELINE_RECIPE_REFRESH_INTERVAL_MS)
  refreshOnInterval(): void {
    void this.refreshRecipes().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to refresh timeline recipes: ${message}`);
    });
  }

  async refreshRecipes(): Promise<number> {
    const rows = await this.itemComponentRepository.find({
      order: {
        parentItemId: 'ASC',
        componentOrder: 'ASC',
      },
    });
    const nextRecipes = new Map<number, number[]>();

    for (const row of rows) {
      const parentItemId = Number(row.parentItemId);
      const componentItemId = Number(row.componentItemId);
      if (
        !Number.isSafeInteger(parentItemId) ||
        parentItemId <= 0 ||
        !Number.isSafeInteger(componentItemId) ||
        componentItemId <= 0 ||
        parentItemId === componentItemId
      ) {
        continue;
      }

      const componentItemIds = nextRecipes.get(parentItemId) ?? [];
      componentItemIds.push(componentItemId);
      nextRecipes.set(parentItemId, componentItemIds);
    }

    this.componentItemIdsByParent = new Map<number, readonly number[]>(
      [...nextRecipes.entries()].map(
        ([parentItemId, componentItemIds]): [number, readonly number[]] => [
          parentItemId,
          [...componentItemIds],
        ],
      ),
    );
    this.logger.log(
      `Loaded ${this.componentItemIdsByParent.size} item recipes for historical timeline reconciliation.`,
    );
    return this.componentItemIdsByParent.size;
  }

  getComponentItemIds(parentItemId: number): readonly number[] {
    return this.componentItemIdsByParent.get(parentItemId) ?? [];
  }

  reconcileMatch(timelines: NormalizedMatchItemTimelines): NormalizedMatchItemTimelines {
    const players = timelines.players.map((player) => this.reconcilePlayer(player));

    return {
      ...timelines,
      players,
      actionCount: players.reduce((total, player) => total + player.actions.length, 0),
      diagnosticCount: players.reduce((total, player) => total + player.diagnostics.length, 0),
      upgradeCount: players.reduce(
        (total, player) =>
          total + player.actions.filter((action) => action.type === 'UPGRADE').length,
        0,
      ),
    };
  }

  reconcilePlayer(timeline: NormalizedPlayerItemTimeline): NormalizedPlayerItemTimeline {
    if (this.componentItemIdsByParent.size === 0 || timeline.actions.length === 0) {
      return timeline;
    }

    const actionsByTime = groupActionsByTime(timeline.actions);
    const heldInstanceIds = new Set<string>();
    const reconciledActions: CanonicalItemAction[] = [];

    for (const actionsAtTime of actionsByTime) {
      const availableInstanceIds = new Set(heldInstanceIds);
      for (const action of actionsAtTime) {
        if (action.type === 'BUY' || action.type === 'REBUY') {
          availableInstanceIds.add(action.instanceId);
        }
      }

      const proposals = this.buildUpgradeProposals(actionsAtTime, availableInstanceIds);
      const acceptedProposals = selectUnambiguousProposals(proposals);
      const proposalByParentInstanceId = new Map<string, UpgradeProposal>(
        acceptedProposals.map(
          (proposal): [string, UpgradeProposal] => [
            proposal.parentAction.instanceId,
            proposal,
          ],
        ),
      );
      const consumedSellInstanceIds = new Set<string>(
        acceptedProposals.flatMap((proposal) =>
          proposal.componentSellActions.map((action) => action.instanceId),
        ),
      );

      for (const action of actionsAtTime) {
        if (action.type === 'SELL' && consumedSellInstanceIds.has(action.instanceId)) {
          continue;
        }

        const proposal = proposalByParentInstanceId.get(action.instanceId);
        if ((action.type === 'BUY' || action.type === 'REBUY') && proposal) {
          reconciledActions.push({
            ...action,
            type: 'UPGRADE',
            consumedComponentItemIds: proposal.componentSellActions.map(
              (component) => component.itemId,
            ),
            consumedComponentInstanceIds: proposal.componentSellActions.map(
              (component) => component.instanceId,
            ),
            evidence: 'recipeGraph',
            evidenceLevel: 'DERIVED',
            confidence: 1,
          });
          continue;
        }

        reconciledActions.push(action);
      }

      for (const action of actionsAtTime) {
        if (action.type === 'BUY' || action.type === 'REBUY') {
          heldInstanceIds.add(action.instanceId);
        }
      }
      for (const action of actionsAtTime) {
        if (action.type === 'SELL') {
          heldInstanceIds.delete(action.instanceId);
        }
      }
    }

    return {
      ...timeline,
      actions: reconciledActions.map((action, index) => ({
        ...action,
        sequence: index + 1,
      })),
    };
  }

  private buildUpgradeProposals(
    actionsAtTime: CanonicalItemAction[],
    availableInstanceIds: ReadonlySet<string>,
  ): UpgradeProposal[] {
    const sellsByItemId = new Map<number, CanonicalItemAction[]>();
    for (const action of actionsAtTime) {
      if (action.type !== 'SELL' || !availableInstanceIds.has(action.instanceId)) {
        continue;
      }
      const sells = sellsByItemId.get(action.itemId) ?? [];
      sells.push(action);
      sellsByItemId.set(action.itemId, sells);
    }

    const proposals: UpgradeProposal[] = [];
    for (const action of actionsAtTime) {
      if (action.type !== 'BUY' && action.type !== 'REBUY') {
        continue;
      }

      const requiredComponentItemIds = this.componentItemIdsByParent.get(action.itemId) ?? [];
      if (requiredComponentItemIds.length === 0) {
        continue;
      }

      const componentSellActions: CanonicalItemAction[] = [];
      let complete = true;
      for (const [componentItemId, requiredCount] of countItemIds(
        requiredComponentItemIds,
      )) {
        const candidates = sellsByItemId.get(componentItemId) ?? [];
        if (candidates.length !== requiredCount) {
          complete = false;
          break;
        }
        componentSellActions.push(...candidates);
      }

      if (complete) {
        proposals.push({ parentAction: action, componentSellActions });
      }
    }

    return proposals;
  }
}

function countItemIds(itemIds: readonly number[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const itemId of itemIds) {
    counts.set(itemId, (counts.get(itemId) ?? 0) + 1);
  }
  return counts;
}

function groupActionsByTime(actions: CanonicalItemAction[]): CanonicalItemAction[][] {
  const groups: CanonicalItemAction[][] = [];
  let currentTime: number | undefined;

  for (const action of actions) {
    if (currentTime !== action.gameTimeS) {
      groups.push([]);
      currentTime = action.gameTimeS;
    }
    groups[groups.length - 1].push(action);
  }

  return groups;
}

function selectUnambiguousProposals(proposals: UpgradeProposal[]): UpgradeProposal[] {
  const proposalCountByComponentInstanceId = new Map<string, number>();
  for (const proposal of proposals) {
    for (const component of proposal.componentSellActions) {
      proposalCountByComponentInstanceId.set(
        component.instanceId,
        (proposalCountByComponentInstanceId.get(component.instanceId) ?? 0) + 1,
      );
    }
  }

  return proposals.filter((proposal) =>
    proposal.componentSellActions.every(
      (component) => proposalCountByComponentInstanceId.get(component.instanceId) === 1,
    ),
  );
}
