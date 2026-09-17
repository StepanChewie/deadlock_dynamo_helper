import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DataSource } from 'typeorm';
import {
  deleteMatchData,
  deleteMatches,
  formatDeletionReport,
  parseDeleteMatchDataArgs,
  resolveMatchLogPath,
  TypeOrmMatchDataStore,
  type MatchDataCounts,
  type MatchDataStore,
  type RawLogFileInfo,
} from '../src/scripts/delete-match-data';
import { RawEventLogService } from '../src/deadlock-live/raw-event-log.service';

const COUNTS: MatchDataCounts = { feedback: 2, iterations: 5, locks: 1 };

class FakeStore implements MatchDataStore {
  deletedMatchIds: string[] = [];
  deletedPaths: string[] = [];
  private remaining: MatchDataCounts;

  constructor(counts: MatchDataCounts = COUNTS, private readonly log: RawLogFileInfo | null = null) {
    this.remaining = counts;
  }

  async countMatchRows(): Promise<MatchDataCounts> {
    return this.remaining;
  }

  async deleteMatchRows(matchId: string): Promise<MatchDataCounts> {
    this.deletedMatchIds.push(matchId);
    // Models the real store: the rows are gone afterwards, so a caller that
    // re-counted instead of using the returned value would report zeros.
    const removed = this.remaining;
    this.remaining = { feedback: 0, iterations: 0, locks: 0 };
    return removed;
  }

  async locateRawLog(): Promise<RawLogFileInfo | null> {
    return this.log;
  }

  async deleteRawLog(path: string): Promise<void> {
    this.deletedPaths.push(path);
  }
}

describe('parseDeleteMatchDataArgs', () => {
  it('requires at least one match id', () => {
    expect(() => parseDeleteMatchDataArgs([])).toThrow(/at least one --match-id/);
    expect(() => parseDeleteMatchDataArgs(['--yes'])).toThrow(/at least one --match-id/);
  });

  it('is a dry run unless --yes is passed', () => {
    expect(parseDeleteMatchDataArgs(['--match-id', 'm1']).confirmed).toBe(false);
    expect(parseDeleteMatchDataArgs(['--match-id', 'm1', '--yes']).confirmed).toBe(true);
  });

  it('collects several match ids and drops duplicates', () => {
    expect(
      parseDeleteMatchDataArgs(['--match-id', 'm1', '--match-id', 'm2', '--match-id', 'm1'])
        .matchIds,
    ).toEqual(['m1', 'm2']);
  });

  it('rejects unknown options, missing values and blank ids', () => {
    expect(() => parseDeleteMatchDataArgs(['--match-id', 'm1', '--force'])).toThrow(
      /Unexpected argument: --force/,
    );
    expect(() => parseDeleteMatchDataArgs(['--match-id'])).toThrow(/Missing value/);
    expect(() => parseDeleteMatchDataArgs(['--match-id', '--yes'])).toThrow(/Missing value/);
    expect(() => parseDeleteMatchDataArgs(['--match-id', '   '])).toThrow(/must not be blank/);
  });
});

describe('resolveMatchLogPath', () => {
  it('names the file the raw event log service writes', () => {
    expect(resolveMatchLogPath('/srv/logs', 'match-123')).toBe(
      join(resolve('/srv/logs'), 'match-123.ndjson'),
    );
  });

  it('keeps a hostile match id inside the log directory', () => {
    // The id reaches the filesystem, so containment is a security property, not
    // a formatting detail. Asserted rather than trusted: if sanitisation ever
    // loosened, this test is what would notice.
    const base = resolve('/srv/logs');
    for (const matchId of [
      '../../etc/passwd',
      '..',
      'a/b/c',
      'a\\b',
      '/absolute/path',
      '....//....//etc/shadow',
      'with space and :colon',
    ]) {
      expect(dirname(resolveMatchLogPath(base, matchId))).toBe(base);
    }
  });

  it('falls back to a usable name only when the id is empty or blank', () => {
    // A run of stripped characters collapses to a single `_`, which is still a
    // usable file name; only a blank id has nothing left to name a file after.
    expect(resolveMatchLogPath('/srv/logs', '///')).toBe(join(resolve('/srv/logs'), '_.ndjson'));
    for (const matchId of ['', '   ']) {
      expect(resolveMatchLogPath('/srv/logs', matchId)).toBe(
        join(resolve('/srv/logs'), 'unknown.ndjson'),
      );
    }
  });
});

describe('deleteMatchData', () => {
  it('reports counts and deletes nothing on a dry run', async () => {
    const store = new FakeStore(COUNTS, { path: '/srv/logs/m1.ndjson', bytes: 12 });

    const report = await deleteMatchData(store, 'm1', { confirmed: false });

    expect(report).toEqual({
      matchId: 'm1',
      deleted: false,
      rows: COUNTS,
      rawLog: { path: '/srv/logs/m1.ndjson', bytes: 12 },
      rawLogDeleted: false,
    });
    expect(store.deletedMatchIds).toEqual([]);
    expect(store.deletedPaths).toEqual([]);
  });

  it('deletes every table and the raw log when confirmed', async () => {
    const store = new FakeStore(COUNTS, { path: '/srv/logs/m1.ndjson', bytes: 12 });

    const report = await deleteMatchData(store, 'm1', { confirmed: true });

    expect(store.deletedMatchIds).toEqual(['m1']);
    expect(store.deletedPaths).toEqual(['/srv/logs/m1.ndjson']);
    expect(report.deleted).toBe(true);
    expect(report.rawLogDeleted).toBe(true);
    // The reported counts describe what was removed. The fake zeroes its
    // remaining rows on delete, so a caller that re-counted instead of using
    // the returned value would report nothing.
    expect(report.rows).toEqual(COUNTS);
  });

  it('still deletes rows when no raw log was ever written', async () => {
    const store = new FakeStore(COUNTS, null);

    const report = await deleteMatchData(store, 'm1', { confirmed: true });

    expect(store.deletedMatchIds).toEqual(['m1']);
    expect(store.deletedPaths).toEqual([]);
    expect(report.rawLog).toBeNull();
    expect(report.rawLogDeleted).toBe(false);
  });
});

describe('deleteMatches', () => {
  it('walks every requested match id', async () => {
    const store = new FakeStore();

    const report = await deleteMatches(store, { matchIds: ['m1', 'm2'], confirmed: true });

    expect(store.deletedMatchIds).toEqual(['m1', 'm2']);
    expect(report.matches.map((match) => match.matchId)).toEqual(['m1', 'm2']);
  });
});

describe('formatDeletionReport', () => {
  it('labels a dry run and totals the matched rows', async () => {
    const store = new FakeStore(COUNTS, { path: '/srv/logs/m1.ndjson', bytes: 12 });

    const text = formatDeletionReport(
      await deleteMatches(store, { matchIds: ['m1'], confirmed: false }),
    );

    expect(text).toContain('DRY RUN (pass --yes to apply)');
    expect(text).toContain('adaptive_feedback_v1: would delete 2 row(s)');
    expect(text).toContain('adaptive_build_iterations_v1: would delete 5 row(s)');
    expect(text).toContain('build_archetype_match_locks_v2: would delete 1 row(s)');
    expect(text).toContain('would delete /srv/logs/m1.ndjson (12 bytes)');
    expect(text).toContain('1 match(es), 8 row(s) matched.');
  });

  it('labels an applied deletion and says when no log was found', async () => {
    const store = new FakeStore(COUNTS, null);

    const text = formatDeletionReport(
      await deleteMatches(store, { matchIds: ['m1'], confirmed: true }),
    );

    expect(text).toContain('APPLYING');
    expect(text).toContain('adaptive_feedback_v1: deleted 2 row(s)');
    expect(text).toContain('raw event log: none found');
    expect(text).toContain('1 match(es), 8 row(s) deleted.');
  });
});

describe('TypeOrmMatchDataStore raw log handling', () => {
  let outputDir = '';
  const originalDir = process.env.DEADLOCK_LIVE_RAW_LOG_DIR;

  beforeEach(async () => {
    outputDir = await mkdtemp(join(tmpdir(), 'deadlock-delete-'));
    process.env.DEADLOCK_LIVE_RAW_LOG_DIR = outputDir;
  });

  afterEach(async () => {
    if (originalDir === undefined) {
      delete process.env.DEADLOCK_LIVE_RAW_LOG_DIR;
    } else {
      process.env.DEADLOCK_LIVE_RAW_LOG_DIR = originalDir;
    }
    await rm(outputDir, { recursive: true, force: true });
  });

  // `locateRawLog`/`deleteRawLog` never touch the database, so a stub is enough
  // to prove the deletion tool and the writer agree on the file name.
  const storeFor = (baseDir: string): TypeOrmMatchDataStore =>
    new TypeOrmMatchDataStore({} as DataSource, baseDir);

  it('finds and removes the file the raw event log service wrote', async () => {
    await new RawEventLogService().appendEvents([
      {
        receivedAt: 1,
        source: 'onInfoUpdates2',
        matchId: 'match-del',
        key: 'items_1',
        payload: { value: 'x' },
      },
    ]);

    const store = storeFor(outputDir);
    const located = await store.locateRawLog('match-del');

    expect(located).not.toBeNull();
    expect(located?.bytes).toBeGreaterThan(0);

    await store.deleteRawLog(located!.path);
    expect((await readdir(outputDir)).filter((name) => name.endsWith('.ndjson'))).toEqual([]);
  });

  it('reports no file for a match that was never logged', async () => {
    expect(await storeFor(outputDir).locateRawLog('never-seen')).toBeNull();
  });

  it('treats an already-removed file as success', async () => {
    const path = join(outputDir, 'gone.ndjson');
    await writeFile(path, '{}\n', 'utf8');

    const store = storeFor(outputDir);
    await store.deleteRawLog(path);
    await expect(store.deleteRawLog(path)).resolves.toBeUndefined();
  });
});
