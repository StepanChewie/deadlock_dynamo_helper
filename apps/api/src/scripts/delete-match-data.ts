import { stat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DataSource } from 'typeorm';
import { AppDataSource } from '../database/data-source';
import { AdaptiveBuildIterationV1Entity } from '../deadlock-live/entities/adaptive-build-iteration-v1.entity';
import { AdaptiveFeedbackV1Entity } from '../deadlock-live/entities/adaptive-feedback-v1.entity';
import { BuildArchetypeMatchLockV2Entity } from '../deadlock-live/entities/build-archetype-match-lock-v2.entity';
import { sanitizeMatchId } from '../deadlock-live/raw-event-log.service';

/**
 * Deletes everything the bridge stores about one match.
 *
 * This exists because the published privacy policy has to be truthful: it says
 * a player can have their match data removed, and until now there was no way to
 * do it. A deletion request is answered by running this script, so it has to be
 * exact, auditable and impossible to fire by accident.
 *
 * Two deliberate properties:
 *
 * 1. **Dry run is the default.** Nothing is removed unless `--yes` is passed.
 *    The operator first sees the row counts, then re-runs with `--yes`.
 * 2. **Deletion is all-or-nothing across tables.** The three tables are cleared
 *    in one transaction, so an interrupted run cannot leave a match half
 *    deleted and looking like it was never stored.
 *
 * The raw NDJSON log is a file rather than a row, so it cannot join that
 * transaction; it is removed after the commit, and a failure to remove it is
 * reported rather than swallowed.
 */

/** Per-table row counts for one match. */
export interface MatchDataCounts {
  readonly feedback: number;
  readonly iterations: number;
  readonly locks: number;
}

/** The raw NDJSON log written by `RawEventLogService` for one match. */
export interface RawLogFileInfo {
  readonly path: string;
  readonly bytes: number;
}

/**
 * The storage operations the deletion needs.
 *
 * Kept as an interface so the deletion logic can be tested against a fake
 * instead of a live Postgres, which is the only way to prove the dry run really
 * does not delete anything.
 */
export interface MatchDataStore {
  countMatchRows(matchId: string): Promise<MatchDataCounts>;
  /**
   * Removes the match's rows and returns the counts it removed.
   *
   * The counts are returned rather than re-counted by the caller on purpose:
   * after the delete the rows are gone, so a second count would report zero and
   * make the audit line say nothing was removed.
   */
  deleteMatchRows(matchId: string): Promise<MatchDataCounts>;
  locateRawLog(matchId: string): Promise<RawLogFileInfo | null>;
  deleteRawLog(path: string): Promise<void>;
}

export interface DeleteMatchDataOptions {
  /** When false, counts are gathered and nothing is removed. */
  readonly confirmed: boolean;
}

export interface MatchDeletionReport {
  readonly matchId: string;
  readonly deleted: boolean;
  readonly rows: MatchDataCounts;
  readonly rawLog: RawLogFileInfo | null;
  readonly rawLogDeleted: boolean;
}

export interface DeleteMatchDataReport {
  readonly confirmed: boolean;
  readonly matches: readonly MatchDeletionReport[];
}

export interface DeleteMatchDataArgs {
  readonly matchIds: readonly string[];
  readonly confirmed: boolean;
}

/**
 * Where `RawEventLogService` would have written this match's NDJSON file.
 *
 * The id is sanitized before it reaches the filesystem, so a hostile match id
 * cannot climb out of the log directory: `sanitizeMatchId` strips `/` and `\`,
 * leaving a single path segment. Tests assert that containment directly rather
 * than trusting it.
 */
export function resolveMatchLogPath(baseDir: string, matchId: string): string {
  return join(resolve(baseDir), `${sanitizeMatchId(matchId)}.ndjson`);
}

/**
 * Parses the command line.
 *
 * `--match-id` repeats, because an operator working through a support queue has
 * several ids and re-connecting to the database per id would be silly.
 */
export function parseDeleteMatchDataArgs(argv: readonly string[]): DeleteMatchDataArgs {
  const matchIds: string[] = [];
  let confirmed = false;

  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--yes') {
      confirmed = true;
      continue;
    }
    if (key !== '--match-id') {
      throw new Error(`Unexpected argument: ${key}`);
    }

    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error('Missing value for --match-id');
    }
    const trimmed = value.trim();
    if (trimmed === '') {
      throw new Error('--match-id must not be blank');
    }
    matchIds.push(trimmed);
    index += 1;
  }

  if (matchIds.length === 0) {
    throw new Error('Match data deletion requires at least one --match-id');
  }

  return { matchIds: [...new Set(matchIds)], confirmed };
}

/**
 * Removes (or, by default, only counts) one match's stored data.
 *
 * A dry run still reports the row counts and whether a raw log exists, so the
 * operator can decide before passing `--yes`; the only difference is that
 * nothing is touched.
 */
export async function deleteMatchData(
  store: MatchDataStore,
  matchId: string,
  options: DeleteMatchDataOptions,
): Promise<MatchDeletionReport> {
  const rawLog = await store.locateRawLog(matchId);

  if (!options.confirmed) {
    return {
      matchId,
      deleted: false,
      rows: await store.countMatchRows(matchId),
      rawLog,
      rawLogDeleted: false,
    };
  }

  const rows = await store.deleteMatchRows(matchId);

  let rawLogDeleted = false;
  if (rawLog) {
    await store.deleteRawLog(rawLog.path);
    rawLogDeleted = true;
  }

  return { matchId, deleted: true, rows, rawLog, rawLogDeleted };
}

export async function deleteMatches(
  store: MatchDataStore,
  args: DeleteMatchDataArgs,
): Promise<DeleteMatchDataReport> {
  const matches: MatchDeletionReport[] = [];
  for (const matchId of args.matchIds) {
    matches.push(await deleteMatchData(store, matchId, { confirmed: args.confirmed }));
  }
  return { confirmed: args.confirmed, matches };
}

export function formatDeletionReport(report: DeleteMatchDataReport): string {
  const lines: string[] = [];
  lines.push(
    report.confirmed
      ? 'Match data deletion - APPLYING'
      : 'Match data deletion - DRY RUN (pass --yes to apply)',
  );

  for (const match of report.matches) {
    lines.push('');
    lines.push(`match ${match.matchId}`);
    const verb = match.deleted ? 'deleted' : 'would delete';
    lines.push(`  adaptive_feedback_v1: ${verb} ${match.rows.feedback} row(s)`);
    lines.push(`  adaptive_build_iterations_v1: ${verb} ${match.rows.iterations} row(s)`);
    lines.push(`  build_archetype_match_locks_v2: ${verb} ${match.rows.locks} row(s)`);
    if (!match.rawLog) {
      lines.push('  raw event log: none found');
    } else if (match.deleted) {
      lines.push(`  raw event log: ${match.rawLogDeleted ? 'deleted' : 'NOT deleted'} ${match.rawLog.path}`);
    } else {
      lines.push(`  raw event log: would delete ${match.rawLog.path} (${match.rawLog.bytes} bytes)`);
    }
  }

  const total = report.matches.reduce(
    (sum, match) => sum + match.rows.feedback + match.rows.iterations + match.rows.locks,
    0,
  );
  lines.push('');
  lines.push(
    `${report.matches.length} match(es), ${total} row(s)${report.confirmed ? ' deleted' : ' matched'}.`,
  );

  return `${lines.join('\n')}\n`;
}

export class TypeOrmMatchDataStore implements MatchDataStore {
  constructor(
    private readonly dataSource: DataSource,
    private readonly baseDir: string,
  ) {}

  async countMatchRows(matchId: string): Promise<MatchDataCounts> {
    const [feedback, iterations, locks] = await Promise.all([
      this.dataSource.getRepository(AdaptiveFeedbackV1Entity).count({ where: { matchId } }),
      this.dataSource.getRepository(AdaptiveBuildIterationV1Entity).count({ where: { matchId } }),
      this.dataSource.getRepository(BuildArchetypeMatchLockV2Entity).count({ where: { matchId } }),
    ]);
    return { feedback, iterations, locks };
  }

  async deleteMatchRows(matchId: string): Promise<MatchDataCounts> {
    return this.dataSource.transaction(async (manager) => {
      const counts = await this.countMatchRows(matchId);
      await manager.getRepository(AdaptiveFeedbackV1Entity).delete({ matchId });
      await manager.getRepository(AdaptiveBuildIterationV1Entity).delete({ matchId });
      await manager.getRepository(BuildArchetypeMatchLockV2Entity).delete({ matchId });
      return counts;
    });
  }

  async locateRawLog(matchId: string): Promise<RawLogFileInfo | null> {
    const path = resolveMatchLogPath(this.baseDir, matchId);
    try {
      return { path, bytes: (await stat(path)).size };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async deleteRawLog(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

function resolveRawLogDir(): string {
  return process.env.DEADLOCK_LIVE_RAW_LOG_DIR?.trim()
    || join(process.cwd(), 'storage', 'deadlock-live');
}

async function main(): Promise<void> {
  const args = parseDeleteMatchDataArgs(process.argv.slice(2));
  const store = new TypeOrmMatchDataStore(AppDataSource, resolveRawLogDir());

  await AppDataSource.initialize();
  try {
    const report = await deleteMatches(store, args);
    process.stdout.write(formatDeletionReport(report));
  } finally {
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy();
    }
  }
}

if (require.main === module) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
