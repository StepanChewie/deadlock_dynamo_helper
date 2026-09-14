import { BuildIterationCaptureV1 } from '../src/statlocker-adaptive/build-iteration-capture-v1';
import { BuildIterationHistoryV1Service } from '../src/statlocker-adaptive/build-iteration-history-v1.service';

/**
 * Fake storage that keeps every inserted row and serves `findOne` with the
 * latest row for a (matchId, steamId) key, mirroring the repository contract
 * the service relies on once dedupe compares against the previous row instead
 * of a unique index / ON CONFLICT.
 */
function repository() {
  const rows: any[] = [];
  const repo: any = {
    rows,
    createQueryBuilder: jest.fn(() => ({
      insert: () => ({
        into: () => ({
          values: (value: any) => ({
            execute: async () => {
              rows.push({ ...value, id: String(rows.length + 1) });
              return { identifiers: [{ id: rows.length }] };
            },
          }),
        }),
      }),
    })),
    findOne: jest.fn(async (options: any) => {
      const { matchId, steamId } = options.where;
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (rows[index].matchId === matchId && rows[index].steamId === steamId) {
          return rows[index];
        }
      }
      return null;
    }),
    delete: jest.fn(() => ({
      where: () => ({
        andWhere: () => ({
          execute: async () => ({ affected: 0 }),
        }),
      }),
    })),
  };
  return repo;
}

function planResult(buyItemId: number) {
  return {
    ready: true,
    blockers: [],
    decisionId: `d-${buyItemId}`,
    stateRevision: `rev-${buyItemId}`,
    heroId: 72,
    nextAction: { type: 'BUY', buyItemId, reasonCodes: [] },
    fullBuild: {
      planRevision: 'p-1',
      steps: [{
        sequence: 1, action: 'BUY', buyItemId, consumedItemIds: [],
        inventoryBefore: [], inventoryAfter: [], reasonCodes: ['OPENING'],
      }],
      degradedReasons: [],
      validation: { valid: true, reasonCodes: [] },
    },
    score: { total: 0.05, confidence: 0.8 },
    degradedReasons: [],
  } as any;
}

function notReadyResult(blockers: string[]) {
  return {
    ready: false,
    blockers: [...blockers],
    decisionId: 'd-not-ready',
    stateRevision: 'rev-not-ready',
    heroId: 72,
    nextAction: { type: 'HOLD', reasonCodes: [] },
    score: { total: 0, confidence: 0 },
    degradedReasons: [],
  } as any;
}

function capture(steamId = 'steam-111'): BuildIterationCaptureV1 {
  const value = new BuildIterationCaptureV1();
  value.steamId = steamId;
  value.heroId = 72;
  value.gameTimeSec = 600;
  return value;
}

describe('BuildIterationHistoryV1Service', () => {
  it('records A -> B -> A as three rows because the state changed back', async () => {
    const repo = repository();
    const service = new BuildIterationHistoryV1Service(repo);

    await service.record({ matchId: 'match-1', steamId: 'steam-111', result: planResult(100), capture: capture() });
    await service.record({ matchId: 'match-1', steamId: 'steam-111', result: planResult(200), capture: capture() });
    await service.record({ matchId: 'match-1', steamId: 'steam-111', result: planResult(100), capture: capture() });

    expect(repo.rows).toHaveLength(3);
    expect(repo.rows.map((row: any) => row.kind)).toEqual(['PLAN', 'PLAN', 'PLAN']);
    expect(repo.rows[1].fingerprint).not.toBe(repo.rows[0].fingerprint);
    expect(repo.rows[2].fingerprint).toBe(repo.rows[0].fingerprint);
  });

  it('writes a single row for five identical recommendations', async () => {
    const repo = repository();
    const service = new BuildIterationHistoryV1Service(repo);

    for (let tick = 0; tick < 5; tick += 1) {
      await service.record({ matchId: 'match-1', steamId: 'steam-111', result: planResult(100), capture: capture() });
    }

    expect(repo.rows).toHaveLength(1);
    expect(repo.rows[0].kind).toBe('PLAN');
  });

  it('records PLAN -> NOT_READY -> PLAN as three rows in that order', async () => {
    const repo = repository();
    const service = new BuildIterationHistoryV1Service(repo);

    await service.record({ matchId: 'match-1', steamId: 'steam-111', result: planResult(100), capture: capture() });
    await service.record({ matchId: 'match-1', steamId: 'steam-111', result: notReadyResult(['ENEMY_ROSTER_INCOMPLETE']) });
    await service.record({ matchId: 'match-1', steamId: 'steam-111', result: planResult(100), capture: capture() });

    expect(repo.rows.map((row: any) => row.kind)).toEqual(['PLAN', 'NOT_READY', 'PLAN']);
  });

  it('re-hydrates the last state after a restart and appends only real changes', async () => {
    const repo = repository();
    const beforeRestart = new BuildIterationHistoryV1Service(repo);
    await beforeRestart.record({ matchId: 'match-1', steamId: 'steam-111', result: planResult(100), capture: capture() });
    expect(repo.rows).toHaveLength(1);

    const afterRestart = new BuildIterationHistoryV1Service(repo);
    await afterRestart.record({ matchId: 'match-1', steamId: 'steam-111', result: planResult(100), capture: capture() });
    expect(repo.rows).toHaveLength(1);

    await afterRestart.record({ matchId: 'match-1', steamId: 'steam-111', result: planResult(200), capture: capture() });
    expect(repo.rows).toHaveLength(2);
    expect(repo.rows[1].fingerprint).not.toBe(repo.rows[0].fingerprint);
  });

  it('keeps two players of one match apart', async () => {
    const repo = repository();
    const service = new BuildIterationHistoryV1Service(repo);

    await service.record({ matchId: 'match-1', steamId: 'steam-111', result: planResult(100), capture: capture() });
    await service.record({ matchId: 'match-1', steamId: 'steam-222', result: planResult(100), capture: capture('steam-222') });
    await service.record({ matchId: 'match-1', steamId: 'steam-111', result: planResult(100), capture: capture() });

    expect(repo.rows.map((row: any) => row.steamId).sort()).toEqual(['steam-111', 'steam-222']);
  });

  it('records not-ready transitions with the blocker set', async () => {
    const repo = repository();
    const service = new BuildIterationHistoryV1Service(repo);
    const notReady = notReadyResult(['ENEMY_ROSTER_INCOMPLETE']);

    await service.record({ matchId: 'match-1', steamId: 'steam-111', result: notReady });
    await service.record({ matchId: 'match-1', steamId: 'steam-111', result: notReady });
    await service.record({ matchId: 'match-1', steamId: 'steam-111', result: planResult(100), capture: capture() });

    expect(repo.rows.map((row: any) => row.kind)).toEqual(['NOT_READY', 'PLAN']);
  });

  it('deletes only unpinned rows past the TTL, bounded by the pass limit', async () => {
    const predicates: string[] = [];
    const conditions: string[] = [];
    let passes = 0;
    const repo = repository();
    repo.createQueryBuilder = jest.fn(() => ({
      delete: () => ({
        from: () => ({
          where: (predicate: string) => ({
            andWhere: (condition: unknown) => ({
              andWhere: () => ({
                setParameters: () => ({
                  execute: async () => {
                    passes += 1;
                    predicates.push(predicate);
                    conditions.push(JSON.stringify(condition));
                    return { affected: 7 };
                  },
                }),
              }),
            }),
          }),
        }),
      }),
    }));
    const service = new BuildIterationHistoryV1Service(repo);

    const affected = await service.cleanupExpired();

    expect(affected).toBe(7);
    expect(passes).toBe(1);
    expect(predicates).toEqual(['pinned = false']);
    expect(conditions[0]).toContain('capturedAt');
  });

  it('sums affected rows across passes until a pass is not full', async () => {
    const affectedPerPass = [2, 2, 1];
    let passes = 0;
    const repo = repository();
    repo.createQueryBuilder = jest.fn(() => ({
      delete: () => ({
        from: () => ({
          where: () => ({
            andWhere: () => ({
              andWhere: () => ({
                setParameters: () => ({
                  execute: async () => {
                    const affected = affectedPerPass[passes] ?? 0;
                    passes += 1;
                    return { affected };
                  },
                }),
              }),
            }),
          }),
        }),
      }),
    }));
    const service = new BuildIterationHistoryV1Service(repo);

    const affected = await service.cleanupExpired(2);

    expect(affected).toBe(5);
    expect(passes).toBe(3);
  });

  it('never throws when the insert fails', async () => {
    const repo = repository();
    repo.createQueryBuilder = jest.fn(() => {
      throw new Error('connection terminated');
    });
    const service = new BuildIterationHistoryV1Service(repo);

    await expect(service.record({ matchId: 'match-1', steamId: 'steam-111', result: planResult(100), capture: capture() })).resolves.toBeUndefined();
  });
});
