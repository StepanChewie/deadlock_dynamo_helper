import { BuildIterationCaptureV1 } from '../src/statlocker-adaptive/build-iteration-capture-v1';
import { BuildIterationHistoryV1Service } from '../src/statlocker-adaptive/build-iteration-history-v1.service';

function repository() {
  const rows: any[] = [];
  return {
    rows,
    createQueryBuilder: jest.fn(() => ({
      insert: () => ({
        into: () => ({
          values: (value: any) => ({
            orIgnore: () => ({
              execute: async () => {
                const duplicate = rows.some(
                  (row) => row.matchId === value.matchId && row.steamId === value.steamId &&
                    row.kind === value.kind && row.fingerprint === value.fingerprint,
                );
                if (duplicate) return { identifiers: [] };
                rows.push(value);
                return { identifiers: [{ id: rows.length }] };
              },
            }),
          }),
        }),
      }),
    })),
    delete: jest.fn(() => ({
      where: () => ({
        andWhere: () => ({
          execute: async () => ({ affected: 0 }),
        }),
      }),
    })),
  } as any;
}

const readyResult = {
  ready: true,
  blockers: [],
  decisionId: 'd-1',
  stateRevision: 'rev-1',
  heroId: 72,
  nextAction: { type: 'BUY', buyItemId: 100, reasonCodes: [] },
  fullBuild: {
    planRevision: 'p-1',
    steps: [{
      sequence: 1, action: 'BUY', buyItemId: 100, consumedItemIds: [],
      inventoryBefore: [], inventoryAfter: [], reasonCodes: ['OPENING'],
    }],
    degradedReasons: [],
    validation: { valid: true, reasonCodes: [] },
  },
  score: { total: 0.05, confidence: 0.8 },
  degradedReasons: [],
} as any;

function capture(): BuildIterationCaptureV1 {
  const value = new BuildIterationCaptureV1();
  value.steamId = 'steam-111';
  value.heroId = 72;
  value.gameTimeSec = 600;
  return value;
}

describe('BuildIterationHistoryV1Service', () => {
  it('writes one row per unchanged plan and a new row when the plan changes', async () => {
    const repo = repository();
    const service = new BuildIterationHistoryV1Service(repo);

    await service.record({ matchId: 'match-1', steamId: 'steam-111', result: readyResult, capture: capture() });
    await service.record({ matchId: 'match-1', steamId: 'steam-111', result: readyResult, capture: capture() });

    const changed = { ...readyResult, fullBuild: { ...readyResult.fullBuild, steps: [{ ...readyResult.fullBuild.steps[0], buyItemId: 200 }] } };
    await service.record({ matchId: 'match-1', steamId: 'steam-111', result: changed, capture: capture() });

    expect(repo.rows).toHaveLength(2);
    expect(repo.rows[0].kind).toBe('PLAN');
  });

  it('keeps two players of one match apart', async () => {
    const repo = repository();
    const service = new BuildIterationHistoryV1Service(repo);

    await service.record({ matchId: 'match-1', steamId: 'steam-111', result: readyResult, capture: capture() });
    const second = capture();
    second.steamId = 'steam-222';
    await service.record({ matchId: 'match-1', steamId: 'steam-222', result: readyResult, capture: second });

    expect(repo.rows.map((row: any) => row.steamId).sort()).toEqual(['steam-111', 'steam-222']);
  });

  it('records not-ready transitions with the blocker set', async () => {
    const repo = repository();
    const service = new BuildIterationHistoryV1Service(repo);
    const notReady = { ready: false, blockers: ['ENEMY_ROSTER_INCOMPLETE'], decisionId: 'd-2', stateRevision: 'rev-2', heroId: 72, nextAction: { type: 'HOLD', reasonCodes: [] }, score: { total: 0, confidence: 0 }, degradedReasons: [] } as any;

    await service.record({ matchId: 'match-1', steamId: 'steam-111', result: notReady });
    await service.record({ matchId: 'match-1', steamId: 'steam-111', result: notReady });
    await service.record({ matchId: 'match-1', steamId: 'steam-111', result: readyResult, capture: capture() });

    expect(repo.rows.map((row: any) => row.kind)).toEqual(['NOT_READY', 'PLAN']);
  });

  it('never throws when the insert fails', async () => {
    const repo = repository();
    repo.createQueryBuilder = jest.fn(() => {
      throw new Error('connection terminated');
    });
    const service = new BuildIterationHistoryV1Service(repo);

    await expect(service.record({ matchId: 'match-1', steamId: 'steam-111', result: readyResult, capture: capture() })).resolves.toBeUndefined();
  });
});
