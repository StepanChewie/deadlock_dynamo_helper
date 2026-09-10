import { AdaptiveReplayV1Service, AdaptiveReplayInputV1 } from '../src/statlocker-adaptive/adaptive-replay-v1.service';
import { ADAPTIVE_POLICY_V1_CONFIG } from '../src/statlocker-adaptive/statlocker-adaptive.config';

function baseInput(enemyHeroes?: readonly { heroId: number; heroName?: string }[]): AdaptiveReplayInputV1 {
  return {
    decision: {
      state: {
        decisionId: 'decision-1',
        matchId: 'match-1',
        playerSlot: 0,
        gameTimeSec: 100,
        rulesetId: 'ruleset-a',
        heroId: 10,
        ownedItemIds: [],
        spendableSouls: { value: 1000, evidence: 'OBSERVED', source: 'test' },
        shopOpportunity: { value: 'AVAILABLE', evidence: 'OBSERVED', source: 'test' },
      },
      itemDefinitions: [],
      catalogVersionId: 'catalog-a',
      catalogSha256: 'a'.repeat(64),
      rulesetId: 'ruleset-a',
      localSteamId: 'steam-1',
      enemyHeroIds: [20, 30],
      enemyLiveStates: [],
      ...(enemyHeroes === undefined ? {} : { enemyHeroes }),
      stateRevision: 'revision-1',
    },
    evidence: {
      heroId: 10,
      rulesetVersion: 'ruleset-a',
      catalogSha256: 'a'.repeat(64),
      statlockerPatchId: 'patch-a',
      usable: false,
      snapshotIds: [],
      degradedReasons: [],
      families: [],
      byDataset: {} as any,
    },
    recentPurchasedItemIds: [],
    recentSoldItemIds: [],
    configVersion: ADAPTIVE_POLICY_V1_CONFIG.version,
    scorerVersion: 'adaptive-evidence-scorer-v1',
    plannerVersion: 'adaptive-build-planner-v1',
    snapshotIds: [],
  };
}

describe('adaptive replay enemy hero identity', () => {
  it('reconstructs persisted enemy hero names without changing numeric identity', () => {
    const captured: any[] = [];
    const planner = {
      version: 'adaptive-build-planner-v1',
      plan: jest.fn((input: any) => {
        captured.push(input.decision);
        return {
          gameState: 'UNKNOWN',
          nextAction: { actionKey: 'WAIT', type: 'WAIT', reasonCodes: [] },
          recommendedBuild: [],
          changes: [],
          rankedImmediateCandidates: [],
          totalScore: 0,
          confidence: 0,
        };
      }),
    } as any;
    const replay = new AdaptiveReplayV1Service({} as any, planner);

    replay.run(baseInput([
      { heroId: 30, heroName: 'Enemy Thirty' },
      { heroId: 20, heroName: 'Enemy Twenty' },
    ]));

    expect(captured[0].enemyHeroIds).toEqual([20, 30]);
    expect(captured[0].enemyHeroes).toEqual([
      { heroId: 20, heroName: 'Enemy Twenty' },
      { heroId: 30, heroName: 'Enemy Thirty' },
    ]);
  });

  it('keeps older replay payloads readable by deriving unnamed heroes from enemyHeroIds', () => {
    const captured: any[] = [];
    const planner = {
      version: 'adaptive-build-planner-v1',
      plan: jest.fn((input: any) => {
        captured.push(input.decision);
        return {
          gameState: 'UNKNOWN',
          nextAction: { actionKey: 'WAIT', type: 'WAIT', reasonCodes: [] },
          recommendedBuild: [],
          changes: [],
          rankedImmediateCandidates: [],
          totalScore: 0,
          confidence: 0,
        };
      }),
    } as any;
    const replay = new AdaptiveReplayV1Service({} as any, planner);

    replay.run(baseInput());

    expect(captured[0].enemyHeroes).toEqual([{ heroId: 20 }, { heroId: 30 }]);
  });
});
