import { AdaptiveBuildPlannerV1Service } from '../src/statlocker-adaptive/adaptive-build-planner-v1.service';
import { AdaptiveEvidenceScorerV1Service } from '../src/statlocker-adaptive/adaptive-evidence-scorer-v1.service';
import {
  AdaptiveReplayInputV1,
  AdaptiveReplayV1Service,
} from '../src/statlocker-adaptive/adaptive-replay-v1.service';
import { ADAPTIVE_POLICY_V1_CONFIG } from '../src/statlocker-adaptive/statlocker-adaptive.config';

function family(dataset: string, payload: any) {
  return {
    dataset,
    scopeKey: dataset === 'CONSENSUS_SKELETON' ? 'hero:10:consensus' : 'global',
    snapshotId: `${dataset}-snapshot`,
    contentSha256: 'b'.repeat(64),
    fetchedAt: '2026-09-04T12:00:00.000Z',
    freshness: 'FRESH',
    confidence: 1,
    payload,
  } as any;
}

function candidate(itemId: number) {
  return {
    itemId,
    strength: 0.9,
    coverage: 0.9,
    purchaseRate: 0.9,
    medianBuyTimeS: 300,
    timingSpreadS: 30,
    sourceProfileCount: 10,
    frequencyTier: 'CORE',
    rushEvidence: false,
  };
}

function input(): AdaptiveReplayInputV1 {
  const byDataset = {
    WPA_PATCH_DATA: family('WPA_PATCH_DATA', { patchId: '15-1', items: [] }),
    VS_HERO_WPA: family('VS_HERO_WPA', { slices: [] }),
    T4_CHAINS: family('T4_CHAINS', { chains: [] }),
    CONSENSUS_SKELETON: family('CONSENSUS_SKELETON', {
      heroId: 10,
      profileCount: 10,
      groups: [
        {
          groupId: 'lower-core',
          phase: 'EARLY',
          type: 'REQUIRED',
          minSelect: 1,
          maxSelect: 1,
          candidates: [candidate(1)],
          confidence: 0.9,
          inferred: false,
        },
        {
          groupId: 'next-core',
          phase: 'EARLY',
          type: 'REQUIRED',
          minSelect: 1,
          maxSelect: 1,
          candidates: [candidate(3)],
          confidence: 0.9,
          inferred: false,
        },
      ],
    }),
    WPA_FILTERED_ITEMS: family('WPA_FILTERED_ITEMS', { heroId: 10, items: [] }),
  };
  const evidence: any = {
    heroId: 10,
    rulesetVersion: 'ruleset-a',
    catalogSha256: 'a'.repeat(64),
    statlockerPatchId: '15-1',
    usable: true,
    snapshotIds: Object.values(byDataset).map((entry) => entry.snapshotId).sort(),
    degradedReasons: [],
    families: Object.values(byDataset),
    byDataset,
  };

  return {
    decision: {
      state: {
        decisionId: 'adaptive-replay-lineage',
        matchId: 'match-lineage',
        playerSlot: 0,
        gameTimeSec: 700,
        rulesetId: 'ruleset-a',
        heroId: 10,
        ownedItemIds: [2],
        spendableSouls: { value: 5_000, evidence: 'OBSERVED', source: 'test' },
        shopOpportunity: { value: 'AVAILABLE', evidence: 'OBSERVED', source: 'test' },
      },
      itemDefinitions: [
        {
          itemId: 1,
          name: 'Lower component',
          slotType: 'weapon',
          active: false,
          availableRulesetIds: ['ruleset-a'],
          directPurchaseCost: 500,
          upgradeRecipes: [],
          maxCopies: 1,
        },
        {
          itemId: 2,
          name: 'Owned upgrade',
          slotType: 'weapon',
          active: false,
          availableRulesetIds: ['ruleset-a'],
          directPurchaseCost: 1_250,
          upgradeRecipes: [],
          maxCopies: 1,
        },
        {
          itemId: 3,
          name: 'Next target',
          slotType: 'vitality',
          active: false,
          availableRulesetIds: ['ruleset-a'],
          directPurchaseCost: 500,
          upgradeRecipes: [],
          maxCopies: 1,
        },
      ],
      lineageEdges: [{ parentItemId: 2, componentItemId: 1 }],
      catalogVersionId: 'catalog-a',
      catalogSha256: 'a'.repeat(64),
      rulesetId: 'ruleset-a',
      localSteamId: 'steam-1',
      enemyHeroIds: [],
      enemyLiveStates: [],
      ourTeamSouls: 100_000,
      enemyTeamSouls: 100_000,
      stateRevision: 'revision-lineage',
    },
    evidence,
    recentPurchasedItemIds: [],
    recentSoldItemIds: [],
    configVersion: ADAPTIVE_POLICY_V1_CONFIG.version,
    scorerVersion: 'adaptive-evidence-scorer-v1',
    plannerVersion: 'adaptive-build-planner-v1',
    snapshotIds: evidence.snapshotIds,
  };
}

describe('AdaptiveReplayV1 upgrade lineage', () => {
  it('reconstructs topology-only lineage and never replays the satisfied ancestor as actionable', () => {
    const planner = new AdaptiveBuildPlannerV1Service(new AdaptiveEvidenceScorerV1Service());
    const replay = new AdaptiveReplayV1Service({} as any, planner);
    const result = replay.run(input());

    expect(result.nextAction.targetItemId).not.toBe(1);
    expect(result.recommendedBuild.some((entry) =>
      entry.itemId === 1 && (entry.status === 'NEXT' || entry.status === 'PLANNED'),
    )).toBe(false);
    expect(result.rankedImmediateCandidates.some((entry) => entry.action.targetItemId === 1)).toBe(false);
  });
});
