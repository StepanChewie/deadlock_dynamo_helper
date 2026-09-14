# Build Iteration History and Per-Player Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every player in a match their own archetype lock, decision trace and persisted build history, so a support complaint can be replayed from SQL.

**Architecture:** Two coupled parts. Part A moves the two match-scoped keys (archetype lock row, in-memory decision trace store) to `(matchId, steamId)`. Part B adds an append-only `adaptive_build_iterations_v1` table written from a single controller hook, deduplicated by a fingerprint through a partial unique index plus `ON CONFLICT DO NOTHING`.

**Tech Stack:** NestJS 11, TypeORM (Postgres, explicit migrations), Jest + ts-jest, Yarn workspaces.

**Spec:** `docs/superpowers/specs/2026-09-14-build-iteration-history-and-per-player-isolation-design.md` (read it alongside this plan)

## Global Constraints

- Migrations are auto-discovered from `apps/api/src/database/migrations/*{.ts,.js}`; never enable `synchronize`.
- Every entity is registered in `apps/api/src/database/database-entities.ts` and in the `TypeOrmModule.forFeature([...])` list of its module.
- Migrations run with `migrationsTransactionMode: 'all'`; each migration is one transaction.
- `down()` for data-destroying migrations is a documented no-op (see `1789142400000-drop-legacy-match-and-crawler-tables.ts`).
- The `POST /deadlock/adaptive/v2/recommend` response DTO must not change.
- History data is for incident review only; ADR-007 forbids using it as a training corpus. This must appear as a column comment and in the entity.
- `steamId` values are sentinel `unknown` only in the history table; the lock table never stores a sentinel.
- Run a single test file with:
  `yarn workspace @deadlock-live-probe/api test -- test/<file>.spec.ts`
- Commit messages follow the repo convention, e.g. `feat(api): ...`, `fix(api): ...`.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/src/database/migrations/1789228800000-scope-build-archetype-match-locks-by-player-v1.ts` (create) | Rebuild the lock table around `(matchId, steamId)` |
| `apps/api/src/deadlock-live/entities/build-archetype-match-lock-v2.entity.ts` (modify) | `steamId` primary column |
| `apps/api/src/statlocker-adaptive/build-archetype-session-v2.service.ts` (modify) | Lock reads/writes keyed per player |
| `apps/api/src/statlocker-adaptive/build-decision-trace-v2.ts` (modify) | `steamId` on the trace type |
| `apps/api/src/statlocker-adaptive/build-debug-trace-store-v2.service.ts` (modify) | Trace store keyed per player |
| `apps/api/src/statlocker-adaptive/adaptive-recommendation-v2.service.ts` (modify) | Uses the resolved player; fills the capture object |
| `apps/api/src/statlocker-adaptive/adaptive-recommendation-v2.controller.ts` (modify) | Resolves steamId; single history write site |
| `apps/api/src/build-debug-v2/build-debug-v2.controller.ts` (modify) | Player dimension on debug endpoints |
| `apps/api/src/database/migrations/1789315200000-create-adaptive-build-iterations-v1.ts` (create) | History table + indexes |
| `apps/api/src/deadlock-live/entities/adaptive-build-iteration-v1.entity.ts` (create) | History entity |
| `apps/api/src/statlocker-adaptive/build-iteration-fingerprint-v1.ts` (create) | Pure: fingerprints, reject extraction, size bounding |
| `apps/api/src/statlocker-adaptive/build-iteration-capture-v1.ts` (create) | Request-scoped carrier between service and controller |
| `apps/api/src/statlocker-adaptive/build-iteration-history-v1.service.ts` (create) | `record()` and retention cleanup |
| `apps/api/src/database/database-entities.ts` (modify) | Register the history entity |
| `apps/api/src/statlocker-adaptive/statlocker-adaptive.module.ts` (modify) | Register entity + providers |
| `apps/api/test/production-database-migration.integration.spec.ts` (modify) | New table + migration assertions |

---

## Part A — per-player isolation

### Task 1: Scope the archetype lock by player

**Files:**
- Create: `apps/api/src/database/migrations/1789228800000-scope-build-archetype-match-locks-by-player-v1.ts`
- Modify: `apps/api/src/deadlock-live/entities/build-archetype-match-lock-v2.entity.ts`
- Modify: `apps/api/test/production-database-migration.integration.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `build_archetype_match_locks_v2` with `PRIMARY KEY ("matchId", "steamId")` and `BuildArchetypeMatchLockV2Entity.steamId: string`.

- [ ] **Step 1: Write the failing integration assertion**

In `apps/api/test/production-database-migration.integration.spec.ts`, add a test after the existing "records the runtime migrations" test:

```ts
  it('scopes archetype match locks by player', async () => {
    const columns = (await dataSource.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'build_archetype_match_locks_v2'
       ORDER BY ordinal_position`,
    )) as Array<{ column_name: string }>;
    expect(columns.map((row) => row.column_name)).toContain('steamId');

    const keys = (await dataSource.query(
      `SELECT a.attname AS column_name
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = 'build_archetype_match_locks_v2'::regclass AND i.indisprimary
       ORDER BY a.attname`,
    )) as Array<{ column_name: string }>;
    expect(keys.map((row) => row.column_name)).toEqual(['matchId', 'steamId']);
  });
```

Also add `'adaptive_build_iterations_v1'` to `REQUIRED_NEW_TABLES` (used from Task 6 onward) and add `'ScopeBuildArchetypeMatchLocksByPlayerV11789228800000'` to the migration-name assertion array.

- [ ] **Step 2: Run it to verify it fails**

Run: `DB_MIGRATION_INTEGRATION=true yarn workspace @deadlock-live-probe/api test -- test/production-database-migration.integration.spec.ts`
Expected: FAIL — `steamId` is not in the column list (no such migration yet). Requires a running Postgres reachable with the env defaults in that spec.

- [ ] **Step 3: Write the migration**

Create `apps/api/src/database/migrations/1789228800000-scope-build-archetype-match-locks-by-player-v1.ts`:

```ts
import { MigrationInterface, QueryRunner } from 'typeorm';

export class ScopeBuildArchetypeMatchLocksByPlayerV11789228800000 implements MigrationInterface {
  name = 'ScopeBuildArchetypeMatchLocksByPlayerV11728800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // Lock rows from earlier deployments cannot be attributed to a player.
    // A lock only matters inside an active match (ADR-004), so dropping the
    // history costs at most one archetype re-selection for a match live during
    // the deploy.
    await queryRunner.query(`DELETE FROM "build_archetype_match_locks_v2"`);

    await queryRunner.query(`
      ALTER TABLE "build_archetype_match_locks_v2"
        ADD COLUMN "steamId" varchar(32) NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "build_archetype_match_locks_v2"
        DROP CONSTRAINT "PK_build_archetype_match_locks_v2"
    `);
    await queryRunner.query(`
      ALTER TABLE "build_archetype_match_locks_v2"
        ADD CONSTRAINT "PK_build_archetype_match_locks_v2" PRIMARY KEY ("matchId", "steamId")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_build_archetype_match_lock_player_v2"
      ON "build_archetype_match_locks_v2" ("steamId", "lockedAt")
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Deliberate no-op for the deleted rows; restore from a pg_dump if needed.
    await queryRunner.query('DROP INDEX IF EXISTS "idx_build_archetype_match_lock_player_v2"');
    await queryRunner.query('DELETE FROM "build_archetype_match_locks_v2"');
    await queryRunner.query(`
      ALTER TABLE "build_archetype_match_locks_v2"
        DROP CONSTRAINT "PK_build_archetype_match_locks_v2"
    `);
    await queryRunner.query(`
      ALTER TABLE "build_archetype_match_locks_v2"
        ADD CONSTRAINT "PK_build_archetype_match_locks_v2" PRIMARY KEY ("matchId")
    `);
    await queryRunner.query('ALTER TABLE "build_archetype_match_locks_v2" DROP COLUMN "steamId"');
  }
}
```

- [ ] **Step 4: Update the entity**

In `apps/api/src/deadlock-live/entities/build-archetype-match-lock-v2.entity.ts`, add a second primary column directly after `matchId` and keep the existing index:

```ts
  @PrimaryColumn({ type: 'varchar', length: 128 })
  matchId!: string;

  @PrimaryColumn({ type: 'varchar', length: 32 })
  steamId!: string;
```

- [ ] **Step 5: Run the integration assertion**

Run: `DB_MIGRATION_INTEGRATION=true yarn workspace @deadlock-live-probe/api test -- test/production-database-migration.integration.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/database/migrations/1789228800000-scope-build-archetype-match-locks-by-player-v1.ts apps/api/src/deadlock-live/entities/build-archetype-match-lock-v2.entity.ts apps/api/test/production-database-migration.integration.spec.ts
git commit -m "feat(api): scope archetype match locks by player"
```

---

### Task 2: Session service keyed by player

**Files:**
- Modify: `apps/api/src/statlocker-adaptive/build-archetype-session-v2.service.ts`
- Test: `apps/api/test/build-archetype-session-v2.spec.ts`

**Interfaces:**
- Consumes: `BuildArchetypeMatchLockV2Entity` with `steamId` (Task 1).
- Produces:
  - `get(matchId: string, steamId: string): Promise<BuildArchetypeMatchLockV2Entity | undefined>`
  - `getOrLock(matchId: string, steamId: string, input: LockBuildArchetypeV2Input, lockedAt?: Date): Promise<BuildArchetypeMatchLockV2Entity>`

- [ ] **Step 1: Write the failing tests**

In `apps/api/test/build-archetype-session-v2.spec.ts`, replace the fake repository key with a composite key and add two tests:

```ts
function fakeRepository() {
  const rows = new Map<string, any>();
  const key = (row: any) => `${row.matchId}|${row.steamId}`;
  return {
    rows,
    findOne: jest.fn(async ({ where }: any) => rows.get(`${where.matchId}|${where.steamId}`)),
    create: jest.fn((input: any) => ({ ...input })),
    save: jest.fn(async (row: any) => {
      if (rows.has(key(row))) {
        const error = new Error('duplicate key value violates unique constraint');
        (error as any).code = '23505';
        throw error;
      }
      rows.set(key(row), { ...row });
      return rows.get(key(row));
    }),
  } as any;
}

  it('gives two players in the same match their own lock', async () => {
    const repository = fakeRepository();
    const service = new BuildArchetypeSessionV2Service(repository);

    const firstPlayer = await service.getOrLock('match-1', 'steam-111', {
      heroId: 72,
      snapshotId: 'snapshot-1',
      enemyHeroIds: [10, 20],
      selection: selection('archetype-a'),
    }, new Date('2026-09-14T00:00:00.000Z'));

    const secondPlayer = await service.getOrLock('match-1', 'steam-222', {
      heroId: 45,
      snapshotId: 'snapshot-2',
      enemyHeroIds: [10, 20],
      selection: selection('archetype-b'),
    }, new Date('2026-09-14T00:00:05.000Z'));

    expect(firstPlayer.heroId).toBe(72);
    expect(secondPlayer.heroId).toBe(45);
    expect(secondPlayer.archetypeId).toBe('archetype-b');
    expect(repository.save).toHaveBeenCalledTimes(2);
  });

  it('rejects an empty steamId', async () => {
    const service = new BuildArchetypeSessionV2Service(fakeRepository());
    await expect(service.getOrLock('match-1', '  ', {
      heroId: 72,
      snapshotId: 'snapshot-1',
      enemyHeroIds: [10, 20],
      selection: selection('archetype-a'),
    })).rejects.toThrow('steamId is invalid');
  });
```

Update the three existing tests in that file to pass `'steam-111'` as the second argument to `getOrLock`.

- [ ] **Step 2: Run to verify failure**

Run: `yarn workspace @deadlock-live-probe/api test -- test/build-archetype-session-v2.spec.ts`
Expected: FAIL — `getOrLock` takes 3 arguments, TypeScript errors, `save` called once instead of twice.

- [ ] **Step 3: Implement**

In `build-archetype-session-v2.service.ts` replace the two public methods and add a validator:

```ts
  async get(matchId: string, steamId: string): Promise<BuildArchetypeMatchLockV2Entity | undefined> {
    validateMatchId(matchId);
    validateSteamId(steamId);
    return (
      (await this.repository.findOne({ where: { matchId, steamId } })) ?? undefined
    );
  }

  async getOrLock(
    matchId: string,
    steamId: string,
    input: LockBuildArchetypeV2Input,
    lockedAt: Date = new Date(),
  ): Promise<BuildArchetypeMatchLockV2Entity> {
    validateMatchId(matchId);
    validateSteamId(steamId);
    validateLockInput(matchId, input, lockedAt);

    const existing = await this.get(matchId, steamId);
    if (existing) return existing;

    const enemyHeroIds = [...new Set(input.enemyHeroIds)].sort((a, b) => a - b);
    const row = this.repository.create({
      matchId,
      steamId,
      heroId: input.heroId,
      snapshotId: input.snapshotId,
      archetypeId: input.selection.archetypeId,
      enemyHeroIds,
      selection: clone(input.selection) as unknown as Record<string, unknown>,
      degradedReasons: [...input.selection.degradedReasons],
      lockedAt,
      ...(input.lockedGameTimeS === undefined ? {} : { lockedGameTimeS: input.lockedGameTimeS }),
    });

    try {
      return await this.repository.save(row);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const winner = await this.get(matchId, steamId);
      if (!winner) throw error;
      return winner;
    }
  }
```

Add next to `validateMatchId`:

```ts
function validateSteamId(steamId: string): void {
  if (steamId.trim() === '' || steamId.length > 32) {
    throw new Error('Build archetype v2 session: steamId is invalid');
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `yarn workspace @deadlock-live-probe/api test -- test/build-archetype-session-v2.spec.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/statlocker-adaptive/build-archetype-session-v2.service.ts apps/api/test/build-archetype-session-v2.spec.ts
git commit -m "feat(api): key archetype locks by player in the session service"
```

---

### Task 3: Trace store keyed by player

**Files:**
- Modify: `apps/api/src/statlocker-adaptive/build-decision-trace-v2.ts`
- Modify: `apps/api/src/statlocker-adaptive/build-debug-trace-store-v2.service.ts`
- Test: `apps/api/test/build-debug-trace-store-v2.spec.ts`

**Interfaces:**
- Produces:
  - `BuildDecisionTraceV2.steamId: string` (required)
  - `BuildDebugMatchSummaryV2` gains `steamId: string`
  - `put(trace)`, `get(matchId, steamId)`, `revisions(matchId, steamId)`, `observe(matchId, steamId)`, `listActive()`

- [ ] **Step 1: Write the failing tests**

In `apps/api/test/build-debug-trace-store-v2.spec.ts` add:

```ts
  it('keeps revisions of two players in one match apart', async () => {
    const store = new BuildDebugTraceStoreV2Service();
    store.put(trace({ matchId: 'match-1', steamId: 'steam-111', revision: 1 }));
    store.put(trace({ matchId: 'match-1', steamId: 'steam-111', revision: 2 }));
    store.put(trace({ matchId: 'match-1', steamId: 'steam-222', revision: 1 }));

    expect(store.get('match-1', 'steam-111')?.revision).toBe(2);
    expect(store.get('match-1', 'steam-222')?.revision).toBe(1);
    expect(store.revisions('match-1', 'steam-111')).toHaveLength(2);
  });

  it('rejects a revision that does not increase for the same player', async () => {
    const store = new BuildDebugTraceStoreV2Service();
    store.put(trace({ matchId: 'match-1', steamId: 'steam-111', revision: 2 }));
    expect(() => store.put(trace({ matchId: 'match-1', steamId: 'steam-111', revision: 2 })))
      .toThrow('revision must increase');
  });
```

Extend the local `trace(...)` helper in that file so it accepts and returns `steamId` (for example `function trace(overrides: Partial<BuildDecisionTraceV2>) { return { matchId: 'match-1', steamId: 'steam-111', revision: 1, stateRevision: 'rev-1', generatedAt: new Date().toISOString(), stages: [], ...overrides }; }`).

Then update the existing calls in that spec from `store.get('match-1')` to `store.get('match-1', 'steam-111')` and `store.observe('match-1')` to `store.observe('match-1', 'steam-111')`.

- [ ] **Step 2: Run to verify failure**

Run: `yarn workspace @deadlock-live-probe/api test -- test/build-debug-trace-store-v2.spec.ts`
Expected: FAIL — `get` takes 1 argument, `steamId` is not part of `BuildDecisionTraceV2`.

- [ ] **Step 3: Add `steamId` to the trace type**

In `build-decision-trace-v2.ts`:

```ts
export interface BuildDecisionTraceV2 {
  matchId: string;
  steamId: string;
  revision: number;
  stateRevision: string;
  generatedAt: string;
  stages: readonly BuildDecisionTraceStageEntryV2[];
  finalPlan?: ResolvedFullBuildPlanV2;
}
```

- [ ] **Step 4: Rekey the store**

In `build-debug-trace-store-v2.service.ts`:

```ts
export interface BuildDebugMatchSummaryV2 {
  matchId: string;
  steamId: string;
  revision: number;
  stateRevision: string;
  generatedAt: string;
}
```

Replace every `Map<string, ...>` key use with `traceKey(matchId, steamId)`:

```ts
function traceKey(matchId: string, steamId: string): string {
  return `${matchId}|${steamId}`;
}
```

`put()` stores under `traceKey(trace.matchId, trace.steamId)` and compares `trace.revision` against the current revision for that same key. `get`, `revisions`, `observe` and the private `stream()` take `(matchId, steamId)`, validate both with `validateMatchId` / `validateSteamId`, and `listActive()` maps `steamId` into the summary. `validateTrace` additionally calls `validateSteamId(trace.steamId)`:

```ts
function validateSteamId(steamId: string): void {
  if (steamId.trim() === '' || steamId.length > 32) {
    throw new Error('Build debug trace store v2: steamId is invalid');
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `yarn workspace @deadlock-live-probe/api test -- test/build-debug-trace-store-v2.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/statlocker-adaptive/build-decision-trace-v2.ts apps/api/src/statlocker-adaptive/build-debug-trace-store-v2.service.ts apps/api/test/build-debug-trace-store-v2.spec.ts
git commit -m "feat(api): key the decision trace store by player"
```

---

### Task 4: Recommendation service uses the resolved player

**Files:**
- Modify: `apps/api/src/statlocker-adaptive/adaptive-recommendation-v2.service.ts`
- Test: `apps/api/test/adaptive-recommendation-v2.spec.ts`

**Interfaces:**
- Consumes: `session.get(matchId, steamId)` / `getOrLock(matchId, steamId, …)` (Task 2), `traceStore.get(matchId, steamId)` / `put(trace)` with `steamId` (Task 3).
- Produces: no signature change to `recommend(request)`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/adaptive-recommendation-v2.spec.ts`:

```ts
import { AdaptiveRecommendationV2Service } from '../src/statlocker-adaptive/adaptive-recommendation-v2.service';

describe('AdaptiveRecommendationV2Service player scoping', () => {
  it('reads the lock and the previous plan for the resolved player, not the request body', async () => {
    const sessionGet = jest.fn().mockResolvedValue(undefined);
    const traceStoreGet = jest.fn().mockReturnValue(undefined);
    const decision = {
      localSteamId: 'steam-222',
      state: { heroId: 45, gameTimeSec: 600, decisionId: 'd-1', inventory: { heldByItemId: new Map() }, economy: {} },
      stateRevision: 'rev-1',
      rulesetId: 'ruleset-1',
      catalogSha256: 'a'.repeat(64),
      enemyHeroIds: [],
      enemyLiveStates: [],
      slots: { totalCapacity: 0 },
    };
    const service = new AdaptiveRecommendationV2Service(
      { build: jest.fn().mockResolvedValue(decision) } as any,
      { getLocalEvidence: jest.fn(), resolveLocalPatchId: jest.fn() } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { get: traceStoreGet, put: jest.fn() } as any,
    );

    await service.recommend({ matchId: 'match-1', localSteamId: 'steam-111' });

    expect(sessionGet).toHaveBeenCalledWith('match-1', 'steam-222');
    expect(traceStoreGet).toHaveBeenCalledWith('match-1', 'steam-222');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `yarn workspace @deadlock-live-probe/api test -- test/adaptive-recommendation-v2.spec.ts`
Expected: FAIL — `session.get` and `traceStore.get` are called with a single `matchId` argument.

- [ ] **Step 3: Implement**

In `adaptive-recommendation-v2.service.ts`:

```ts
    const decision = await this.decisionState.build(request.matchId, request.localSteamId);
    const existingLock = await this.session.get(request.matchId, decision.localSteamId);
```

In `createLock(decision, matchId)`:

```ts
    const lock = await this.session.getOrLock(matchId, decision.localSteamId, {
      heroId: decision.state.heroId,
      snapshotId: snapshot.snapshotId,
      enemyHeroIds,
      selection: proposedSelection,
      lockedGameTimeS: decision.state.gameTimeSec,
    });
```

In `reuseLock` the call site becomes `this.session.get` unchanged (the lock is already resolved per player), and the trace reads/writes become:

```ts
    const previousTrace = this.traceStore.get(request.matchId, decision.localSteamId);
```

```ts
    this.traceStore.put({
      matchId: request.matchId,
      steamId: decision.localSteamId,
      revision: (previousTrace?.revision ?? 0) + 1,
      stateRevision: decision.stateRevision,
      generatedAt: new Date().toISOString(),
      stages: trace.stages(),
      finalPlan: plan,
    });
```

- [ ] **Step 4: Run the tests**

Run: `yarn workspace @deadlock-live-probe/api test -- test/adaptive-recommendation-v2.spec.ts`
Expected: PASS.

- [ ] **Step 5: Update the existing e2e harness**

In `apps/api/test/adaptive-recommendation-v2.e2e.spec.ts` and `apps/api/test/statlocker-build-v2-real-data.e2e.spec.ts`, every direct `session.getOrLock('match-1', {...})` / `get('match-1')` call gains the player argument, and any constructed `BuildDecisionTraceV2` literal gains `steamId`. Run both files:

Run: `yarn workspace @deadlock-live-probe/api test -- test/adaptive-recommendation-v2.e2e.spec.ts test/statlocker-build-v2-real-data.e2e.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/statlocker-adaptive/adaptive-recommendation-v2.service.ts apps/api/test/adaptive-recommendation-v2.spec.ts apps/api/test/adaptive-recommendation-v2.e2e.spec.ts apps/api/test/statlocker-build-v2-real-data.e2e.spec.ts
git commit -m "feat(api): resolve lock and trace by the requesting player"
```

---

### Task 5: Debug endpoints take the player dimension

**Files:**
- Modify: `apps/api/src/build-debug-v2/build-debug-v2.controller.ts`
- Modify: `apps/api/src/build-debug-v2/build-debug-v2.client.ts` (only if it fetches match/detail endpoints)
- Test: `apps/api/test/build-debug-v2.controller.spec.ts`

**Interfaces:**
- Consumes: `traces.listActive()`, `traces.get(matchId, steamId)`, `traces.observe(matchId, steamId)` (Task 3).
- Produces: `GET /debug/build-v2/matches/:matchId?steamId=…`, `GET /debug/build-v2/matches/:matchId/stream?steamId=…`.

- [ ] **Step 1: Write the failing tests**

```ts
  it('requires the player when reading a match trace', async () => {
    const traces = {
      listActive: jest.fn().mockReturnValue([{ matchId: 'm-1', steamId: 'steam-111', revision: 3, stateRevision: 'rev-1', generatedAt: '2026-09-14T00:00:00.000Z' }]),
      get: jest.fn().mockReturnValue(undefined),
    };

    expect(() => controller.snapshot('m-1', '')).toThrow('steamId is required');
    controller.snapshot('m-1', 'steam-111');
    expect(traces.get).toHaveBeenCalledWith('m-1', 'steam-111');
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `yarn workspace @deadlock-live-probe/api test -- test/build-debug-v2.controller.spec.ts`
Expected: FAIL — `snapshot` takes one argument.

- [ ] **Step 3: Implement**

```ts
  @Get('matches/:matchId')
  @UseGuards(BuildDebugAuthV2Guard)
  snapshot(@Param('matchId') matchId: string, @Query('steamId') steamId?: string) {
    if (!steamId?.trim()) throw new BadRequestException('steamId is required');
    const trace = this.traces.get(matchId, steamId.trim());
    if (!trace) throw new NotFoundException(`Build debug trace not found for match ${matchId}`);
    return trace;
  }

  @Sse('matches/:matchId/stream')
  @UseGuards(BuildDebugAuthV2Guard)
  stream(@Param('matchId') matchId: string, @Query('steamId') steamId?: string): Observable<MessageEvent> {
    if (!steamId?.trim()) throw new BadRequestException('steamId is required');
    return this.traces.observe(matchId, steamId.trim()).pipe(
      map((trace) => ({ type: 'trace', data: trace })),
    );
  }
```

Add `BadRequestException` and `Query` to the `@nestjs/common` import. In `build-debug-v2.client.ts`, append `&steamId=<steamId>` to any call to `matches/:matchId` or its stream, taking `steamId` from the selected row of `GET matches`.

- [ ] **Step 4: Run the tests**

Run: `yarn workspace @deadlock-live-probe/api test -- test/build-debug-v2.controller.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/build-debug-v2/build-debug-v2.controller.ts apps/api/src/build-debug-v2/build-debug-v2.client.ts apps/api/test/build-debug-v2.controller.spec.ts
git commit -m "feat(api): address debug traces by player"
```

---

## Part B — build iteration history

### Task 6: History table and entity

**Files:**
- Create: `apps/api/src/database/migrations/1789315200000-create-adaptive-build-iterations-v1.ts`
- Create: `apps/api/src/deadlock-live/entities/adaptive-build-iteration-v1.entity.ts`
- Modify: `apps/api/src/database/database-entities.ts`
- Modify: `apps/api/src/statlocker-adaptive/statlocker-adaptive.module.ts`

**Interfaces:**
- Produces: `AdaptiveBuildIterationV1Entity` with fields `id, matchId, steamId, heroId, gameTimeSec, kind, fingerprint, stateRevision, plan, rejects, archetype, score, evidence, context, blockers, truncated, pinned, capturedAt`; table `adaptive_build_iterations_v1`.

- [ ] **Step 1: Write the failing migration assertions**

In `apps/api/test/production-database-migration.integration.spec.ts` extend the "records the runtime migrations" list with `'CreateAdaptiveBuildIterationsV11789315200000'` and add:

```ts
  it('creates the build iteration history indexes', async () => {
    const indexes = (await dataSource.query(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'adaptive_build_iterations_v1'
       ORDER BY indexname`,
    )) as Array<{ indexname: string }>;
    const names = indexes.map((row) => row.indexname);

    expect(names).toContain('uq_build_iteration_plan_v1');
    expect(names).toContain('uq_build_iteration_not_ready_v1');
    expect(names).toContain('idx_build_iteration_match_v1');
    expect(names).toContain('idx_build_iteration_player_v1');
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `DB_MIGRATION_INTEGRATION=true yarn workspace @deadlock-live-probe/api test -- test/production-database-migration.integration.spec.ts`
Expected: FAIL — relation `adaptive_build_iterations_v1` does not exist.

- [ ] **Step 3: Write the migration**

Create `apps/api/src/database/migrations/1789315200000-create-adaptive-build-iterations-v1.ts`:

```ts
import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAdaptiveBuildIterationsV11789315200000 implements MigrationInterface {
  name = 'CreateAdaptiveBuildIterationsV11789315200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "adaptive_build_iterations_v1" (
        "id" bigserial NOT NULL,
        "matchId" varchar(128) NOT NULL,
        "steamId" varchar(32) NOT NULL,
        "heroId" integer,
        "gameTimeSec" integer,
        "kind" varchar(16) NOT NULL,
        "fingerprint" char(64) NOT NULL,
        "stateRevision" varchar(64) NOT NULL,
        "plan" jsonb,
        "rejects" jsonb,
        "archetype" jsonb,
        "score" jsonb NOT NULL,
        "evidence" jsonb NOT NULL,
        "context" jsonb NOT NULL,
        "blockers" jsonb,
        "truncated" boolean NOT NULL DEFAULT false,
        "pinned" boolean NOT NULL DEFAULT false,
        "capturedAt" timestamptz NOT NULL,
        CONSTRAINT "PK_adaptive_build_iterations_v1" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      COMMENT ON TABLE "adaptive_build_iterations_v1" IS
      'Per-iteration recommendation history for incident review only. Never a training corpus (ADR-007).'
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN "adaptive_build_iterations_v1"."rejects" IS
      'Candidates rejected or suppressed by hysteresis. Incident review only (ADR-007).'
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_build_iteration_plan_v1"
      ON "adaptive_build_iterations_v1" ("matchId", "steamId", "fingerprint")
      WHERE "kind" = 'PLAN'
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_build_iteration_not_ready_v1"
      ON "adaptive_build_iterations_v1" ("matchId", "steamId", "fingerprint")
      WHERE "kind" = 'NOT_READY'
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_build_iteration_match_v1"
      ON "adaptive_build_iterations_v1" ("matchId", "capturedAt")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_build_iteration_player_v1"
      ON "adaptive_build_iterations_v1" ("steamId", "capturedAt" DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_build_iteration_retention_v1"
      ON "adaptive_build_iterations_v1" ("capturedAt")
      WHERE "pinned" = false
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "adaptive_build_iterations_v1"');
  }
}
```

- [ ] **Step 4: Write the entity**

Create `apps/api/src/deadlock-live/entities/adaptive-build-iteration-v1.entity.ts`:

```ts
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Build iteration history for incident review only.
 * Never a training corpus — see ADR-007.
 */
@Entity('adaptive_build_iterations_v1')
@Index('idx_build_iteration_match_v1', ['matchId', 'capturedAt'])
@Index('idx_build_iteration_player_v1', ['steamId', 'capturedAt'])
export class AdaptiveBuildIterationV1Entity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ type: 'varchar', length: 128 })
  matchId!: string;

  @Column({ type: 'varchar', length: 32 })
  steamId!: string;

  @Column({ type: 'int', nullable: true })
  heroId?: number | null;

  @Column({ type: 'int', nullable: true })
  gameTimeSec?: number | null;

  @Column({ type: 'varchar', length: 16 })
  kind!: 'PLAN' | 'NOT_READY';

  @Column({ type: 'char', length: 64 })
  fingerprint!: string;

  @Column({ type: 'varchar', length: 64 })
  stateRevision!: string;

  @Column({ type: 'jsonb', nullable: true })
  plan?: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  rejects?: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  archetype?: Record<string, unknown> | null;

  @Column({ type: 'jsonb' })
  score!: Record<string, unknown>;

  @Column({ type: 'jsonb' })
  evidence!: Record<string, unknown>;

  @Column({ type: 'jsonb' })
  context!: Record<string, unknown>;

  @Column({ type: 'jsonb', nullable: true })
  blockers?: string[] | null;

  @Column({ type: 'boolean', default: false })
  truncated!: boolean;

  @Column({ type: 'boolean', default: false })
  pinned!: boolean;

  @Column({ type: 'timestamptz' })
  capturedAt!: Date;
}
```

- [ ] **Step 5: Register the entity**

`apps/api/src/database/database-entities.ts`: import `AdaptiveBuildIterationV1Entity` and add it to `DATABASE_ENTITIES` as the last entry.

`apps/api/src/statlocker-adaptive/statlocker-adaptive.module.ts`: add the import and append `AdaptiveBuildIterationV1Entity` to the `TypeOrmModule.forFeature([...])` array.

- [ ] **Step 6: Run the migration assertions**

Run: `DB_MIGRATION_INTEGRATION=true yarn workspace @deadlock-live-probe/api test -- test/production-database-migration.integration.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/database/migrations/1789315200000-create-adaptive-build-iterations-v1.ts apps/api/src/deadlock-live/entities/adaptive-build-iteration-v1.entity.ts apps/api/src/database/database-entities.ts apps/api/src/statlocker-adaptive/statlocker-adaptive.module.ts apps/api/test/production-database-migration.integration.spec.ts
git commit -m "feat(api): add the build iteration history table"
```

---

### Task 7: Fingerprints, reject extraction, size bounding

**Files:**
- Create: `apps/api/src/statlocker-adaptive/build-iteration-fingerprint-v1.ts`
- Test: `apps/api/test/build-iteration-fingerprint-v1.spec.ts`

**Interfaces:**
- Consumes: `AdaptiveFullBuildStepV2` (shared), `BuildDecisionTraceStageEntryV2` (Task 3).
- Produces:
  - `type BuildIterationKindV1 = 'PLAN' | 'NOT_READY'`
  - `planFingerprintV1(steps: readonly AdaptiveFullBuildStepV2[]): string`
  - `blockerFingerprintV1(blockers: readonly string[]): string`
  - `extractRejectsV1(stages: readonly BuildDecisionTraceStageEntryV2[]): BuildIterationRejectsV1`
  - `projectPlanForStorageV1(plan: AdaptiveFullBuildPlanV2, maxBytes: number): { payload: Record<string, unknown>; truncated: boolean }`
  - `boundRejectsForStorageV1(rejects: BuildIterationRejectsV1, maxBytes: number): { payload: Record<string, unknown>; truncated: boolean }`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/build-iteration-fingerprint-v1.spec.ts`:

```ts
import {
  blockerFingerprintV1,
  boundRejectsForStorageV1,
  extractRejectsV1,
  planFingerprintV1,
  projectPlanForStorageV1,
} from '../src/statlocker-adaptive/build-iteration-fingerprint-v1';
import { AdaptiveFullBuildStepV2 } from '@deadlock-live-probe/shared';

function step(overrides: Partial<AdaptiveFullBuildStepV2>): AdaptiveFullBuildStepV2 {
  return {
    sequence: 1,
    action: 'BUY',
    buyItemId: 100,
    consumedItemIds: [],
    inventoryBefore: [],
    inventoryAfter: [],
    reasonCodes: [],
    ...overrides,
  };
}

describe('build iteration fingerprints', () => {
  it('treats step order as significant and distinguishes A -> B -> A', () => {
    const a = [step({ sequence: 1, buyItemId: 100 })];
    const b = [step({ sequence: 1, buyItemId: 200 })];

    expect(planFingerprintV1(a)).not.toBe(planFingerprintV1(b));
    expect(planFingerprintV1(a)).toBe(planFingerprintV1([step({ sequence: 1, buyItemId: 100 })]));
    expect(planFingerprintV1(a)).not.toBe(planFingerprintV1([...a, ...b]));
  });

  it('ignores blocker order and duplicates', () => {
    expect(blockerFingerprintV1(['B', 'A', 'A'])).toBe(blockerFingerprintV1(['A', 'B']));
    expect(blockerFingerprintV1(['A'])).not.toBe(blockerFingerprintV1(['B']));
  });

  it('keeps only rejected and hysteresis-suppressed candidates', () => {
    const rejects = extractRejectsV1([
      {
        stage: 'ARCHETYPE_SELECTION',
        reasonCodes: [],
        payload: {
          enemyHeroIds: [10],
          wpaQueryCount: 1,
          fallbackUsed: false,
          candidates: [
            { candidateId: 'archetype:a', archetypeId: 'a', disposition: 'SELECTED', reasonCodes: [] },
            { candidateId: 'archetype:b', archetypeId: 'b', disposition: 'REJECTED', reasonCodes: ['LOW_COVERAGE'] },
          ],
        },
      },
      {
        stage: 'PLAN_SEARCH',
        reasonCodes: [],
        payload: {
          branches: [
            { sequence: 1, targetItemId: 100, action: 'BUY', disposition: 'SUPPRESSED_BY_HYSTERESIS', reasonCodes: ['HYSTERESIS_GATE'] },
          ],
        },
      },
      { stage: 'LIVE_CONTEXT', reasonCodes: [], payload: { gameTimeSec: 600, inventoryItemIds: [], capacity: 9, enemyThreats: [] } },
    ] as any);

    expect(rejects.totalRejected).toBe(2);
    expect(rejects.stages.map((entry) => entry.stage)).toEqual(['ARCHETYPE_SELECTION', 'PLAN_SEARCH']);
    expect(rejects.stages[0].entries[0]).toEqual({
      disposition: 'REJECTED',
      archetypeId: 'b',
      reasonCodes: ['LOW_COVERAGE'],
    });
    expect(rejects.stages[1].entries[0].disposition).toBe('SUPPRESSED_BY_HYSTERESIS');
  });

  it('drops inventory snapshots when the plan exceeds the size cap', () => {
    const big = Array.from({ length: 400 }, (_, index) =>
      step({
        sequence: index + 1,
        buyItemId: 100 + index,
        inventoryBefore: Array.from({ length: 60 }, (__, i) => i),
        inventoryAfter: Array.from({ length: 60 }, (__, i) => i + 1),
      }),
    );
    const plan = {
      planRevision: 'rev-1',
      steps: big,
      degradedReasons: [],
      validation: { valid: true, reasonCodes: [] },
    };

    expect(projectPlanForStorageV1(plan, 64 * 1024).truncated).toBe(false);
    const compacted = projectPlanForStorageV1(plan, 4 * 1024);
    expect(compacted.truncated).toBe(true);
    expect(compacted.payload.steps).toHaveLength(400);
    expect((compacted.payload.steps as any[])[0].inventoryBefore).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `yarn workspace @deadlock-live-probe/api test -- test/build-iteration-fingerprint-v1.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/api/src/statlocker-adaptive/build-iteration-fingerprint-v1.ts`:

```ts
import { createHash } from 'node:crypto';
import { AdaptiveFullBuildPlanV2, AdaptiveFullBuildStepV2 } from '@deadlock-live-probe/shared';
import { BuildDecisionTraceStageEntryV2 } from './build-decision-trace-v2';

export type BuildIterationKindV1 = 'PLAN' | 'NOT_READY';
export type BuildIterationRejectDispositionV1 = 'REJECTED' | 'SUPPRESSED_BY_HYSTERESIS';

export interface BuildIterationRejectEntryV1 {
  disposition: BuildIterationRejectDispositionV1;
  itemId?: number;
  archetypeId?: string;
  sellItemId?: number;
  buyItemId?: number;
  reasonCodes: readonly string[];
}

export interface BuildIterationRejectStageV1 {
  stage: string;
  entries: readonly BuildIterationRejectEntryV1[];
}

export interface BuildIterationRejectsV1 {
  stages: readonly BuildIterationRejectStageV1[];
  totalRejected: number;
}

export function planFingerprintV1(steps: readonly AdaptiveFullBuildStepV2[]): string {
  const canonical = steps
    .map((step) => [step.action, step.buyItemId, step.sellItemId ?? '', step.recipeId ?? ''].join('|'))
    .join(';');
  return sha256(canonical);
}

export function blockerFingerprintV1(blockers: readonly string[]): string {
  return sha256([...new Set(blockers)].sort().join('|'));
}

export function extractRejectsV1(
  stages: readonly BuildDecisionTraceStageEntryV2[],
): BuildIterationRejectsV1 {
  const collected: BuildIterationRejectStageV1[] = [];

  for (const entry of stages) {
    const entries = rejectsOfStage(entry);
    if (entries.length === 0) continue;
    collected.push({ stage: entry.stage, entries });
  }

  return {
    stages: collected,
    totalRejected: collected.reduce((total, stage) => total + stage.entries.length, 0),
  };
}

function rejectsOfStage(entry: BuildDecisionTraceStageEntryV2): BuildIterationRejectEntryV1[] {
  if (entry.stage === 'ARCHETYPE_SELECTION' || entry.stage === 'CANDIDATE_DISCOVERY') {
    return entry.payload.candidates
      .filter(isRejected)
      .map((candidate) => ({
        disposition: candidate.disposition as BuildIterationRejectDispositionV1,
        ...(candidate.itemId === undefined ? {} : { itemId: candidate.itemId }),
        ...(candidate.archetypeId === undefined ? {} : { archetypeId: candidate.archetypeId }),
        reasonCodes: [...candidate.reasonCodes],
      }));
  }
  if (entry.stage === 'CHOICE_RESOLUTION') {
    return entry.payload.groups.flatMap((group) =>
      group.candidates.filter(isRejected).map((candidate) => ({
        disposition: candidate.disposition as BuildIterationRejectDispositionV1,
        ...(candidate.itemId === undefined ? {} : { itemId: candidate.itemId }),
        reasonCodes: [...candidate.reasonCodes],
      })),
    );
  }
  if (entry.stage === 'PLAN_SEARCH') {
    return entry.payload.branches
      .filter(isRejected)
      .map((branch) => ({
        disposition: branch.disposition as BuildIterationRejectDispositionV1,
        itemId: branch.targetItemId,
        reasonCodes: [...branch.reasonCodes],
      }));
  }
  if (entry.stage === 'REPLACEMENT_SEARCH') {
    return entry.payload.candidates
      .filter(isRejected)
      .map((candidate) => ({
        disposition: candidate.disposition as BuildIterationRejectDispositionV1,
        sellItemId: candidate.sellItemId,
        buyItemId: candidate.buyItemId,
        reasonCodes: [...candidate.reasonCodes],
      }));
  }
  return [];
}

function isRejected(candidate: { disposition: string }): boolean {
  return candidate.disposition === 'REJECTED' || candidate.disposition === 'SUPPRESSED_BY_HYSTERESIS';
}

export function projectPlanForStorageV1(
  plan: AdaptiveFullBuildPlanV2,
  maxBytes: number,
): { payload: Record<string, unknown>; truncated: boolean } {
  const full = JSON.parse(JSON.stringify(plan)) as Record<string, unknown>;
  if (byteSize(full) <= maxBytes) return { payload: full, truncated: false };

  const compact = {
    ...full,
    steps: (plan.steps as AdaptiveFullBuildStepV2[]).map((step) => ({
      sequence: step.sequence,
      action: step.action,
      buyItemId: step.buyItemId,
      ...(step.sellItemId === undefined ? {} : { sellItemId: step.sellItemId }),
      ...(step.recipeId === undefined ? {} : { recipeId: step.recipeId }),
      reasonCodes: [...step.reasonCodes],
    })),
    ...(full.semanticValidation === undefined
      ? {}
      : { semanticValidation: { ...(full.semanticValidation as Record<string, unknown>), finalFamilyStates: [] } }),
  };
  return { payload: compact, truncated: true };
}

export function boundRejectsForStorageV1(
  rejects: BuildIterationRejectsV1,
  maxBytes: number,
): { payload: Record<string, unknown>; truncated: boolean } {
  let stages = rejects.stages.map((stage) => ({ stage: stage.stage, entries: [...stage.entries] }));
  const asPayload = () => ({ stages, totalRejected: rejects.totalRejected });

  if (byteSize(asPayload()) <= maxBytes) return { payload: asPayload() as unknown as Record<string, unknown>, truncated: false };

  while (stages.some((stage) => stage.entries.length > 0)) {
    stages = stages.map((stage) => ({ stage: stage.stage, entries: stage.entries.slice(0, Math.floor(stage.entries.length / 2)) }));
    if (byteSize(asPayload()) <= maxBytes) break;
  }
  return { payload: asPayload() as unknown as Record<string, unknown>, truncated: true };
}

function byteSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
```

- [ ] **Step 4: Run the tests**

Run: `yarn workspace @deadlock-live-probe/api test -- test/build-iteration-fingerprint-v1.spec.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/statlocker-adaptive/build-iteration-fingerprint-v1.ts apps/api/test/build-iteration-fingerprint-v1.spec.ts
git commit -m "feat(api): add build iteration fingerprints and reject extraction"
```

---

### Task 8: History service with conflict-based dedupe and retention

**Files:**
- Create: `apps/api/src/statlocker-adaptive/build-iteration-capture-v1.ts`
- Create: `apps/api/src/statlocker-adaptive/build-iteration-history-v1.service.ts`
- Modify: `apps/api/src/statlocker-adaptive/statlocker-adaptive.module.ts`
- Test: `apps/api/test/build-iteration-history-v1.spec.ts`

**Interfaces:**
- Consumes: `AdaptiveBuildIterationV1Entity` (Task 6), fingerprint module (Task 7).
- Produces:
  - `class BuildIterationCaptureV1` with mutable fields `steamId?, heroId?, gameTimeSec?, capacity?, inventoryItemIds?, spendableSouls?, enemyHeroIds?, enemyThreats?, archetype?, evidence?, stages?`
  - `BuildIterationHistoryV1Service.record(input: RecordBuildIterationV1Input): Promise<void>`
  - `BuildIterationHistoryV1Service.cleanupExpired(passLimit?: number): Promise<number>`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/build-iteration-history-v1.spec.ts`:

```ts
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

    expect(repo.rows.map((row) => row.steamId).sort()).toEqual(['steam-111', 'steam-222']);
  });

  it('records not-ready transitions with the blocker set', async () => {
    const repo = repository();
    const service = new BuildIterationHistoryV1Service(repo);
    const notReady = { ready: false, blockers: ['ENEMY_ROSTER_INCOMPLETE'], decisionId: 'd-2', stateRevision: 'rev-2', heroId: 72, nextAction: { type: 'HOLD', reasonCodes: [] }, score: { total: 0, confidence: 0 }, degradedReasons: [] } as any;

    await service.record({ matchId: 'match-1', steamId: 'steam-111', result: notReady });
    await service.record({ matchId: 'match-1', steamId: 'steam-111', result: notReady });
    await service.record({ matchId: 'match-1', steamId: 'steam-111', result: readyResult, capture: capture() });

    expect(repo.rows.map((row) => row.kind)).toEqual(['NOT_READY', 'PLAN']);
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
```

- [ ] **Step 2: Run to verify failure**

Run: `yarn workspace @deadlock-live-probe/api test -- test/build-iteration-history-v1.spec.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the capture object**

Create `apps/api/src/statlocker-adaptive/build-iteration-capture-v1.ts`:

```ts
import { AdaptiveEvidenceSummaryV2 } from '@deadlock-live-probe/shared';
import { EnemyThreatScoreV1 } from './enemy-threat-v1.service';
import { BuildDecisionTraceStageEntryV2 } from './build-decision-trace-v2';

/**
 * Request-scoped carrier: the recommendation service drops the objects it
 * already holds here, the controller writes them to the history table.
 */
export class BuildIterationCaptureV1 {
  steamId?: string;
  heroId?: number;
  gameTimeSec?: number;
  capacity?: number;
  inventoryItemIds?: readonly number[];
  spendableSouls?: number;
  enemyHeroIds?: readonly number[];
  enemyThreats?: readonly EnemyThreatScoreV1[];
  archetype?: { archetypeId: string; snapshotId: string; scores: readonly { archetypeId: string; score: number; confidence: number }[] };
  evidence?: AdaptiveEvidenceSummaryV2;
  stages?: readonly BuildDecisionTraceStageEntryV2[];
}
```

- [ ] **Step 4: Write the service**

Create `apps/api/src/statlocker-adaptive/build-iteration-history-v1.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { AdaptiveRecommendationResultV2 } from '@deadlock-live-probe/shared';
import { AdaptiveBuildIterationV1Entity } from '../deadlock-live/entities/adaptive-build-iteration-v1.entity';
import { BuildIterationCaptureV1 } from './build-iteration-capture-v1';
import {
  blockerFingerprintV1,
  boundRejectsForStorageV1,
  extractRejectsV1,
  planFingerprintV1,
  projectPlanForStorageV1,
} from './build-iteration-fingerprint-v1';

const DEFAULT_MAX_JSON_KB = 64;
const DEFAULT_MATCH_LENGTH_SEC = 3 * 60 * 60;

export interface RecordBuildIterationV1Input {
  matchId: string;
  steamId: string;
  result: AdaptiveRecommendationResultV2;
  capture?: BuildIterationCaptureV1;
}

@Injectable()
export class BuildIterationHistoryV1Service {
  private readonly logger = new Logger(BuildIterationHistoryV1Service.name);
  private readonly maxJsonBytes = readPositiveInteger(process.env.ADAPTIVE_BUILD_ITERATION_MAX_JSON_KB, DEFAULT_MAX_JSON_KB) * 1024;

  constructor(
    @InjectRepository(AdaptiveBuildIterationV1Entity)
    private readonly repository: Repository<AdaptiveBuildIterationV1Entity>,
  ) {}

  async record(input: RecordBuildIterationV1Input): Promise<void> {
    try {
      await this.repository
        .createQueryBuilder()
        .insert()
        .into(AdaptiveBuildIterationV1Entity)
        .values(this.buildRow(input))
        .orIgnore()
        .execute();
    } catch (error) {
      this.logger.warn(`Build iteration history write failed: ${describeError(error)}`);
    }
  }

  @Cron('0 * * * *')
  async cleanupExpired(passLimit = 5000): Promise<number> {
    const days = readPositiveInteger(process.env.ADAPTIVE_BUILD_ITERATION_TTL_DAYS, 30);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    try {
      const result = await this.repository
        .createQueryBuilder()
        .delete()
        .from(AdaptiveBuildIterationV1Entity)
        .where('pinned = false')
        .andWhere({ capturedAt: LessThan(cutoff) })
        .execute();
      return result.affected ?? 0;
    } catch (error) {
      this.logger.warn(`Build iteration history cleanup failed: ${describeError(error)}`);
      return 0;
    }
  }

  private buildRow(input: RecordBuildIterationV1Input): Record<string, unknown> {
    const { result, capture } = input;
    const steamId = (capture?.steamId ?? input.steamId).slice(0, 32);
    const steps = result.fullBuild?.steps ?? [];
    const blockers = [...(result.blockers ?? [])].sort();
    const captureStages = capture?.stages ?? [];

    const plan = result.fullBuild
      ? projectPlanForStorageV1(result.fullBuild, this.maxJsonBytes)
      : { payload: null, truncated: false };
    const rejects = boundRejectsForStorageV1(extractRejectsV1(captureStages), this.maxJsonBytes);

    return {
      matchId: input.matchId,
      steamId,
      heroId: capture?.heroId ?? result.heroId ?? null,
      gameTimeSec: capture?.gameTimeSec ?? null,
      kind: result.ready ? 'PLAN' : 'NOT_READY',
      fingerprint: result.ready ? planFingerprintV1(steps) : blockerFingerprintV1(blockers),
      stateRevision: result.stateRevision.slice(0, 64),
      plan: plan.payload,
      rejects: rejects.payload,
      archetype: capture?.archetype ? { ...capture.archetype } : null,
      score: { ...(result.score ?? { total: 0, confidence: 0 }) },
      evidence: buildEvidencePayload(result, capture),
      context: buildContextPayload(capture),
      blockers: result.ready ? null : blockers,
      truncated: plan.truncated || rejects.truncated,
      pinned: false,
      capturedAt: new Date(),
    };
  }
}

function buildEvidencePayload(
  result: AdaptiveRecommendationResultV2,
  capture?: BuildIterationCaptureV1,
): Record<string, unknown> {
  const summary = capture?.evidence ?? result.evidence;
  if (!summary) return { families: [], degradedReasons: [...(result.degradedReasons ?? [])] };
  return {
    rulesetVersion: summary.rulesetVersion,
    catalogSha256: summary.catalogSha256,
    statlockerPatchId: summary.statlockerPatchId,
    sourceProfileCount: summary.sourceProfileCount,
    families: summary.families.map((family) => ({
      dataset: family.dataset,
      available: family.available,
      rowCount: family.rowCount ?? null,
      reasonCodes: [...family.reasonCodes],
    })),
    degradedReasons: [...(summary.degradedReasons ?? [])],
  };
}

function buildContextPayload(capture?: BuildIterationCaptureV1): Record<string, unknown> {
  return {
    capacity: capture?.capacity ?? null,
    inventoryItemIds: [...(capture?.inventoryItemIds ?? [])],
    spendableSouls: typeof capture?.spendableSouls === 'number' ? capture.spendableSouls : null,
    enemyHeroIds: [...(capture?.enemyHeroIds ?? [])],
    enemyThreats: (capture?.enemyThreats ?? []).map((threat) => ({
      heroId: threat.heroId,
      threatMultiplier: threat.threatMultiplier,
      completeness: threat.completeness,
      reasonCodes: [...threat.reasonCodes],
    })),
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readPositiveInteger(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
```

Register `BuildIterationHistoryV1Service` in the `providers` and `exports` arrays of `statlocker-adaptive.module.ts`.

- [ ] **Step 5: Run the tests**

Run: `yarn workspace @deadlock-live-probe/api test -- test/build-iteration-history-v1.spec.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/statlocker-adaptive/build-iteration-capture-v1.ts apps/api/src/statlocker-adaptive/build-iteration-history-v1.service.ts apps/api/src/statlocker-adaptive/statlocker-adaptive.module.ts apps/api/test/build-iteration-history-v1.spec.ts
git commit -m "feat(api): record build iterations with conflict-based dedupe"
```

---

### Task 9: Fill the capture and write from the controller

**Files:**
- Modify: `apps/api/src/statlocker-adaptive/adaptive-recommendation-v2.service.ts`
- Modify: `apps/api/src/statlocker-adaptive/adaptive-recommendation-v2.controller.ts`
- Test: `apps/api/test/adaptive-recommendation-v2.controller.spec.ts`

**Interfaces:**
- Consumes: `BuildIterationCaptureV1` (Task 8), `BuildIterationHistoryV1Service.record` (Task 8).
- Produces: `recommend(request: AdaptiveRecommendationRequestV2, capture?: BuildIterationCaptureV1)`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/adaptive-recommendation-v2.controller.spec.ts`:

```ts
import { AdaptiveRecommendationV2Controller } from '../src/statlocker-adaptive/adaptive-recommendation-v2.controller';
import { AdaptiveLiveStateNotReadyError } from '../src/statlocker-adaptive/adaptive-decision-state-v1.service';

function controllerWith(recommend: jest.Mock, record: jest.Mock, liveState: any = { getState: () => undefined }) {
  return new AdaptiveRecommendationV2Controller({ recommend } as any, { record } as any, liveState as any);
}

describe('AdaptiveRecommendationV2Controller history hook', () => {
  it('records the iteration with the steamId resolved by the service', async () => {
    const record = jest.fn().mockResolvedValue(undefined);
    const controller = controllerWith(
      jest.fn(async (_request: any, capture: any) => {
        capture.steamId = 'steam-222';
        return { ready: true, blockers: [], stateRevision: 'rev-1', score: { total: 1, confidence: 1 }, nextAction: { type: 'BUY', reasonCodes: [] } };
      }),
      record,
    );

    await controller.recommend({ matchId: 'match-1' });

    expect(record).toHaveBeenCalledWith(expect.objectContaining({ matchId: 'match-1', steamId: 'steam-222' }));
  });

  it('records a not-ready answer and still returns it', async () => {
    const record = jest.fn().mockResolvedValue(undefined);
    const controller = controllerWith(
      jest.fn().mockRejectedValue(new AdaptiveLiveStateNotReadyError('match-1', 'LIVE_MATCH_STATE_UNAVAILABLE')),
      record,
    );

    const result = await controller.recommend({ matchId: 'match-1' });

    expect(result.ready).toBe(false);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ matchId: 'match-1', steamId: 'unknown' }));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `yarn workspace @deadlock-live-probe/api test -- test/adaptive-recommendation-v2.controller.spec.ts`
Expected: FAIL — the controller constructor takes one argument.

- [ ] **Step 3: Implement the controller hook**

In `adaptive-recommendation-v2.controller.ts`:

```ts
  constructor(
    private readonly recommendation: AdaptiveRecommendationV2Service,
    private readonly history: BuildIterationHistoryV1Service,
    private readonly liveState: LiveMatchStateService,
  ) {}

  @Post('recommend')
  async recommend(@Body() body: AdaptiveRecommendationRequestV2): Promise<AdaptiveRecommendationResultV2> {
    if (!body || typeof body.matchId !== 'string' || body.matchId.trim() === '') {
      throw new BadRequestException('matchId is required');
    }
    if (
      body.localSteamId !== undefined &&
      (typeof body.localSteamId !== 'string' || body.localSteamId.trim() === '')
    ) {
      throw new BadRequestException('localSteamId is invalid');
    }
    const request: AdaptiveRecommendationRequestV2 = {
      matchId: body.matchId.trim(),
      ...(body.localSteamId === undefined ? {} : { localSteamId: body.localSteamId.trim() }),
    };
    const capture = new BuildIterationCaptureV1();
    const fallbackSteamId = request.localSteamId ?? resolveMarkedLocalSteamId(this.liveState, request.matchId);

    let result: AdaptiveRecommendationResultV2;
    try {
      result = await this.recommendation.recommend(request, capture);
    } catch (error) {
      if (error instanceof AdaptiveLiveStateNotReadyError) {
        result = waitingRecommendation(request.matchId, error.blocker);
      } else {
        throw error;
      }
    }

    await this.history.record({
      matchId: request.matchId,
      steamId: capture.steamId ?? fallbackSteamId ?? 'unknown',
      result,
      capture,
    });
    return result;
  }
```

with this module-level helper next to `waitingRecommendation`:

```ts
function resolveMarkedLocalSteamId(liveState: LiveMatchStateService, matchId: string): string | undefined {
  const state = liveState.getState(matchId);
  if (!state) return undefined;
  const marked = Object.values(state.playersBySteamId).filter((player) => player.isLocal);
  return marked.length === 1 ? marked[0].steamId : undefined;
}
```

- [ ] **Step 4: Fill the capture in the service**

In `adaptive-recommendation-v2.service.ts` change the signature and fill it on every return path that has data:

```ts
  async recommend(
    request: AdaptiveRecommendationRequestV2,
    capture?: BuildIterationCaptureV1,
  ): Promise<AdaptiveRecommendationResultV2> {
```

Immediately after `const plan = this.resolver.resolve(resolverInput);` add:

```ts
    if (capture) {
      capture.steamId = decision.localSteamId;
      capture.heroId = decision.state.heroId;
      capture.gameTimeSec = decision.state.gameTimeSec;
      capture.capacity = Number(capacity);
      capture.inventoryItemIds = [...decision.state.inventory.heldByItemId.keys()];
      capture.spendableSouls = typeof decision.state.economy.spendableSouls.value === 'number'
        ? decision.state.economy.spendableSouls.value
        : undefined;
      capture.enemyHeroIds = [...enemyHeroIds];
      capture.enemyThreats = enemyThreats;
      capture.archetype = {
        archetypeId: lock.archetypeId,
        snapshotId: lock.snapshotId,
        scores: selection.scores.map((score) => ({
          archetypeId: score.archetypeId,
          score: score.score,
          confidence: score.confidence,
        })),
      };
      capture.evidence = evidenceSummary(snapshot, evidence, vsHeroRows.length);
      capture.stages = trace.stages();
    }
```

Register `LiveMatchStateService` availability: `StatlockerAdaptiveModule` already imports `DeadlockLiveModule`, which exports `LiveMatchStateService`.

- [ ] **Step 5: Run the tests**

Run: `yarn workspace @deadlock-live-probe/api test -- test/adaptive-recommendation-v2.controller.spec.ts test/adaptive-recommendation-v2.spec.ts`
Expected: PASS.

- [ ] **Step 6: Run the full api suite**

Run: `yarn workspace @deadlock-live-probe/api test`
Expected: PASS. `test/live-ingest-resilience.spec.ts` and `test/adaptive-recommendation-v2.e2e.spec.ts` need their constructor calls updated for the new controller arguments.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/statlocker-adaptive/adaptive-recommendation-v2.service.ts apps/api/src/statlocker-adaptive/adaptive-recommendation-v2.controller.ts apps/api/test/adaptive-recommendation-v2.controller.spec.ts apps/api/test/adaptive-recommendation-v2.e2e.spec.ts apps/api/test/live-ingest-resilience.spec.ts
git commit -m "feat(api): write build iterations from the recommend endpoint"
```

---

### Task 10: Retention and pin verification

**Files:**
- Modify: `apps/api/test/build-iteration-history-v1.spec.ts`
- Modify: `docs/database-migrations.md`

**Interfaces:**
- Consumes: `BuildIterationHistoryV1Service.cleanupExpired` (Task 8).
- Produces: documented `ADAPTIVE_BUILD_ITERATION_TTL_DAYS` and pin procedure.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/build-iteration-history-v1.spec.ts`:

```ts
  it('deletes only unpinned rows past the TTL', async () => {
    const executed: string[] = [];
    const repo = repository();
    repo.createQueryBuilder = jest.fn(() => ({
      delete: () => ({
        from: () => ({
          where: (clause: string) => ({
            andWhere: (condition: unknown) => ({
              execute: async () => {
                executed.push(clause, JSON.stringify(condition));
                return { affected: 7 };
              },
            }),
          }),
        }),
      }),
    }));
    const service = new BuildIterationHistoryV1Service(repo);

    const affected = await service.cleanupExpired();

    expect(affected).toBe(7);
    expect(executed[0]).toBe('pinned = false');
    expect(executed[1]).toContain('capturedAt');
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `yarn workspace @deadlock-live-probe/api test -- test/build-iteration-history-v1.spec.ts`
Expected: FAIL — `cleanupExpired` builds its delete differently than the fake expects, or the pinned filter is missing.

- [ ] **Step 3: Align the implementation**

Make `cleanupExpired` use exactly `where('pinned = false')` followed by `andWhere({ capturedAt: LessThan(cutoff) })`, and return `result.affected ?? 0`.

- [ ] **Step 4: Document retention and pin**

In `docs/database-migrations.md` add a section:

```markdown
## Build iteration history retention

`adaptive_build_iterations_v1` keeps per-iteration recommendation history for
incident review only (ADR-007 forbids using it as a training corpus).

- Retention: `ADAPTIVE_BUILD_ITERATION_TTL_DAYS` (default 30). The hourly
  cleanup job deletes unpinned rows older than the cutoff, 5000 rows per pass.
- Pin a match under review so cleanup skips it:
  `UPDATE adaptive_build_iterations_v1 SET pinned = true WHERE "matchId" = '<matchId>';`
- Row size: `ADAPTIVE_BUILD_ITERATION_MAX_JSON_KB` (default 64) caps the `plan`
  and `rejects` columns; a capped row stores `truncated = true`.
```

- [ ] **Step 5: Run the tests**

Run: `yarn workspace @deadlock-live-probe/api test -- test/build-iteration-history-v1.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/statlocker-adaptive/build-iteration-history-v1.service.ts apps/api/test/build-iteration-history-v1.spec.ts docs/database-migrations.md
git commit -m "feat(api): verify build iteration retention and document pinning"
```

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| A1 ADR-008 | done before the plan (commit `a99b8273`) |
| A2 lock migration | Task 1 |
| A3 session service | Task 2 |
| A4 trace store | Task 3 |
| A5 recommendation service | Task 4 |
| A6 debug endpoints | Task 5 |
| B1 table and indexes | Task 6 |
| B2 fingerprints and rejects | Task 7 |
| B3 `record()` and dedupe | Task 8 |
| B4 capture and controller hook | Task 9 |
| B5 retention and pin | Task 10 |
| Read path (SQL) | no code; queries live in the spec |
| Testing table | covered by each task's tests; the multi-player e2e assertion is in Task 4 Step 5 |

**Type consistency:** `BuildIterationCaptureV1` fields are used identically in Tasks 8 and 9 (`steamId`, `heroId`, `gameTimeSec`, `capacity`, `inventoryItemIds`, `spendableSouls`, `enemyHeroIds`, `enemyThreats`, `archetype`, `evidence`, `stages`). `planFingerprintV1` / `blockerFingerprintV1` / `extractRejectsV1` / `projectPlanForStorageV1` / `boundRejectsForStorageV1` keep the names and signatures from Task 7 in Task 8. `record()` takes `RecordBuildIterationV1Input` in both Task 8 and Task 9.

**Verified while writing the plan:** `ObservedFact<T>` in `packages/deadlock-build-domain/src/recommendation-action-domain.ts` is `{ value?: T; evidence: FactEvidence; source: string }`, so Task 9's read of `decision.state.economy.spendableSouls.value` is correct as written. `AdaptiveRecommendationResultV2.evidence` is optional, which is why `buildEvidencePayload` falls back to it when the capture has no summary.


---

### Task 11: Record the hysteresis outcome in the decision trace (added by controller ruling, 2026-09-14)

> Origin: the batch B-1 review proved that `SUPPRESSED_BY_HYSTERESIS` has no producer — the `PLAN_SEARCH` entry is recorded before the hysteresis decision and marks every branch `SELECTED`, and `payload.hysteresis` is never populated, so the history table's `rejects` column would never contain hysteresis suppressions despite design §B2 and the column comment promising them. Controller ruling: close the gap with this task, executed after Tasks 8–10 and before the final review.

**Files:**
- Modify: `apps/api/src/statlocker-adaptive/family-first-full-build-resolver-v2.service.ts`
- Test: `apps/api/test/adaptive-recommendation-v2-previous-plan-wiring.spec.ts` (extend; it already wires `previousPlan` + trace store)
- Optional: `apps/api/test/family-first-resolver-hysteresis-trace.spec.ts` (new, if cleaner)

**Interfaces:**
- Consumes: `FullBuildHysteresisV2Service.choose()` (returns `{ action, selected, requiredImprovement, reasonCodes }`), `BuildPlanSearchTracePayloadV2` (already has an optional `hysteresis: { action, improvement, requiredImprovement, reasonCodes }` field), `BuildDecisionTraceCollectorV2.record()`.
- Produces: `PLAN_SEARCH` trace entries that (a) populate `payload.hysteresis` whenever a previous plan existed and a decision was made, (b) mark the *selected* plan's steps `SELECTED`, and (c) mark the *candidate* plan's steps that did not survive the hysteresis decision as `SUPPRESSED_BY_HYSTERESIS` with the hysteresis `reasonCodes`. `extractRejectsV1` (Task 7) then stores them into history without further changes.

**Implementation (approved shape):**

1. Change `applyPreviousPlanHysteresis()` to also return the decision:

```ts
  private applyPreviousPlanHysteresis(
    input: FamilyFirstFullBuildLifetimeResolverV2Input,
    candidate: ResolvedFullBuildPlanV2,
  ): { plan: ResolvedFullBuildPlanV2; reasonCodes: readonly string[]; decision?: BuildPlanSwitchDecisionV2 } {
    const previous = input.previousPlan;
    if (
      !previous ||
      !previous.validation.valid ||
      previous.matchId !== candidate.matchId ||
      previous.heroId !== candidate.heroId ||
      previous.archetypeId !== candidate.archetypeId ||
      previous.stateRevision !== candidate.stateRevision
    ) {
      return { plan: candidate, reasonCodes: [] };
    }

    const decision = this.hysteresis.choose(previous, candidate, {
      improvement: desiredStateScore(candidate) - desiredStateScore(previous),
      coreReplacement: false,
      recentPurchaseProtected: hasProtectedRecentPurchase(input),
    });
    return { plan: decision.selected, reasonCodes: decision.reasonCodes, decision };
  }
```

2. Move the `PLAN_SEARCH` record to **after** the hysteresis decision and build the payload as:

```ts
    const hysteresis = selected.decision
      ? {
          action: selected.decision.action,
          improvement: selected.decision.improvement,
          requiredImprovement: selected.decision.requiredImprovement,
          reasonCodes: [...selected.decision.reasonCodes],
        }
      : undefined;
    const selectedKeys = new Set(
      selected.plan.steps.map((step) => stepSemanticTraceKey(step)),
    );
    const suppressed = hysteresis?.action === 'KEEP_PREVIOUS'
      ? candidate.steps
          .filter((step) => !selectedKeys.has(stepSemanticTraceKey(step)))
          .map((step, index) => ({
            sequence: selected.plan.steps.length + index + 1,
            targetItemId: step.buyItemId,
            action: step.action,
            disposition: 'SUPPRESSED_BY_HYSTERESIS' as const,
            reasonCodes: [...(hysteresis?.reasonCodes ?? [])],
          }))
      : [];
    input.trace?.record({
      stage: 'PLAN_SEARCH',
      reasonCodes: uniqueStrings([
        ...transactionPlan.reasonCodes,
        ...rejectedOutsideReasonCodes,
        ...(hysteresis?.reasonCodes ?? []),
      ]),
      payload: {
        branches: [
          ...selected.plan.steps.map((step, index) => ({
            sequence: index + 1,
            targetItemId: step.buyItemId,
            action: step.action,
            disposition: 'SELECTED' as const,
            reasonCodes: [
              ...step.reasonCodes,
              ...(hysteresis && hysteresis.action === 'SWITCH_TO_CANDIDATE'
                ? ['PLAN_HYSTERESIS_MARGIN_CLEARED']
                : []),
            ],
          })),
          ...suppressed,
        ],
        ...(hysteresis === undefined ? {} : { hysteresis }),
      },
    });
```

with a module-level helper identical to the hysteresis service's semantic key:

```ts
function stepSemanticTraceKey(step: FullBuildStepV2): string {
  return [step.action, step.buyItemId, step.sellItemId ?? '', step.recipeId ?? ''].join(':');
}
```

Import `BuildPlanSearchTracePayloadV2` and `BuildPlanSwitchDecisionV2` from their existing modules; do not widen any public API. The current PLAN_SEARCH record (recorded before SEMANTIC_VALIDATION) is removed and replaced by the post-hysteresis record; the SEMANTIC_VALIDATION and FINAL_PLAN records stay where they are.

**Tests (three scenarios, assert against `traceStore.revisions(...).stages`):**

- KEEP_PREVIOUS: with a valid `previousPlan` whose improvement margin is not cleared, the PLAN_SEARCH payload has `hysteresis.action === 'KEEP_PREVIOUS'` and `reasonCodes` containing `PLAN_HYSTERESIS_MARGIN_NOT_CLEARED`; the candidate step that differs from the selected plan appears once with `disposition === 'SUPPRESSED_BY_HYSTERESIS'`; the selected steps are `SELECTED`.
- SWITCH_TO_CANDIDATE: with a margin above `requiredImprovement`, `hysteresis.action === 'SWITCH_TO_CANDIDATE'`, no suppressed branches, and selected steps carry `PLAN_HYSTERESIS_MARGIN_CLEARED` in their `reasonCodes`.
- No previous plan: `payload.hysteresis` is absent and every branch is `SELECTED`.

Build the resolver fixture the way `adaptive-recommendation-v2-previous-plan-wiring.spec.ts` already does (it wires `previousPlan` and a trace store; extend that spec rather than inventing a new harness). Run that spec after each edit; run the full api suite before committing; keep the existing e2e green.

- [ ] **Step 1: Write the failing test** (KEEP_PREVIOUS scenario asserts `payload.hysteresis` and the `SUPPRESSED_BY_HYSTERESIS` branch — it fails because the payload never carries them).
- [ ] **Step 2: Run it to verify the failure**: `yarn workspace @deadlock-live-probe/api test -- test/adaptive-recommendation-v2-previous-plan-wiring.spec.ts` — expect FAIL on the missing `hysteresis` payload / missing suppressed branch.
- [ ] **Step 3: Implement** the two changes above.
- [ ] **Step 4: Run the spec** — expect PASS; add the SWITCH and no-previous-plan scenarios and keep them green.
- [ ] **Step 5: Full api suite** — `yarn workspace @deadlock-live-probe/api test` — expected green (existing PLAN_SEARCH order-dependent tests may need their expectations moved with the record).
- [ ] **Step 6: Commit** `feat(api): record hysteresis outcome in the plan-search trace`.


---

### Task 12: Record every state change — previous-state dedupe (added by controller ruling, 2026-09-14)

> Origin: the user's requirement is explicit — A → B → A must produce THREE history rows ("если после Б опять А, то тоже записали"), while five unchanged ticks produce one. The Task 8 fingerprint unique indexes `(matchId, steamId, fingerprint)` collapse the returning A into the first row, so the schema cannot express the requirement. Task 8 review confirmed the oscillation loss ("state oscillation PLAN → NOT_READY → PLAN is deduped against the first PLAN row"). Ruling: replace unique-index dedupe with previous-state comparison.

**Files:**
- Modify: `apps/api/src/database/migrations/1789315200000-create-adaptive-build-iterations-v1.ts`
- Modify: `apps/api/test/production-database-migration.integration.spec.ts`
- Modify: `apps/api/src/statlocker-adaptive/build-iteration-history-v1.service.ts`
- Modify: `apps/api/test/build-iteration-history-v1.spec.ts`

**Interfaces:**
- Consumes: `AdaptiveBuildIterationV1Entity`, the fingerprint module (unchanged), `BuildIterationCaptureV1`.
- Produces: `record()` that inserts exactly when the emitted state (`kind` + `fingerprint`) differs from the LAST stored row for that `(matchId, steamId)` — across kinds. The migration no longer carries `uq_build_iteration_plan_v1` / `uq_build_iteration_not_ready_v1`; it gains `idx_build_iteration_last_v1 ON ("matchId", "steamId", "id" DESC)` for the latest-row lookup. `cleanupExpired(passLimit)` from Task 10 stays as is.

**Migration edit (amend the unmerged migration, do not add a second one):**

Remove the two `CREATE UNIQUE INDEX ... uq_build_iteration_*` statements and their `WHERE kind = ...` predicates; add:

```sql
      CREATE INDEX IF NOT EXISTS "idx_build_iteration_last_v1"
      ON "adaptive_build_iterations_v1" ("matchId", "steamId", "id" DESC)
```

Update the integration spec's index assertions (`creates the build iteration history indexes`): the four required names become `idx_build_iteration_last_v1`, `idx_build_iteration_match_v1`, `idx_build_iteration_player_v1`, `idx_build_iteration_retention_v1` — the two `uq_*` names are gone. Add one scenario to the live-DB spec: run the integration migration, insert a PLAN row for (m, s) with fingerprint X, then insert the same fingerprint again — both must succeed (no unique violation).

**Service change (`record()`):**

```ts
  private readonly lastWritten = new Map<
    string,
    { kind: 'PLAN' | 'NOT_READY'; fingerprint: string }
  >();

  async record(input: RecordBuildIterationV1Input): Promise<void> {
    try {
      const row = this.buildRow(input);
      const key = `${input.matchId}|${row.steamId as string}`;
      const last = this.lastWritten.get(key) ?? (await this.readLastWritten(input.matchId, row.steamId as string));
      const unchanged =
        last !== undefined &&
        last.kind === row.kind &&
        last.fingerprint === row.fingerprint;
      if (unchanged) return;

      await this.repository
        .createQueryBuilder()
        .insert()
        .into(AdaptiveBuildIterationV1Entity)
        .values(row)
        .execute();

      this.lastWritten.set(key, {
        kind: row.kind as 'PLAN' | 'NOT_READY',
        fingerprint: row.fingerprint as string,
      });
    } catch (error) {
      this.logger.warn(`Build iteration history write failed: ${describeError(error)}`);
    }
  }

  private async readLastWritten(
    matchId: string,
    steamId: string,
  ): Promise<{ kind: 'PLAN' | 'NOT_READY'; fingerprint: string } | undefined> {
    const last = await this.repository.findOne({
      where: { matchId, steamId },
      order: { id: 'DESC' },
    });
    return last ? { kind: last.kind, fingerprint: last.fingerprint } : undefined;
  }
```

The `.orIgnore()` call is dropped (no unique index to conflict with). The in-memory map bounds the SELECT to one per (matchId, steamId) per process; after a restart the SELECT path re-hydrates the last state, so an unchanged state does not write a duplicate row, and the next real change writes exactly one row. Keep the never-throw contract. Remove the Task 8 mock's ON CONFLICT modelling and replace it with a fake that stores rows and serves `findOne` with the latest row for the key.

**Tests (extend `build-iteration-history-v1.spec.ts`):**

- A → B → A produces three PLAN rows (the previously-committed behaviour would produce two).
- Five identical recommendations → one row.
- PLAN → NOT_READY → PLAN → three rows (kinds in that order).
- Fresh service instance over the same fake repository (simulating a restart): writing the same unchanged state adds no row; the next changed state adds exactly one.
- The migration assertions from the integration spec are exercised in the live-DB run.

- [ ] **Step 1: failing tests** (A → B → A expects three rows — currently two).
- [ ] **Step 2: run, verify failure**: `yarn workspace @deadlock-live-probe/api test -- test/build-iteration-history-v1.spec.ts`.
- [ ] **Step 3: implement** the service change and the migration amendment.
- [ ] **Step 4: spec green**, then the live-DB integration run:
  `DB_HOST=127.0.0.1 DB_PORT=5433 DB_USER=postgres DB_PASSWORD=*** DB_NAME=deadlock_builds DB_MIGRATION_INTEGRATION=true yarn workspace @deadlock-live-probe/api test -- test/production-database-migration.integration.spec.ts` — expected PASS with the amended index list and the no-unique-violation scenario.
- [ ] **Step 5: full api suite** — green.
- [ ] **Step 6: Commit** `feat(api): record every build state change against the previous row`.
