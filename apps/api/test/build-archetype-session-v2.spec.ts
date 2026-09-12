import { BuildArchetypeSessionV2Service } from '../src/statlocker-adaptive/build-archetype-session-v2.service';
import { BuildArchetypeSelectionV2 } from '../src/statlocker-adaptive/build-archetype-selector-v2.service';

function selection(archetypeId: string): BuildArchetypeSelectionV2 {
  return {
    archetypeId,
    mode: 'VS_HERO_WPA',
    scores: [{ archetypeId, score: 0.05, confidence: 0.8, coverage: 1 }],
    degradedReasons: [],
  };
}

function fakeRepository() {
  const rows = new Map<string, any>();
  return {
    rows,
    findOne: jest.fn(async ({ where }: any) => rows.get(where.matchId)),
    create: jest.fn((input: any) => ({ ...input })),
    save: jest.fn(async (row: any) => {
      if (rows.has(row.matchId)) {
        const error = new Error('duplicate key value violates unique constraint');
        (error as any).code = '23505';
        throw error;
      }
      rows.set(row.matchId, { ...row });
      return rows.get(row.matchId);
    }),
  } as any;
}

describe('BuildArchetypeSessionV2Service', () => {
  it('is first-write-wins even when later selection evidence changes radically', async () => {
    const repository = fakeRepository();
    const service = new BuildArchetypeSessionV2Service(repository);

    const first = await service.getOrLock('match-1', {
      heroId: 72,
      snapshotId: 'snapshot-1',
      enemyHeroIds: [10, 20],
      selection: selection('archetype-b'),
      lockedGameTimeS: 1,
    }, new Date('2026-09-10T00:00:00.000Z'));

    const second = await service.getOrLock('match-1', {
      heroId: 72,
      snapshotId: 'snapshot-2',
      enemyHeroIds: [30, 40],
      selection: selection('archetype-a'),
      lockedGameTimeS: 300,
    }, new Date('2026-09-10T00:05:00.000Z'));

    expect(first.archetypeId).toBe('archetype-b');
    expect(second.archetypeId).toBe('archetype-b');
    expect(second.snapshotId).toBe('snapshot-1');
    expect(repository.save).toHaveBeenCalledTimes(1);
  });

  it('returns the persisted lock after service recreation', async () => {
    const repository = fakeRepository();
    const firstService = new BuildArchetypeSessionV2Service(repository);
    await firstService.getOrLock('match-1', {
      heroId: 72,
      snapshotId: 'snapshot-1',
      enemyHeroIds: [10, 20],
      selection: selection('archetype-b'),
    }, new Date('2026-09-10T00:00:00.000Z'));

    const recreatedService = new BuildArchetypeSessionV2Service(repository);
    const persisted = await recreatedService.getOrLock('match-1', {
      heroId: 72,
      snapshotId: 'snapshot-2',
      enemyHeroIds: [30, 40],
      selection: selection('archetype-a'),
    }, new Date('2026-09-10T00:10:00.000Z'));

    expect(persisted.archetypeId).toBe('archetype-b');
    expect(persisted.enemyHeroIds).toEqual([10, 20]);
  });

  it('recovers the winning persisted lock if a concurrent insert loses the unique-key race', async () => {
    const repository = fakeRepository();
    repository.save.mockImplementationOnce(async (row: any) => {
      repository.rows.set(row.matchId, {
        ...row,
        archetypeId: 'archetype-existing',
        selection: selection('archetype-existing'),
      });
      const error = new Error('duplicate key value violates unique constraint');
      (error as any).code = '23505';
      throw error;
    });
    const service = new BuildArchetypeSessionV2Service(repository);

    const lock = await service.getOrLock('match-race', {
      heroId: 72,
      snapshotId: 'snapshot-1',
      enemyHeroIds: [10, 20],
      selection: selection('archetype-new'),
    }, new Date('2026-09-10T00:00:00.000Z'));

    expect(lock.archetypeId).toBe('archetype-existing');
  });
});
