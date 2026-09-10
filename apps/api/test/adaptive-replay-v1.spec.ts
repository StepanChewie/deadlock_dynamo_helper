import {
  AdaptiveEvidenceScorerV1Service,
} from '../src/statlocker-adaptive/adaptive-evidence-scorer-v1.service';
import { AdaptiveBuildPlannerV1Service } from '../src/statlocker-adaptive/adaptive-build-planner-v1.service';
import {
  AdaptiveReplayV1Service,
  AdaptiveReplayInputV1,
} from '../src/statlocker-adaptive/adaptive-replay-v1.service';
import { ADAPTIVE_POLICY_V1_CONFIG } from '../src/statlocker-adaptive/statlocker-adaptive.config';

function repository() {
  const rows: any[] = [];
  return {
    rows,
    create: jest.fn((value: any) => value),
    save: jest.fn(async (value: any) => {
      rows.push(value);
      return value;
    }),
    findOne: jest.fn(async (options: any) => {
      if (options?.where?.decisionId) {
        return rows.find((row) => row.decisionId === options.where.decisionId);
      }
      const candidates = rows
        .filter((row) =>
          row.matchId === options?.where?.matchId &&
          row.playerKey === options?.where?.playerKey,
        )
        .sort((a, b) => b.decidedAt.getTime() - a.decidedAt.getTime());
      return candidates[0];
    }),
  } as any;
}

function family(dataset: string, scopeKey: string, payload: any) {
  return {
    dataset,
    scopeKey,
    snapshotId: `${dataset}-snapshot`,
    contentSha256: 'b'.repeat(64),
    fetchedAt: '2026-08-31T12:00:00.000Z',
    freshness: 'FRESH',
    confidence: 1,
    payload,
  } as any;
}

function replayInput(): AdaptiveReplayInputV1 {
  const evidence: any = {
    heroId: 10,
    rulesetVersion: 'ruleset-a',
    catalogSha256: 'a'.repeat(64),
    statlockerPatchId: '15-1',
    usable: true,
    snapshotIds: [
      'CONSENSUS_SKELETON-snapshot',
      'T4_CHAINS-snapshot',
      'VS_HERO_WPA-snapshot',
      'WPA_PATCH_DATA-snapshot',
    ].sort(),
    degradedReasons: [],
    families: [],
    byDataset: {
      WPA_PATCH_DATA: family('WPA_PATCH_DATA', 'patch:15-1', {
        patchId: '15-1',
        items: [{
          heroId: 10,
          itemId: 2,
          meanWpa: 0.2,
          sampleSize: 1000,
          wpaConfidence: 1,
          gameState: { even: 0.2 },
          purchaseTiming: { medianPurchaseSec: 700 },
        }],
      }),
      VS_HERO_WPA: family('VS_HERO_WPA', 'global', {
        slices: [{ heroId: 10, enemyHeroId: 20, items: [{ itemId: 2, deltaWpa: 0.2, count: 1000 }] }],
      }),
      T4_CHAINS: family('T4_CHAINS', 'global', {
        chains: [{ heroId: 10, itemIds: [1, 2], sampleSize: 500, meanWpa: 0.1 }],
      }),
      CONSENSUS_SKELETON: family('CONSENSUS_SKELETON', 'hero:10:consensus', {
        heroId: 10,
        profileCount: 10,
        items: [{
          itemId: 2,
          medianBuyTimeS: 700,
          strength: 0.98,
          tier: 'CORE',
          components: { coverage: 1, purchaseRate: 1, frequencyTier: 1, orderConsistency: 1, relationship: 0.8 },
        }],
      }),
      WPA_FILTERED_ITEMS: {
        dataset: 'WPA_FILTERED_ITEMS',
        scopeKey: 'hero:10',
        freshness: 'UNAVAILABLE',
        confidence: 0,
      },
    },
  };
  evidence.families = Object.values(evidence.byDataset);

  return {
    decision: {
      state: {
        decisionId: 'adaptive-replay-1',
        matchId: 'match-1',
        playerSlot: 0,
        gameTimeSec: 700,
        rulesetId: 'ruleset-a',
        heroId: 10,
        ownedItemIds: [1],
        spendableSouls: { value: 100, evidence: 'OBSERVED', source: 'test' },
        shopOpportunity: { value: 'AVAILABLE', evidence: 'OBSERVED', source: 'test' },
      },
      itemDefinitions: [
        {
          itemId: 1,
          name: 'Owned',
          slotType: 'weapon',
          active: false,
          availableRulesetIds: ['ruleset-a'],
          directPurchaseCost: 500,
          upgradeRecipes: [],
          sellTransition: { soulsRefund: 250, returnedItemIds: [] },
          maxCopies: 1,
        },
        {
          itemId: 2,
          name: 'Core',
          slotType: 'weapon',
          active: false,
          availableRulesetIds: ['ruleset-a'],
          directPurchaseCost: 3000,
          upgradeRecipes: [],
          sellTransition: { soulsRefund: 1500, returnedItemIds: [] },
          maxCopies: 1,
        },
      ],
      catalogVersionId: 'catalog-a',
      catalogSha256: 'a'.repeat(64),
      rulesetId: 'ruleset-a',
      localSteamId: 'steam-1',
      enemyHeroIds: [20],
      enemyLiveStates: [],
      ourTeamSouls: 100000,
      enemyTeamSouls: 100000,
      stateRevision: 'revision-1',
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

describe('AdaptiveReplayV1Service', () => {
  it('persists enough immutable input to reproduce the same planner output', async () => {
    const repo = repository();
    const planner = new AdaptiveBuildPlannerV1Service(new AdaptiveEvidenceScorerV1Service());
    const replay = new AdaptiveReplayV1Service(repo, planner);
    const input = replayInput();
    const original = replay.run(input);
    const result: any = {
      ready: true,
      blockers: [],
      decisionId: 'decision-persisted-1',
      stateRevision: input.decision.stateRevision,
      gameState: original.gameState,
      nextAction: original.nextAction,
      nextTargetItemId: original.recommendedBuild.find((item) => item.status === 'NEXT')?.itemId,
      recommendedBuild: original.recommendedBuild,
      changes: original.changes,
      rankedImmediateCandidates: original.rankedImmediateCandidates,
      totalScore: original.totalScore,
      confidence: original.confidence,
      scorerVersion: input.scorerVersion,
      plannerVersion: input.plannerVersion,
      configVersion: input.configVersion,
      evidence: {
        rulesetVersion: input.evidence.rulesetVersion,
        catalogSha256: input.evidence.catalogSha256,
        statlockerPatchId: input.evidence.statlockerPatchId,
        snapshotIds: input.snapshotIds,
        families: [],
        degradedReasons: [],
      },
    };

    await replay.persist({
      decisionId: result.decisionId,
      matchId: input.decision.state.matchId,
      playerKey: input.decision.localSteamId,
      stateRevision: input.decision.stateRevision,
      replayInput: input,
      result,
      decidedAt: new Date('2026-08-31T12:01:00.000Z'),
    });

    const replayed = await replay.replayDecision(result.decisionId);
    expect(replayed.nextAction).toEqual(result.nextAction);
    expect(replayed.recommendedBuild).toEqual(result.recommendedBuild);
    expect(replayed.rankedImmediateCandidates).toEqual(result.rankedImmediateCandidates);
    expect(replayed.confidence).toBe(result.confidence);
    expect(replayed.snapshotIds).toEqual(result.evidence.snapshotIds);
  });

  it('returns the latest successfully published previous plan per match/player', async () => {
    const repo = repository();
    const planner = new AdaptiveBuildPlannerV1Service(new AdaptiveEvidenceScorerV1Service());
    const replay = new AdaptiveReplayV1Service(repo, planner);
    const input = replayInput();
    const run = replay.run(input);

    for (const [index, decisionId] of ['older', 'newer'].entries()) {
      await replay.persist({
        decisionId,
        matchId: 'match-1',
        playerKey: 'steam-1',
        stateRevision: `revision-${index}`,
        replayInput: input,
        result: {
          ready: true,
          blockers: [],
          decisionId,
          stateRevision: `revision-${index}`,
          gameState: run.gameState,
          nextAction: run.nextAction,
          recommendedBuild: run.recommendedBuild,
          changes: run.changes,
          rankedImmediateCandidates: run.rankedImmediateCandidates,
          totalScore: run.totalScore + index,
          confidence: run.confidence,
          scorerVersion: input.scorerVersion,
          plannerVersion: input.plannerVersion,
          configVersion: input.configVersion,
          evidence: {
            rulesetVersion: 'ruleset-a',
            catalogSha256: 'a'.repeat(64),
            snapshotIds: input.snapshotIds,
            families: [],
            degradedReasons: [],
          },
        },
        decidedAt: new Date(`2026-08-31T12:0${index}:00.000Z`),
      });
    }

    const previous = await replay.getPreviousPlan('match-1', 'steam-1');
    expect(previous?.decisionId).toBe('newer');
    expect(previous?.totalScore).toBe(run.totalScore + 1);
  });
});
