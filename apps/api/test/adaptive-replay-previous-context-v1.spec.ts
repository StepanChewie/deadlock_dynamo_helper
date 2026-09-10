import { AdaptiveEvidenceScorerV1Service } from '../src/statlocker-adaptive/adaptive-evidence-scorer-v1.service';
import { AdaptiveBuildPlannerV1Service } from '../src/statlocker-adaptive/adaptive-build-planner-v1.service';
import { AdaptiveReplayV1Service } from '../src/statlocker-adaptive/adaptive-replay-v1.service';

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
      const candidates = rows
        .filter((row) => row.matchId === options?.where?.matchId && row.playerKey === options?.where?.playerKey)
        .sort((a, b) => b.decidedAt.getTime() - a.decidedAt.getTime());
      return candidates[0];
    }),
  } as any;
}

const previousResult: any = {
  ready: true,
  blockers: [],
  decisionId: 'previous',
  stateRevision: 'revision-previous',
  gameState: 'EVEN',
  nextAction: { actionKey: 'HOLD', type: 'HOLD', reasonCodes: [] },
  recommendedBuild: [],
  changes: [],
  rankedImmediateCandidates: [],
  totalScore: 0,
  confidence: 0.5,
  scorerVersion: 'adaptive-evidence-scorer-v1',
  plannerVersion: 'adaptive-build-planner-v1',
  configVersion: 'adaptive-policy-v1',
  evidence: { rulesetVersion: 'r1', catalogSha256: 'a'.repeat(64), snapshotIds: [], families: [], degradedReasons: [] },
};

const replayInput: any = {
  decision: {
    state: {
      decisionId: 'previous', matchId: 'match-1', playerSlot: 0, gameTimeSec: 100,
      rulesetId: 'r1', heroId: 1, ownedItemIds: [1, 2],
      spendableSouls: { evidence: 'UNKNOWN', source: 'test' },
      shopOpportunity: { evidence: 'UNKNOWN', source: 'test' },
    },
    itemDefinitions: [], catalogVersionId: 'c', catalogSha256: 'a'.repeat(64), rulesetId: 'r1',
    localSteamId: 'steam-1', enemyHeroIds: [], enemyLiveStates: [], stateRevision: 'revision-previous',
  },
  evidence: { snapshotIds: [] },
  recentPurchasedItemIds: [], recentSoldItemIds: [],
  configVersion: 'adaptive-policy-v1', scorerVersion: 'adaptive-evidence-scorer-v1', plannerVersion: 'adaptive-build-planner-v1', snapshotIds: [],
};

describe('AdaptiveReplayV1Service previous context', () => {
  it('returns both the previous result and immutable replay input for delta reconstruction', async () => {
    const repo = repository();
    const planner = new AdaptiveBuildPlannerV1Service(new AdaptiveEvidenceScorerV1Service());
    const replay = new AdaptiveReplayV1Service(repo, planner);

    await replay.persist({
      decisionId: 'previous', matchId: 'match-1', playerKey: 'steam-1', stateRevision: 'revision-previous',
      replayInput, result: previousResult, decidedAt: new Date('2026-09-05T10:00:00.000Z'),
    });

    const context = await replay.getPreviousContext('match-1', 'steam-1');

    expect(context?.result.decisionId).toBe('previous');
    expect(context?.replayInput.decision.state.ownedItemIds).toEqual([1, 2]);
  });

  it('keeps getPreviousPlan as a compatibility wrapper', async () => {
    const repo = repository();
    const planner = new AdaptiveBuildPlannerV1Service(new AdaptiveEvidenceScorerV1Service());
    const replay = new AdaptiveReplayV1Service(repo, planner);
    await replay.persist({
      decisionId: 'previous', matchId: 'match-1', playerKey: 'steam-1', stateRevision: 'revision-previous',
      replayInput, result: previousResult, decidedAt: new Date('2026-09-05T10:00:00.000Z'),
    });

    expect((await replay.getPreviousPlan('match-1', 'steam-1'))?.decisionId).toBe('previous');
  });
});
