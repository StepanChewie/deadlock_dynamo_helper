import { DraftMatchupEvidenceV1Service } from '../src/statlocker-adaptive/draft-matchup-evidence-v1.service';

const catalogSha256 = 'a'.repeat(64);

function evidence() {
  return {
    heroId: 6,
    rulesetVersion: 'ruleset-a',
    catalogSha256,
    statlockerPatchId: 'patch-a',
    usable: true,
    snapshotIds: ['base-snapshot'],
    degradedReasons: [],
    families: [],
    byDataset: {},
  } as any;
}

function decision() {
  return {
    state: { heroId: 6, matchId: 'match-a' },
    enemyHeroIds: [22, 11, 22],
    enemyLiveStates: [
      { steamId: 'enemy-22', heroId: 22, souls: 5000 },
      { steamId: 'enemy-11', heroId: 11, souls: 12000 },
    ],
  } as any;
}

function persistedRow(snapshotId: string, itemId: number, enemyHeroId: number) {
  return {
    id: itemId * 100 + enemyHeroId,
    snapshotId,
    statlockerPatchId: 'patch-a',
    rulesetVersion: 'ruleset-a',
    catalogSha256,
    rankBucket: 'rank_8',
    heroId: 6,
    enemyHeroId,
    itemId,
    count: 1000,
    deltaWpa: 0.01,
  };
}

function matchupScore(itemId: number) {
  return {
    raw: itemId / 10000,
    normalized: itemId / 1000,
    confidence: 0.8,
    coverage: 1,
    usedCount: 2,
    contributions: [],
  };
}

describe('DraftMatchupEvidenceV1Service', () => {
  it('queries only the current hero and full enemy set, then derives one score per returned item from smoothed threat', async () => {
    const rows = [
      persistedRow('snapshot-active', 100, 11),
      persistedRow('snapshot-active', 100, 22),
      persistedRow('snapshot-active', 200, 11),
      persistedRow('snapshot-active', 200, 22),
    ];
    const repository = {
      findActive: jest.fn(async () => rows),
    };
    const rawThreatScores = [
      { heroId: 11, steamId: 'enemy-11', threatMultiplier: 1.5 },
      { heroId: 22, steamId: 'enemy-22', threatMultiplier: 0.75 },
    ];
    const threat = {
      scoreEnemies: jest.fn(() => rawThreatScores),
    };
    const history = {
      update: jest.fn(() => [
        { score: rawThreatScores[0], smoothedThreatMultiplier: 1.3, alpha: 0.35 },
        { score: rawThreatScores[1], smoothedThreatMultiplier: 0.9, alpha: 0.35 },
      ]),
    };
    const matchup = {
      scoreItem: jest.fn((input: { itemId: number }) => matchupScore(input.itemId)),
    };
    const service = new (DraftMatchupEvidenceV1Service as any)(
      repository,
      threat,
      matchup,
      history,
    );
    const base = evidence();
    const liveDecision = decision();

    const result = await service.enrich(base, liveDecision);

    expect(repository.findActive).toHaveBeenCalledWith({
      statlockerPatchId: 'patch-a',
      rulesetVersion: 'ruleset-a',
      catalogSha256,
      ourHeroId: 6,
      enemyHeroIds: [11, 22],
    });
    expect(threat.scoreEnemies).toHaveBeenCalledWith(liveDecision.enemyLiveStates);
    expect(history.update).toHaveBeenCalledWith({
      matchId: 'match-a',
      scores: rawThreatScores,
      alpha: 0.35,
    });
    expect(matchup.scoreItem).toHaveBeenCalledTimes(2);
    expect(matchup.scoreItem).toHaveBeenNthCalledWith(1, expect.objectContaining({
      ourHeroId: 6,
      itemId: 100,
      enemyHeroIds: [11, 22],
      rows,
      enemyThreats: [
        { heroId: 11, threatMultiplier: 1.3 },
        { heroId: 22, threatMultiplier: 0.9 },
      ],
    }));
    expect(matchup.scoreItem).toHaveBeenNthCalledWith(2, expect.objectContaining({ itemId: 200 }));
    expect(result.draftMatchupSnapshotId).toBe('snapshot-active');
    expect(result.draftMatchupByItemId).toEqual({
      '100': matchupScore(100),
      '200': matchupScore(200),
    });
    expect(result.draftEnemyThreats).toEqual([
      { heroId: 11, threatMultiplier: 1.3 },
      { heroId: 22, threatMultiplier: 0.9 },
    ]);
    expect(base.draftMatchupByItemId).toBeUndefined();
  });

  it('preserves neutral skeleton-driven behavior when no relational WPA rows are active', async () => {
    const repository = { findActive: jest.fn(async () => []) };
    const rawThreatScores = [{ heroId: 11, steamId: 'enemy-11', threatMultiplier: 1.2 }];
    const threat = { scoreEnemies: jest.fn(() => rawThreatScores) };
    const history = {
      update: jest.fn(() => [{ score: rawThreatScores[0], smoothedThreatMultiplier: 1.1, alpha: 0.35 }]),
    };
    const matchup = { scoreItem: jest.fn() };
    const service = new (DraftMatchupEvidenceV1Service as any)(
      repository,
      threat,
      matchup,
      history,
    );

    const result = await service.enrich(evidence(), decision());

    expect(result.draftMatchupByItemId).toEqual({});
    expect(result.draftMatchupSnapshotId).toBeUndefined();
    expect(result.draftEnemyThreats).toEqual([{ heroId: 11, threatMultiplier: 1.1 }]);
    expect(matchup.scoreItem).not.toHaveBeenCalled();
  });

  it('fails neutral rather than taking the planner down when relational WPA querying fails', async () => {
    const repository = { findActive: jest.fn(async () => { throw new Error('db unavailable'); }) };
    const threat = { scoreEnemies: jest.fn(() => []) };
    const history = { update: jest.fn(() => []) };
    const matchup = { scoreItem: jest.fn() };
    const service = new (DraftMatchupEvidenceV1Service as any)(
      repository,
      threat,
      matchup,
      history,
    );

    const result = await service.enrich(evidence(), decision());

    expect(result.draftMatchupByItemId).toEqual({});
    expect(result.draftMatchupDegradedReason).toBe('RELATIONAL_WPA_QUERY_FAILED');
    expect(matchup.scoreItem).not.toHaveBeenCalled();
  });
});
