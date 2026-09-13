import { Injectable } from '@nestjs/common';
import { RecommendationItemGraph } from '@deadlock-live-probe/build-domain';
import { BuildArchetypeRoleV2, BuildArchetypeV2 } from './build-archetype-v2';
import {
  BuildItemUtilityV2,
  BuildItemUtilityV2Service,
  BuildTransitionCostV2,
} from './build-item-utility-v2.service';
import { EnemyThreatScoreV1 } from './enemy-threat-v1.service';
import {
  StatlockerT4ChainsV1,
  StatlockerWpaPatchDataV1,
} from './statlocker-adaptive.types';
import { STATLOCKER_BUILD_V2_CONFIG } from './statlocker-build-v2.config';
import { StatlockerVsHeroWpaAggregateSourceV1 } from './statlocker-vs-hero-wpa-repository-v1.service';

export interface FullBuildInventoryUtilityV2 {
  total: number;
  confidence: number;
  itemUtilities: readonly BuildItemUtilityV2[];
}

export interface FullBuildTransitionValueV2Input {
  heroId: number;
  archetype: BuildArchetypeV2;
  itemGraph: RecommendationItemGraph;
  gameTimeSec: number;
  currentInventoryItemIds: readonly number[];
  resultingInventoryItemIds: readonly number[];
  targetItemId: number;
  enemyHeroIds: readonly number[];
  enemyThreats: readonly EnemyThreatScoreV1[];
  vsHeroRows: readonly StatlockerVsHeroWpaAggregateSourceV1[];
  wpaPatchData?: StatlockerWpaPatchDataV1;
  t4Chains?: StatlockerT4ChainsV1;
  transition?: Partial<BuildTransitionCostV2>;
}

export interface FullBuildTransitionValueV2Result {
  currentState: FullBuildInventoryUtilityV2;
  resultingState: FullBuildInventoryUtilityV2;
  marginalGain: number;
  confidence: number;
}

@Injectable()
export class FullBuildTransitionValueV2Service {
  constructor(private readonly itemUtility: BuildItemUtilityV2Service) {}

  evaluate(input: FullBuildTransitionValueV2Input): FullBuildTransitionValueV2Result {
    const currentState = this.scoreInventory(input.currentInventoryItemIds, input);
    const resultingState = this.scoreInventory(
      input.resultingInventoryItemIds,
      input,
      input.targetItemId,
      input.transition,
    );
    return {
      currentState,
      resultingState,
      marginalGain: roundUtility(resultingState.total - currentState.total),
      confidence: resultingState.confidence,
    };
  }

  scoreCurrentInventory(input: Omit<
    FullBuildTransitionValueV2Input,
    'resultingInventoryItemIds' | 'targetItemId' | 'transition'
  >): FullBuildInventoryUtilityV2 {
    return this.scoreInventory(input.currentInventoryItemIds, input);
  }

  scoreResultingInventory(
    input: FullBuildTransitionValueV2Input,
  ): FullBuildInventoryUtilityV2 {
    return this.scoreInventory(
      input.resultingInventoryItemIds,
      input,
      input.targetItemId,
      input.transition,
    );
  }

  private scoreInventory(
    itemIds: readonly number[],
    input: Pick<
      FullBuildTransitionValueV2Input,
      | 'heroId'
      | 'archetype'
      | 'gameTimeSec'
      | 'enemyHeroIds'
      | 'enemyThreats'
      | 'vsHeroRows'
      | 'wpaPatchData'
      | 't4Chains'
    >,
    transitionTargetItemId?: number,
    transition?: Partial<BuildTransitionCostV2>,
  ): FullBuildInventoryUtilityV2 {
    const normalizedItemIds = [...itemIds].sort((a, b) => a - b);
    const itemUtilities: BuildItemUtilityV2[] = [];
    let transitionApplied = false;
    for (const itemId of normalizedItemIds) {
      const applyTransition = !transitionApplied && itemId === transitionTargetItemId;
      const utility = this.itemUtility.scoreItem({
        heroId: input.heroId,
        itemId,
        archetype: input.archetype,
        gameTimeSec: input.gameTimeSec,
        ownedItemIds: normalizedItemIds,
        projectedItemIds: [],
        enemyHeroIds: input.enemyHeroIds,
        enemyThreats: input.enemyThreats,
        vsHeroRows: input.vsHeroRows,
        wpaPatchData: input.wpaPatchData,
        t4Chains: input.t4Chains,
        ...(applyTransition && transition ? { transition } : {}),
      });
      if (applyTransition) transitionApplied = true;
      itemUtilities.push(utility);
    }

    return {
      total: roundUtility(itemUtilities.reduce((sum, utility) => sum + utility.total, 0)),
      confidence: itemUtilities.length === 0
        ? 0
        : roundUtility(
            itemUtilities.reduce((sum, utility) => sum + utility.confidence, 0) / itemUtilities.length,
          ),
      itemUtilities,
    };
  }
}

export function replacementImprovementThreshold(
  soldRole: BuildArchetypeRoleV2 | undefined,
): number {
  const config = STATLOCKER_BUILD_V2_CONFIG.fullBuildResolver;
  return soldRole === 'CORE'
    ? config.coreReplacementMinImprovement
    : config.replacementMinImprovement;
}

function roundUtility(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1_000_000) / 1_000_000;
}
