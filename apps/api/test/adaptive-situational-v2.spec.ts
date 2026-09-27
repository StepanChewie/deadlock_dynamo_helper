import { AdaptiveSituationalV2Service } from '../src/statlocker-adaptive/adaptive-situational-v2.service';

const REQUEST = { matchId: 'match-1', localSteamId: 'steam-1' };

// Mirrors the real `AdaptiveRecommendationLockContextV2`: `lock` is the stored
// `BuildArchetypeMatchLockV2Entity` (whose `lockedAt` is a Date, because
// `lockSummary()` calls `toISOString()` on it), and the selection mode lives on
// `selection.mode` — the entity has no `selectionMode` field.
function contextWith(selectionMode: 'VS_HERO_WPA' | 'OFFLINE_DEFAULT') {
  return {
    lock: {
      matchId: 'match-1',
      steamId: 'steam-1',
      heroId: 13,
      archetypeId: 'archetype-1',
      snapshotId: 'snapshot-1',
      enemyHeroIds: [7, 8, 9, 10, 11, 12],
      degradedReasons: [],
      lockedAt: new Date('2026-09-27T10:00:00.000Z'),
    },
    snapshot: {
      archetypes: [{ archetypeId: 'archetype-1', items: [{ itemId: 101, familyId: 1, role: 'CORE' }] }],
    },
    selection: { mode: selectionMode },
    enemyHeroIds: [7, 8, 9, 10, 11, 12],
    evidence: {},
    vsHeroRows: [],
    trace: { record: jest.fn() },
  };
}

function decisionStub() {
  return {
    state: {
      decisionId: 'decision-1',
      heroId: 13,
      inventory: { heldByItemId: new Map([[201, {}]]) },
    },
    itemGraph: { getAllItems: () => [] },
    rulesetId: 'ruleset-1',
    stateRevision: 'rev-1',
    // One enemy with a live state and the rest without, so the roster mapping
    // below is pinned on both of its branches.
    enemyLiveStates: [{ steamId: 'enemy-live-7', heroId: 7 }],
  };
}

function build(overrides: {
  ok?: boolean;
  context?: unknown;
  selection?: readonly unknown[];
} = {}) {
  const resolveLockContext = jest.fn(async () => (overrides.ok === false
    ? { ok: false, decision: decisionStub(), blockers: ['ENEMY_ROSTER_INCOMPLETE'] }
    : { ok: true, decision: decisionStub(), context: overrides.context ?? contextWith('VS_HERO_WPA') }));
  const select = jest.fn(() => overrides.selection ?? []);
  const scoreEnemies = jest.fn(() => []);
  const service = new AdaptiveSituationalV2Service(
    { resolveLockContext } as never,
    { select } as never,
    { scoreEnemies } as never,
  );
  return { service, select, resolveLockContext, scoreEnemies };
}

describe('AdaptiveSituationalV2Service', () => {
  it('returns the selection as situational items and marks the mode', async () => {
    const { service, select, scoreEnemies } = build({
      selection: [{ itemId: 101, score: 0.5, confidence: 0.6, coverage: 1, against: [{ enemyHeroId: 7, deltaWpa: 0.1, count: 100 }] }],
    });

    const result = await service.recommend(REQUEST);

    expect(result.mode).toBe('situational');
    expect(result.ready).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.situationalItems).toEqual([
      { itemId: 101, score: 0.5, confidence: 0.6, coverage: 1, against: [{ enemyHeroId: 7, deltaWpa: 0.1, count: 100 }] },
    ]);
    expect(result.stateRevision).toBe('rev-1');
    expect(result.heroId).toBe(13);
    // The lock summary is the shared one, so it must carry the entity's fields
    // and the selection's mode, not a re-derived copy.
    expect(result.lock).toMatchObject({
      matchId: 'match-1',
      heroId: 13,
      archetypeId: 'archetype-1',
      selectionMode: 'VS_HERO_WPA',
      lockedAt: '2026-09-27T10:00:00.000Z',
    });
    // The selection is fed the decision's hero, ruleset, owned items and the
    // context's roster — the wiring the ranking silently depends on.
    expect(select).toHaveBeenCalledWith(expect.objectContaining({
      heroId: 13,
      rulesetId: 'ruleset-1',
      ownedItemIds: [201],
      enemyHeroIds: [7, 8, 9, 10, 11, 12],
    }));
    // Threat weights must come from the same roster mapping the full-build mode
    // uses, or the two modes could rank the same enemies differently. This pins
    // the copy of that mapping: live states win, the rest fall back in roster
    // order to the synthetic `enemy-hero:<id>` identity.
    expect(scoreEnemies).toHaveBeenCalledWith([
      { steamId: 'enemy-live-7', heroId: 7 },
      { steamId: 'enemy-hero:8', heroId: 8 },
      { steamId: 'enemy-hero:9', heroId: 9 },
      { steamId: 'enemy-hero:10', heroId: 10 },
      { steamId: 'enemy-hero:11', heroId: 11 },
      { steamId: 'enemy-hero:12', heroId: 12 },
    ]);
  });

  it('is not ready when the lock resolved to the offline default', async () => {
    // A non-empty selection on purpose: the offline default must refuse even
    // when candidates exist, not merely happen to come back empty.
    const { service, select } = build({
      context: contextWith('OFFLINE_DEFAULT'),
      selection: [{ itemId: 101, score: 0.5, confidence: 0.6, coverage: 1, against: [] }],
    });

    const result = await service.recommend(REQUEST);

    expect(result.ready).toBe(false);
    expect(result.blockers).toContain('SITUATIONAL_EVIDENCE_UNAVAILABLE');
    expect(result.situationalItems).toEqual([]);
    expect(select).not.toHaveBeenCalled();
  });

  it('is not ready, not ready-with-an-empty-list, when nothing passes the gate', async () => {
    const { service } = build({ selection: [] });

    const result = await service.recommend(REQUEST);

    expect(result.ready).toBe(false);
    expect(result.blockers).toContain('SITUATIONAL_EVIDENCE_UNAVAILABLE');
    expect(result.situationalItems).toEqual([]);
  });

  it('is not ready when the locked archetype is missing from the snapshot', async () => {
    const context = { ...contextWith('VS_HERO_WPA'), snapshot: { archetypes: [] } };
    const { service, select } = build({ context });

    const result = await service.recommend(REQUEST);

    expect(result.ready).toBe(false);
    expect(result.blockers).toContain('LOCKED_ARCHETYPE_V2_UNAVAILABLE');
    expect(result.situationalItems).toEqual([]);
    expect(select).not.toHaveBeenCalled();
  });

  it('passes the lock blockers through when the lock cannot be resolved', async () => {
    const { service, select } = build({ ok: false });

    const result = await service.recommend(REQUEST);

    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual(['ENEMY_ROSTER_INCOMPLETE']);
    expect(result.situationalItems).toEqual([]);
    expect(select).not.toHaveBeenCalled();
  });
});
