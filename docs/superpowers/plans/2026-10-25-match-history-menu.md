# Match History Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each app user a "Матчи" tab in the desktop window listing their saved matches (roster, KDA, duration), enriched with official Deadlock API data by a 15-minute cron.

**Architecture:** New NestJS module `match-history` beside `deadlock-live`. A pure projection folds each canonicalized live batch into `app_users_v1` / `match_history_v1` upserts. A cron fetches `https://api.deadlock-api.com/v1/matches/{id}` per pending match. The Overwolf desktop window gains a third workspace tab that reads three new GET endpoints.

**Tech Stack:** NestJS 10, TypeORM + Postgres (raw-SQL migrations), `@nestjs/schedule` cron, axios, TypeScript browser client (no framework), jest.

**Spec:** `docs/superpowers/specs/2026-10-25-match-history-design.md`

## Global Constraints

- Branch: `uat` only. Never push to `main` from this work.
- Run tests from `apps/api`: `yarn workspace @dynamo-lab/api test` or `npx jest --runInBand <file>` from `apps/api`. Domain build first when the compiler complains: `yarn build:domain`.
- Entity column names are camelCase quoted identifiers (repo convention — see `adaptive_feedback_v1`).
- Roster payloads on the projection input are in the **legacy state shape**: `steam_id`, `player_name`, `is_local`, `hero_id`, `hero_name`, `team`, `lane`, `level`, `souls`, `health`, `max_health`, `kills`, `deaths`, `assists`, `hero_damage`, `object_damage`, `healing`.
- `matchId` must pass the same sanitization rule as `resolveMatchLogPath` (`sanitizeMatchId` in `apps/api/src/deadlock-live/raw-event-log.service.ts`): strip `/` and `\` before it reaches the DB.
- Key policy (owner's decision, verbatim): "если есть ключ, через него. если ключ не валид - кидать без ключа. если нет ключа - кидать без ключа."

---

### Task 0: Merge the deployed fixes into `uat`

`uat` is missing `aa254534` and `b4d28167` (deployed to the UAT container from a worktree on 2026-10-08 but never merged into the branch). Deploying `uat` without them would roll UAT's statlocker identity handling back.

**Files:** none (git only)

- [ ] **Step 1: Merge and run the suite**

```bash
git checkout uat
git merge main --no-edit
cd apps/api && yarn build:domain && npx jest --runInBand 2>&1 | tail -5
```

Expected: merge succeeds without conflicts (the branches touch disjoint files — `uat` carries situational-items work, `main` carries the two statlocker fixes); suite green.

- [ ] **Step 2: Commit the merge if git did not auto-commit**

```bash
git log --oneline -1   # verify merge commit exists
```

---

### Task 1: Migration + entities

**Files:**
- Create: `apps/api/src/database/migrations/1792982400000-create-match-history-v1.ts`
- Create: `apps/api/src/match-history/entities/app-user-v1.entity.ts`
- Create: `apps/api/src/match-history/entities/match-history-v1.entity.ts`

**Interfaces (produced, consumed by Tasks 3–6):**
- `AppUserV1Entity` — props: `steamId` (PK), `playerName?`, `lastClientId?`, `firstSeenAt`, `lastSeenAt`
- `MatchHistoryV1Entity` — props: `matchId` (PK), `localSteamId`, `localHeroId?`, `kills?`, `deaths?`, `assists?`, `souls?`, `durationSec?`, `players: unknown[]`, `startedAt`, `lastEventAt`, `enrichmentStatus: 'PENDING'|'DONE'|'NOT_FOUND'|'FAILED'`, `enrichmentAttempts`, `enrichmentFetchedAt?`, `enrichment?`, `createdAt`, `updatedAt`

- [ ] **Step 1: Write the migration** (pattern: `1789401600000-create-adaptive-feedback-v1.ts`)

```ts
import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateMatchHistoryV11792982400000 implements MigrationInterface {
  name = 'CreateMatchHistoryV11792982400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "app_users_v1" (
        "steamId" varchar(32) NOT NULL,
        "playerName" varchar(128),
        "lastClientId" varchar(128),
        "firstSeenAt" timestamptz NOT NULL DEFAULT now(),
        "lastSeenAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_app_users_v1" PRIMARY KEY ("steamId")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "match_history_v1" (
        "matchId" varchar(128) NOT NULL,
        "localSteamId" varchar(32) NOT NULL,
        "localHeroId" int,
        "kills" int,
        "deaths" int,
        "assists" int,
        "souls" bigint,
        "durationSec" int,
        "players" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "startedAt" timestamptz NOT NULL,
        "lastEventAt" timestamptz NOT NULL,
        "enrichmentStatus" varchar(16) NOT NULL DEFAULT 'PENDING',
        "enrichmentAttempts" int NOT NULL DEFAULT 0,
        "enrichmentFetchedAt" timestamptz,
        "enrichment" jsonb,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_match_history_v1" PRIMARY KEY ("matchId")
      )
    `);
    await queryRunner.query(`
      COMMENT ON TABLE "match_history_v1" IS
        'Per-user match summaries projected from live ingest; enrichment column holds the raw deadlock-api /v1/matches response.'
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_match_history_user_v1"
      ON "match_history_v1" ("localSteamId", "startedAt" DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_match_history_enrichment_v1"
      ON "match_history_v1" ("enrichmentStatus")
      WHERE "enrichmentStatus" IN ('PENDING', 'FAILED', 'NOT_FOUND')
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "match_history_v1"');
    await queryRunner.query('DROP TABLE IF EXISTS "app_users_v1"');
  }
}
```

If `apps/api/run-migrations.js` globs the directory, nothing else to register. Verify by grepping it for the directory name; if it imports migrations explicitly, add the class there the way the others are.

- [ ] **Step 2: Write the entities**

`app-user-v1.entity.ts`:

```ts
import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('app_users_v1')
export class AppUserV1Entity {
  @PrimaryColumn({ type: 'varchar', length: 32 })
  steamId!: string;

  @Column({ type: 'varchar', length: 128, nullable: true })
  playerName?: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  lastClientId?: string | null;

  @Column({ type: 'timestamptz' })
  firstSeenAt!: Date;

  @Column({ type: 'timestamptz' })
  lastSeenAt!: Date;
}
```

`match-history-v1.entity.ts`:

```ts
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { MatchHistoryPlayer } from '../match-history.types';

export type MatchEnrichmentStatus = 'PENDING' | 'DONE' | 'NOT_FOUND' | 'FAILED';

@Entity('match_history_v1')
@Index('idx_match_history_user_v1', ['localSteamId', 'startedAt'])
export class MatchHistoryV1Entity {
  @PrimaryColumn({ type: 'varchar', length: 128 })
  matchId!: string;

  @Column({ type: 'varchar', length: 32 })
  localSteamId!: string;

  @Column({ type: 'int', nullable: true })
  localHeroId?: number | null;

  @Column({ type: 'int', nullable: true })
  kills?: number | null;

  @Column({ type: 'int', nullable: true })
  deaths?: number | null;

  @Column({ type: 'int', nullable: true })
  assists?: number | null;

  @Column({ type: 'bigint', nullable: true })
  souls?: string | null;

  @Column({ type: 'int', nullable: true })
  durationSec?: number | null;

  @Column({ type: 'jsonb' })
  players!: MatchHistoryPlayer[];

  @Column({ type: 'timestamptz' })
  startedAt!: Date;

  @Column({ type: 'timestamptz' })
  lastEventAt!: Date;

  @Column({ type: 'varchar', length: 16 })
  enrichmentStatus!: MatchEnrichmentStatus;

  @Column({ type: 'int' })
  enrichmentAttempts!: number;

  @Column({ type: 'timestamptz', nullable: true })
  enrichmentFetchedAt?: Date | null;

  @Column({ type: 'jsonb', nullable: true })
  enrichment?: Record<string, unknown> | null;

  @Column({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'timestamptz' })
  updatedAt!: Date;
}
```

Note `souls?: string | null` — TypeORM bigint maps to string (repo does the same in `AdaptiveBuildIterationV1Entity.id`).

- [ ] **Step 3: Create the placeholder types module** (the entity imports it; Task 2 fills the projection)

`apps/api/src/match-history/match-history.types.ts`:

```ts
/** One roster player as stored in `match_history_v1.players` (jsonb). */
export interface MatchHistoryPlayer {
  steamId?: string;
  name?: string;
  heroId?: number;
  heroName?: string;
  team?: number;
  lane?: number;
  level?: number;
  kills?: number;
  deaths?: number;
  assists?: number;
  souls?: number;
  heroDamage?: number;
  objectDamage?: number;
  healing?: number;
  isLocal?: boolean;
}
```

- [ ] **Step 4: Compile check**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/database/migrations/1792982400000-create-match-history-v1.ts apps/api/src/match-history/
git commit -m "feat(match-history): app_users_v1 and match_history_v1 storage"
```

---

### Task 2: Pure batch projection

**Files:**
- Create: `apps/api/src/match-history/match-history-projection.ts`
- Test: `apps/api/test/match-history-projection.spec.ts`

**Interfaces:**
- Consumes: `OverwolfLiveBatchDto`, `OverwolfLiveEventDto` from `@dynamo-lab/shared`; `MatchHistoryPlayer` from Task 1
- Produces:

```ts
export interface MatchHistoryProjection {
  matchId: string;          // sanitized
  localSteamId: string;
  clientId: string;
  players: MatchHistoryPlayer[]; // merged, final-value-wins per field
  durationSec?: number;     // max clock seen across batch + previous
}

export function projectMatchHistoryBatch(
  batch: OverwolfLiveBatchDto,
  previous?: MatchHistoryProjection,
): MatchHistoryProjection | null;
```

- [ ] **Step 1: Write the failing tests**

```ts
import { OverwolfLiveBatchDto } from '@dynamo-lab/shared';
import { projectMatchHistoryBatch } from '../src/match-history/match-history-projection';

function batch(events: OverwolfLiveBatchDto['events'], clientId = 'client-1'): OverwolfLiveBatchDto {
  return { clientId, events };
}

function rosterEvent(matchId: string, payload: Record<string, unknown>, receivedAt = 1) {
  return { receivedAt, source: 'onInfoUpdates2' as const, key: 'roster_0', payload, matchId };
}

describe('projectMatchHistoryBatch', () => {
  it('projects the local player and the roster', () => {
    const result = projectMatchHistoryBatch(batch([
      rosterEvent('m1', {
        steam_id: '765', player_name: 'me', is_local: true, hero_id: 5, hero_name: 'Ivy',
        team: 1, lane: 2, level: 22, souls: 48000, kills: 11, deaths: 3, assists: 9,
        hero_damage: 51000, object_damage: 8000, healing: 1200,
      }),
      rosterEvent('m1', { steam_id: '999', player_name: 'foe', is_local: false, hero_id: 8, kills: 2, deaths: 9 }),
    ]));

    expect(result?.matchId).toBe('m1');
    expect(result?.localSteamId).toBe('765');
    expect(result?.players).toHaveLength(2);
    expect(result?.players[0]).toMatchObject({ steamId: '765', name: 'me', isLocal: true, heroId: 5, souls: 48000 });
    expect(result?.players[1]).toMatchObject({ steamId: '999', isLocal: false });
  });

  it('returns null when the batch has no roster and no local player', () => {
    expect(projectMatchHistoryBatch(batch([
      { receivedAt: 1, source: 'onInfoUpdates2', key: 'match_clock', payload: '10:00', matchId: 'm2' },
    ], 'c'))).toBeNull();
  });

  it('maxes match_clock across batch and previous, parsing mm:ss and h:mm:ss', () => {
    const first = projectMatchHistoryBatch(batch([
      rosterEvent('m3', { steam_id: '1', is_local: true }),
      { receivedAt: 2, source: 'onInfoUpdates2', key: 'match_clock', payload: '31:04', matchId: 'm3' },
    ]));
    const second = projectMatchHistoryBatch(batch([
      { receivedAt: 3, source: 'onInfoUpdates2', key: 'match_clock', payload: '30:59', matchId: 'm3' },
      { receivedAt: 4, source: 'onInfoUpdates2', key: 'match_clock', payload: '1:00:01', matchId: 'm3' },
    ]), first ?? undefined);

    expect(first?.durationSec).toBe(31 * 60 + 4);
    expect(second?.durationSec).toBe(3600 + 1);
  });

  it('merges partial roster snapshots field-level: defined fields win, undefined never clobbers', () => {
    const first = projectMatchHistoryBatch(batch([
      rosterEvent('m4', { steam_id: '765', is_local: true, hero_id: 5, kills: 3 }),
    ]));
    const second = projectMatchHistoryBatch(batch([
      rosterEvent('m4', { steam_id: '765', is_local: true, kills: 7 }),
    ]), first ?? undefined);

    expect(second?.players[0]).toMatchObject({ heroId: 5, kills: 7 });
  });

  it('sanitizes a hostile matchId to a single path segment', () => {
    const result = projectMatchHistoryBatch(batch([
      rosterEvent('../evil', { steam_id: '765', is_local: true }),
    ]));
    expect(result?.matchId).toBe('..evil');
  });

  it('ignores events for other matches when one batch carries several match ids', () => {
    const result = projectMatchHistoryBatch(batch([
      rosterEvent('m5', { steam_id: '765', is_local: true }),
      rosterEvent('other', { steam_id: '999', is_local: true }),
    ]));
    expect(result?.matchId).toBe('m5');
    expect(result?.players).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify fail**

```bash
cd apps/api && npx jest --runInBand test/match-history-projection.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { OverwolfLiveBatchDto, OverwolfLiveEventDto } from '@dynamo-lab/shared';
import { MatchHistoryPlayer } from './match-history.types';

export interface MatchHistoryProjection {
  matchId: string;
  localSteamId: string;
  clientId: string;
  players: MatchHistoryPlayer[];
  durationSec?: number;
}

/** Same containment rule as the raw event log: a match id is one path/db segment. */
function sanitizeMatchId(matchId: string): string {
  return matchId.replace(/[/\\]/g, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function num(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function str(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Legacy-state roster payload → stored player snapshot. */
function payloadToPlayer(payload: Record<string, unknown>): MatchHistoryPlayer {
  const player: MatchHistoryPlayer = {
    steamId: str(payload, 'steam_id'),
    name: str(payload, 'player_name'),
    isLocal: payload.is_local === true,
    heroId: num(payload, 'hero_id'),
    heroName: str(payload, 'hero_name'),
    team: num(payload, 'team'),
    lane: num(payload, 'lane'),
    level: num(payload, 'level'),
    souls: num(payload, 'souls'),
    kills: num(payload, 'kills'),
    deaths: num(payload, 'deaths'),
    assists: num(payload, 'assists'),
    heroDamage: num(payload, 'hero_damage'),
    objectDamage: num(payload, 'object_damage'),
    healing: num(payload, 'healing'),
  };
  for (const key of Object.keys(player) as (keyof MatchHistoryPlayer)[]) {
    if (player[key] === undefined) delete player[key];
  }
  return player;
}

function mergePlayer(previous: MatchHistoryPlayer | undefined, next: MatchHistoryPlayer): MatchHistoryPlayer {
  if (!previous) return { ...next };
  const merged: MatchHistoryPlayer = { ...previous };
  for (const key of Object.keys(next) as (keyof MatchHistoryPlayer)[]) {
    if (next[key] !== undefined) merged[key] = next[key];
  }
  return merged;
}

/** "mm:ss" or "h:mm:ss" — same shapes `parseClockSeconds` accepts. */
export function parseClockSeconds(payload: unknown): number | undefined {
  if (typeof payload !== 'string') return undefined;
  const parts = payload.split(':').map((part) => Number.parseInt(part, 10));
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => Number.isNaN(part))) return undefined;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

export function projectMatchHistoryBatch(
  batch: OverwolfLiveBatchDto,
  previous?: MatchHistoryProjection,
): MatchHistoryProjection | null {
  const primaryMatchId = batch.events.find((event) => typeof event.matchId === 'string' && event.matchId.length > 0)
    ?.matchId;
  if (!primaryMatchId) return null;

  const playersBySteamId = new Map<string, MatchHistoryPlayer>();
  for (const player of previous?.players ?? []) {
    if (player.steamId) playersBySteamId.set(player.steamId, { ...player });
  }

  let localSteamId = previous?.localSteamId;
  let durationSec = previous?.durationSec;

  for (const event of batch.events as OverwolfLiveEventDto[]) {
    if (event.matchId !== primaryMatchId) continue;

    if (event.key === 'match_clock') {
      const seconds = parseClockSeconds(event.payload);
      if (seconds !== undefined && (durationSec === undefined || seconds > durationSec)) {
        durationSec = seconds;
      }
      continue;
    }

    if (!event.key?.startsWith('roster') || !isRecord(event.payload)) continue;

    const player = payloadToPlayer(event.payload);
    if (player.steamId === undefined) continue;
    playersBySteamId.set(player.steamId, mergePlayer(playersBySteamId.get(player.steamId), player));
    if (player.isLocal && player.steamId) localSteamId = player.steamId;
  }

  if (localSteamId === undefined) return null;

  return {
    matchId: sanitizeMatchId(primaryMatchId),
    localSteamId,
    clientId: batch.clientId,
    players: [...playersBySteamId.values()],
    durationSec,
  };
}
```

- [ ] **Step 4: Run to verify pass**

```bash
cd apps/api && npx jest --runInBand test/match-history-projection.spec.ts
```

Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/match-history/match-history-projection.ts apps/api/test/match-history-projection.spec.ts
git commit -m "feat(match-history): pure live-batch projection"
```

---

### Task 3: MatchHistoryService (upserts)

**Files:**
- Create: `apps/api/src/match-history/match-history.service.ts`
- Test: `apps/api/test/match-history.service.spec.ts`

**Interfaces:**
- Consumes: `projectMatchHistoryBatch` (Task 2), both entities (Task 1)
- Produces: `MatchHistoryService.applyBatch(batch: OverwolfLiveBatchDto): Promise<void>` — never throws for a bad batch (logs a warning instead); Task 4 calls this.

Upserts use `createQueryBuilder().insert().orUpdate()` so `firstSeenAt` / enrichment columns survive every re-ingest.

- [ ] **Step 1: Write the failing tests**

```ts
import { Repository } from 'typeorm';
import { OverwolfLiveBatchDto } from '@dynamo-lab/shared';
import { MatchHistoryService } from '../src/match-history/match-history.service';
import { AppUserV1Entity } from '../src/match-history/entities/app-user-v1.entity';
import { MatchHistoryV1Entity } from '../src/match-history/entities/match-history-v1.entity';

function rosterBatch(matchId: string, steamId: string, name = 'me'): OverwolfLiveBatchDto {
  return {
    clientId: 'client-9',
    events: [{
      receivedAt: 1, source: 'onInfoUpdates2', key: 'roster_0', matchId,
      payload: { steam_id: steamId, player_name: name, is_local: true, hero_id: 5, kills: 4, souls: 41000 },
    }],
  };
}

describe('MatchHistoryService', () => {
  function makeService() {
    const users = { createQueryBuilder: jest.fn() };
    const matches = { createQueryBuilder: jest.fn() };
    const service = new MatchHistoryService(
      users as unknown as Repository<AppUserV1Entity>,
      matches as unknown as Repository<MatchHistoryV1Entity>,
    );
    return { service, users, matches };
  }

  it('upserts the user and the match row', async () => {
    const { service, users, matches } = makeService();
    const userInsert = { values: jest.fn().mockReturnThis(), orUpdate: jest.fn().mockResolvedValue(undefined) };
    const matchInsert = { values: jest.fn().mockReturnThis(), orUpdate: jest.fn().mockResolvedValue(undefined) };
    users.createQueryBuilder.mockReturnValue(userInsert);
    matches.createQueryBuilder.mockReturnValue(matchInsert);

    await service.applyBatch(rosterBatch('m1', '765'));

    expect(userInsert.values).toHaveBeenCalledWith(expect.objectContaining({
      steamId: '765', playerName: 'me', lastClientId: 'client-9',
    }));
    expect(userInsert.orUpdate).toHaveBeenCalledWith(
      ['playerName', 'lastClientId', 'lastSeenAt'], ['steamId'],
    );
    expect(matchInsert.values).toHaveBeenCalledWith(expect.objectContaining({
      matchId: 'm1', localSteamId: '765', localHeroId: 5, kills: 4,
    }));
    expect(matchInsert.orUpdate).toHaveBeenCalledWith(
      ['localSteamId', 'localHeroId', 'kills', 'deaths', 'assists', 'souls', 'durationSec',
        'players', 'lastEventAt', 'updatedAt'],
      ['matchId'],
    );
  });

  it('keeps startedAt from the first batch and advances lastEventAt on later batches', async () => {
    const { service, matches } = makeService();
    const insert = { values: jest.fn().mockReturnThis(), orUpdate: jest.fn().mockResolvedValue(undefined) };
    matches.createQueryBuilder.mockReturnValue(insert);

    await service.applyBatch(rosterBatch('m2', '765'));
    const first = insert.values.mock.calls[0][0];
    await new Promise((resolve) => setTimeout(resolve, 5));
    await service.applyBatch(rosterBatch('m2', '765'));
    const second = insert.values.mock.calls[1][0];

    expect(second.startedAt.getTime()).toBe(first.startedAt.getTime());
    expect(second.lastEventAt.getTime()).toBeGreaterThan(first.lastEventAt.getTime());
  });

  it('swallows projection misses (no local player) without touching the DB', async () => {
    const { service, users, matches } = makeService();
    await service.applyBatch({ clientId: 'c', events: [{ receivedAt: 1, source: 'onInfoUpdates2', key: 'x', payload: 1 }] });
    expect(users.createQueryBuilder).not.toHaveBeenCalled();
    expect(matches.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('never throws when the DB fails — resolves instead', async () => {
    const { service, users, matches } = makeService();
    matches.createQueryBuilder.mockReturnValue({
      values: jest.fn().mockReturnThis(),
      orUpdate: jest.fn().mockRejectedValue(new Error('db down')),
    });
    users.createQueryBuilder.mockReturnValue({
      values: jest.fn().mockReturnThis(),
      orUpdate: jest.fn().mockResolvedValue(undefined),
    });
    await expect(service.applyBatch(rosterBatch('m3', '765'))).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify fail** — `cd apps/api && npx jest --runInBand test/match-history.service.spec.ts` — FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
import { ConsoleLogger, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OverwolfLiveBatchDto } from '@dynamo-lab/shared';
import { AppUserV1Entity } from './entities/app-user-v1.entity';
import { MatchHistoryV1Entity } from './entities/match-history-v1.entity';
import { MatchHistoryProjection, projectMatchHistoryBatch } from './match-history-projection';

// ponytail: one in-memory accumulation per live match; a restart mid-match
// rebuilds from the next full roster snapshot GEP re-sends anyway.
const MAX_TRACKED_MATCHES = 200;

const MATCH_UPDATE_COLUMNS = [
  'localSteamId', 'localHeroId', 'kills', 'deaths', 'assists', 'souls', 'durationSec',
  'players', 'lastEventAt', 'updatedAt',
] as const;

@Injectable()
export class MatchHistoryService {
  private readonly logger = new Logger('MatchHistoryService');
  private readonly projections = new Map<string, { projection: MatchHistoryProjection; startedAt: Date }>();

  constructor(
    @InjectRepository(AppUserV1Entity)
    private readonly users: Repository<AppUserV1Entity>,
    @InjectRepository(MatchHistoryV1Entity)
    private readonly matches: Repository<MatchHistoryV1Entity>,
  ) {}

  async applyBatch(batch: OverwolfLiveBatchDto): Promise<void> {
    try {
      const previous = this.lastProjection(batch);
      const projection = projectMatchHistoryBatch(batch, previous);
      if (!projection) return;

      const existing = this.projections.get(projection.matchId);
      const startedAt = existing?.startedAt ?? new Date();
      const lastEventAt = new Date();
      this.remember(projection, startedAt);

      const local = projection.players.find((player) => player.steamId === projection.localSteamId);

      await this.users
        .createQueryBuilder()
        .insert()
        .into(AppUserV1Entity)
        .values({
          steamId: projection.localSteamId,
          playerName: local?.name ?? null,
          lastClientId: projection.clientId,
          firstSeenAt,
          lastSeenAt,
        })
        .orUpdate(['playerName', 'lastClientId', 'lastSeenAt'], ['steamId'])
        .execute();

      await this.matches
        .createQueryBuilder()
        .insert()
        .into(MatchHistoryV1Entity)
        .values({
          matchId: projection.matchId,
          localSteamId: projection.localSteamId,
          localHeroId: local?.heroId ?? null,
          kills: local?.kills ?? null,
          deaths: local?.deaths ?? null,
          assists: local?.assists ?? null,
          souls: local?.souls !== undefined ? String(local.souls) : null,
          durationSec: projection.durationSec ?? null,
          players: projection.players,
          startedAt,
          lastEventAt,
          enrichmentStatus: 'PENDING',
          enrichmentAttempts: 0,
          createdAt: startedAt,
          updatedAt: lastEventAt,
        })
        .orUpdate([...MATCH_UPDATE_COLUMNS], ['matchId'])
        .execute();
    } catch (error) {
      this.logger.warn(`Match history projection failed: ${String(error)}`);
    }
  }

  private lastProjection(batch: OverwolfLiveBatchDto): MatchHistoryProjection | undefined {
    const matchId = batch.events.find((event) => event.matchId)?.matchId;
    if (!matchId) return undefined;
    return this.projections.get(matchId)?.projection;
  }

  private remember(projection: MatchHistoryProjection, startedAt: Date): void {
    if (this.projections.size >= MAX_TRACKED_MATCHES && !this.projections.has(projection.matchId)) {
      const oldest = this.projections.keys().next().value;
      if (oldest !== undefined) this.projections.delete(oldest);
    }
    this.projections.set(projection.matchId, { projection, startedAt });
  }
}
```

- [ ] **Step 4: Run to verify pass** — `npx jest --runInBand test/match-history.service.spec.ts` — 4 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/match-history/match-history.service.ts apps/api/test/match-history.service.spec.ts
git commit -m "feat(match-history): persist projected batches"
```

---

### Task 4: Ingest hook + module wiring

**Files:**
- Create: `apps/api/src/match-history/match-history.module.ts`
- Modify: `apps/api/src/deadlock-live/live-ingest.controller.ts` (constructor + end of `ingestEvents`)
- Modify: `apps/api/src/app.module.ts` (import + register `MatchHistoryModule`)
- Test: `apps/api/test/live-ingest.controller.spec.ts` (extend the existing suite)

**Interfaces:**
- Consumes: `MatchHistoryService.applyBatch` (Task 3)
- Produces: `MatchHistoryModule` exported for `app.module.ts`

- [ ] **Step 1: Extend the controller spec first**

In `apps/api/test/live-ingest.controller.spec.ts`, add to providers:

```ts
{
  provide: MatchHistoryService,
  useValue: { applyBatch: jest.fn().mockResolvedValue(undefined) },
},
```

and after the existing `ingestEvents` call:

```ts
const matchHistory = moduleRef.get(MatchHistoryService);
expect(matchHistory.applyBatch).toHaveBeenCalledTimes(1);
const arg = (matchHistory.applyBatch as jest.Mock).mock.calls[0][0];
expect(arg.clientId).toBe('client');
```

Import from `../src/match-history/match-history.service`. Run: FAIL (provider unknown).

- [ ] **Step 2: Wire the hook**

In `live-ingest.controller.ts`: inject `private readonly matchHistoryService: MatchHistoryService` and after the raw-log try/catch in `ingestEvents` add:

```ts
try {
  await this.matchHistoryService.applyBatch(stateBatch);
} catch (error) {
  this.logger.warn(`Match history projection failed: ${describeError(error)}`);
}
```

`stateBatch` is already the canonicalized batch the projection expects.

`match-history.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppUserV1Entity } from './entities/app-user-v1.entity';
import { MatchHistoryV1Entity } from './entities/match-history-v1.entity';
import { MatchHistoryService } from './match-history.service';

@Module({
  imports: [TypeOrmModule.forFeature([AppUserV1Entity, MatchHistoryV1Entity])],
  providers: [MatchHistoryService],
  exports: [MatchHistoryService],
})
export class MatchHistoryModule {}
```

`app.module.ts`: `import { MatchHistoryModule } from './match-history/match-history.module';` and add `MatchHistoryModule,` to `imports` beside `DeadlockLiveModule`.

- [ ] **Step 3: Run the extended suite** — `npx jest --runInBand test/live-ingest.controller.spec.ts` — PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/match-history/match-history.module.ts apps/api/src/deadlock-live/live-ingest.controller.ts apps/api/src/app.module.ts apps/api/test/live-ingest.controller.spec.ts
git commit -m "feat(match-history): project every ingested live batch"
```

---

### Task 5: Read endpoints

**Files:**
- Create: `apps/api/src/match-history/match-history.controller.ts`
- Modify: `apps/api/src/match-history/match-history.module.ts` (register controller)
- Test: `apps/api/test/match-history.controller.spec.ts`

**Interfaces:**
- Produces (consumed by Task 7):
  - `GET /deadlock/match-history/users` → `{ users: Array<{ steamId, playerName, lastClientId, firstSeenAt, lastSeenAt, matchCount }> }`
  - `GET /deadlock/match-history/users/:steamId/matches?limit=` → `{ matches: MatchHistoryV1Entity[] }` (newest first, default 50, max 200, non-numeric limit → 400)
  - `GET /deadlock/match-history/:matchId` → `MatchHistoryV1Entity`, 404 when absent

- [ ] **Step 1: Write the failing tests**

```ts
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { MatchHistoryController } from '../src/match-history/match-history.controller';
import { AppUserV1Entity } from '../src/match-history/entities/app-user-v1.entity';
import { MatchHistoryV1Entity } from '../src/match-history/entities/match-history-v1.entity';

function makeController() {
  const users = {
    query: jest.fn().mockReturnThis(),
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getRawAndEntities: jest.fn().mockResolvedValue({ raw: [], entities: [] }),
  };
  const matches = {
    findOne: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
  };
  const controller = new MatchHistoryController(
    users as unknown as Repository<AppUserV1Entity>,
    matches as unknown as Repository<MatchHistoryV1Entity>,
  );
  return { controller, users, matches };
}

describe('MatchHistoryController', () => {
  it('lists users with match counts, newest activity first', async () => {
    const { controller, users } = makeController();
    users.getRawAndEntities.mockResolvedValue({
      raw: [{ steamId: '765', playerName: 'me', matchCount: '3' }],
      entities: [{ steamId: '765', playerName: 'me' } as AppUserV1Entity],
    });
    const result = await controller.listUsers();
    expect(result.users).toEqual([{ steamId: '765', playerName: 'me', matchCount: 3 }]);
  });

  it('lists a user's matches newest first with a clamped limit', async () => {
    const { controller, matches } = makeController();
    await controller.userMatches('765', '9999');
    expect(matches.find).toHaveBeenCalledWith({
      where: { localSteamId: '765' },
      order: { startedAt: 'DESC' },
      take: 200,
    });
  });

  it('rejects a non-numeric limit with 400', async () => {
    const { controller } = makeController();
    await expect(controller.userMatches('765', 'abc')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('404s an unknown match', async () => {
    const { controller, matches } = makeController();
    matches.findOne.mockResolvedValue(null);
    await expect(controller.matchDetail('nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});
```

- [ ] **Step 2: Run to verify fail** — module missing.

- [ ] **Step 3: Implement**

```ts
import { BadRequestException, Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AppUserV1Entity } from './entities/app-user-v1.entity';
import { MatchHistoryV1Entity } from './entities/match-history-v1.entity';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

@Controller('deadlock/match-history')
export class MatchHistoryController {
  constructor(
    @InjectRepository(AppUserV1Entity)
    private readonly users: Repository<AppUserV1Entity>,
    @InjectRepository(MatchHistoryV1Entity)
    private readonly matches: Repository<MatchHistoryV1Entity>,
  ) {}

  @Get('users')
  async listUsers(): Promise<{ users: unknown[] }> {
    const { raw } = await this.users
      .createQueryBuilder('u')
      .addSelect('(select count(*) from match_history_v1 m where m."localSteamId" = u."steamId")', 'matchCount')
      .orderBy('u."lastSeenAt"', 'DESC')
      .getRawAndEntities();
    return {
      users: raw.map((row) => ({
        steamId: row.steamId ?? row.u_steamId,
        playerName: row.playerName ?? row.u_playerName,
        lastClientId: row.lastClientId ?? row.u_lastClientId,
        firstSeenAt: row.firstSeenAt ?? row.u_firstSeenAt,
        lastSeenAt: row.lastSeenAt ?? row.u_lastSeenAt,
        matchCount: Number(row.matchCount ?? 0),
      })),
    };
  }

  @Get('users/:steamId/matches')
  async userMatches(
    @Param('steamId') steamId: string,
    @Query('limit') limit?: string,
  ): Promise<{ matches: MatchHistoryV1Entity[] }> {
    let take = DEFAULT_LIMIT;
    if (limit !== undefined) {
      const parsed = Number.parseInt(limit, 10);
      if (Number.isNaN(parsed) || parsed <= 0) throw new BadRequestException('limit must be a positive integer');
      take = Math.min(parsed, MAX_LIMIT);
    }
    const matches = await this.matches.find({
      where: { localSteamId: steamId },
      order: { startedAt: 'DESC' },
      take,
    });
    return { matches };
  }

  @Get(':matchId')
  async matchDetail(@Param('matchId') matchId: string): Promise<MatchHistoryV1Entity> {
    const match = await this.matches.findOne({ where: { matchId } });
    if (!match) throw new NotFoundException(`unknown match ${matchId}`);
    return match;
  }
}
```

Declare `users`, `users/:steamId/matches` routes **before** `:matchId` (done above) so Nest does not swallow them. Add `controllers: [MatchHistoryController]` to `MatchHistoryModule`.

- [ ] **Step 4: Run to verify pass** — `npx jest --runInBand test/match-history.controller.spec.ts` — 4 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/match-history/match-history.controller.ts apps/api/src/match-history/match-history.module.ts apps/api/test/match-history.controller.spec.ts
git commit -m "feat(match-history): users, matches, detail endpoints"
```

---

### Task 6: Enrichment cron

**Files:**
- Create: `apps/api/src/match-history/match-enrichment.service.ts`
- Modify: `apps/api/src/match-history/match-history.module.ts` (provider)
- Test: `apps/api/test/match-enrichment.service.spec.ts`

**Interfaces:**
- Consumes: `MatchHistoryV1Entity`, `getDeadlockApiRequestConfig()` from `../deadlock-live/deadlock-api-request`
- Produces: `MatchEnrichmentService.enrichPending(): Promise<void>` (`@Cron('*/15 * * * *')`) and `fetchAndStore(match): Promise<void>` for tests/manual kicks

Candidate rules (from spec): status PENDING, or FAILED with attempts < 8, or NOT_FOUND with `lastEventAt` newer than 7 days; `lastEventAt` at least 10 minutes ago; max 20 per tick; 250 ms between fetches; re-entrancy guard; 401/403 with a configured key → retry the same URL keyless.

- [ ] **Step 1: Write the failing tests**

```ts
import axios from 'axios';
import { MatchEnrichmentService } from '../src/match-history/match-enrichment.service';
import { MatchHistoryV1Entity } from '../src/match-history/entities/match-history-v1.entity';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

function pendingMatch(over: Partial<MatchHistoryV1Entity> = {}): MatchHistoryV1Entity {
  return {
    matchId: 'm1', localSteamId: '765', players: [], enrichmentStatus: 'PENDING',
    enrichmentAttempts: 0, startedAt: new Date(), lastEventAt: new Date(Date.now() - 3600_000),
    createdAt: new Date(), updatedAt: new Date(),
    ...over,
  } as MatchHistoryV1Entity;
}

function makeService() {
  const repo = {
    createQueryBuilder: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue(undefined),
    }),
  };
  const service = new MatchEnrichmentService(repo as never);
  return { service, repo };
}

function withCandidates(repo: ReturnType<typeof makeService>['repo'], matches: MatchHistoryV1Entity[]) {
  (repo.createQueryBuilder().getMany as jest.Mock).mockResolvedValue(matches);
}

describe('MatchEnrichmentService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.DEADLOCK_API_KEY = '';
  });

  it('stores the payload and marks DONE on 200', async () => {
    const { service, repo } = makeService();
    withCandidates(repo, [pendingMatch()]);
    mockedAxios.get.mockResolvedValueOnce({ status: 200, data: { match_id: 'm1', start_time: 1 } });

    await service.enrichPending();

    expect(mockedAxios.get).toHaveBeenCalledWith(
      'https://api.deadlock-api.com/v1/matches/m1',
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(repo.update.mock.calls[0][0]).toBe('m1');
    expect(repo.update.mock.calls[0][1]).toMatchObject({ enrichmentStatus: 'DONE' });
  });

  it('marks NOT_FOUND on 404', async () => {
    const { service, repo } = makeService();
    withCandidates(repo, [pendingMatch()]);
    mockedAxios.get.mockRejectedValueOnce({ response: { status: 404 } });

    await service.enrichPending();

    expect(repo.update.mock.calls[0][1]).toMatchObject({ enrichmentStatus: 'NOT_FOUND' });
  });

  it('retries keyless once when the configured key is rejected (401)', async () => {
    const { service, repo } = makeService();
    withCandidates(repo, [pendingMatch()]);
    process.env.DEADLOCK_API_KEY = 'dead-key';
    mockedAxios.get
      .mockRejectedValueOnce({ response: { status: 401 } })
      .mockResolvedValueOnce({ status: 200, data: { ok: true } });

    await service.enrichPending();

    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
    expect(mockedAxios.get.mock.calls[0][1]).toMatchObject({ headers: { 'X-API-KEY': 'dead-key' } });
    expect(mockedAxios.get.mock.calls[1][1]).not.toHaveProperty('headers');
    expect(repo.update.mock.calls[0][1]).toMatchObject({ enrichmentStatus: 'DONE' });
  });

  it('marks FAILED and counts the attempt on 429', async () => {
    const { service, repo } = makeService();
    withCandidates(repo, [pendingMatch({ enrichmentAttempts: 2 })]);
    mockedAxios.get.mockRejectedValueOnce({ response: { status: 429 } });

    await service.enrichPending();

    expect(repo.update.mock.calls[0][1]).toMatchObject({ enrichmentStatus: 'FAILED', enrichmentAttempts: 3 });
  });

  it('never throws across matches when one fetch explodes', async () => {
    const { service, repo } = makeService();
    withCandidates(repo, [pendingMatch({ matchId: 'a' }), pendingMatch({ matchId: 'b' })]);
    mockedAxios.get
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ status: 200, data: {} });

    await expect(service.enrichPending()).resolves.toBeUndefined();
    expect(repo.update).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run to verify fail** — module missing.

- [ ] **Step 3: Implement**

```ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import axios from 'axios';
import { Repository } from 'typeorm';
import { getDeadlockApiRequestConfig } from '../deadlock-live/deadlock-api-request';
import { MatchHistoryV1Entity } from './entities/match-history-v1.entity';

const API_BASE = 'https://api.deadlock-api.com';
const MAX_PER_TICK = 20;
const MAX_ATTEMPTS = 8;
const NOT_FOUND_WINDOW_MS = 7 * 24 * 3600 * 1000;
const MIN_AGE_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;
const INTER_REQUEST_DELAY_MS = 250;

function httpStatus(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'response' in error) {
    const response = (error as { response?: { status?: number } }).response;
    return response?.status;
  }
  return undefined;
}

@Injectable()
export class MatchEnrichmentService {
  private readonly logger = new Logger('MatchEnrichmentService');
  private running = false;

  constructor(
    @InjectRepository(MatchHistoryV1Entity)
    private readonly matches: Repository<MatchHistoryV1Entity>,
  ) {}

  @Cron('*/15 * * * *')
  async enrichPending(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const candidates = await this.matches
        .createQueryBuilder('m')
        .where('m."enrichmentStatus" = :pending', { pending: 'PENDING' })
        .orWhere('(m."enrichmentStatus" = :failed and m."enrichmentAttempts" < :maxAttempts)', {
          failed: 'FAILED', maxAttempts: MAX_ATTEMPTS,
        })
        .orWhere('(m."enrichmentStatus" = :notFound and m."lastEventAt" > :cutoff)', {
          notFound: 'NOT_FOUND', cutoff: new Date(Date.now() - NOT_FOUND_WINDOW_MS),
        })
        .andWhere('m."lastEventAt" < :minAge', { minAge: new Date(Date.now() - MIN_AGE_MS) })
        .orderBy('m."lastEventAt"', 'ASC')
        .take(MAX_PER_TICK)
        .getMany();

      for (const match of candidates) {
        await this.fetchAndStore(match);
        await new Promise((resolve) => setTimeout(resolve, INTER_REQUEST_DELAY_MS));
      }
    } catch (error) {
      this.logger.warn(`Match enrichment tick failed: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }

  async fetchAndStore(match: MatchHistoryV1Entity): Promise<void> {
    const url = `${API_BASE}/v1/matches/${encodeURIComponent(match.matchId)}`;
    const keyConfig = getDeadlockApiRequestConfig();
    try {
      const response = await axios.get(url, { ...keyConfig, timeout: FETCH_TIMEOUT_MS });
      await this.store(match, 'DONE', response.data);
    } catch (error) {
      const status = httpStatus(error);
      if ((status === 401 || status === 403) && keyConfig.headers) {
        try {
          const response = await axios.get(url, { timeout: FETCH_TIMEOUT_MS });
          await this.store(match, 'DONE', response.data);
          return;
        } catch (fallbackError) {
          return this.storeFailure(match, httpStatus(fallbackError));
        }
      }
      await this.storeFailure(match, status);
    }
  }

  private async store(match: MatchHistoryV1Entity, status: 'DONE', enrichment: unknown): Promise<void> {
    await this.matches.update(match.matchId, {
      enrichmentStatus: status,
      enrichmentFetchedAt: new Date(),
      enrichment: enrichment as Record<string, unknown>,
      updatedAt: new Date(),
    });
  }

  private async storeFailure(match: MatchHistoryV1Entity, status: number | undefined): Promise<void> {
    if (status === 404) {
      await this.matches.update(match.matchId, { enrichmentStatus: 'NOT_FOUND', updatedAt: new Date() });
      return;
    }
    await this.matches.update(match.matchId, {
      enrichmentStatus: 'FAILED',
      enrichmentAttempts: match.enrichmentAttempts + 1,
      updatedAt: new Date(),
    });
    this.logger.warn(`Match enrichment ${match.matchId} failed with status ${status ?? 'network'}`);
  }
}
```

Register `MatchEnrichmentService` in `MatchHistoryModule` providers. Note the test's fake `repo.update` returns a chain ending in a resolved promise — the `set/where` mock shape above already resolves.

- [ ] **Step 4: Run to verify pass** — `npx jest --runInBand test/match-enrichment.service.spec.ts` — 5 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/match-history/match-enrichment.service.ts apps/api/src/match-history/match-history.module.ts apps/api/test/match-enrichment.service.spec.ts
git commit -m "feat(match-history): deadlock-api enrichment cron"
```

---

### Task 7: Client "Матчи" tab

**Files:**
- Modify: `apps/overwolf-client/public/desktop.html` (nav button + `matches-workspace` section)
- Modify: `apps/overwolf-client/src/ui.ts` (Workspace type, WORKSPACE_NAV, showWorkspace)
- Create: `apps/overwolf-client/src/matches-view.ts`
- Modify: `apps/overwolf-client/src/index.ts` (pass apiBaseUrl + currentLocalSteamId into the view)
- Test: `apps/overwolf-client/src/matches-view.spec.ts`

**Interfaces:**
- Consumes: Task 5 endpoints; `currentLocalSteamId` from `index.ts`
- Produces: `createMatchesView({ apiBaseUrl, defaultSteamId, fetchImpl }): { render(): Promise<void>; root: HTMLElement }`

- [ ] **Step 1: Write the failing presentation spec** (style of `adaptive-recommendation-presentation.spec.ts` — pure DOM-less formatting first):

```ts
import { formatMatchRow, enrichmentOutcome } from './matches-view';

describe('matches view presentation', () => {
  it('formats a row: hero, date, K/D/A, souls, duration', () => {
    const row = formatMatchRow({
      matchId: 'm1', localHeroId: 5, kills: 11, deaths: 3, assists: 9,
      souls: '48000', durationSec: 2360, startedAt: '2026-10-25T18:00:00Z',
      players: [], enrichmentStatus: 'PENDING', enrichmentAttempts: 0,
      createdAt: '', updatedAt: '', localSteamId: '765',
    });
    expect(row.title).toContain('11/3/9');
    expect(row.title).toContain('39 мин');
    expect(row.badge).toBe('pending');
  });

  it('derives win/loss only from enrichment', () => {
    expect(enrichmentOutcome({ match_id: 'm1', match_result: 'VICTORY' } as never)).toBe('win');
    expect(enrichmentOutcome(null)).toBeUndefined();
  });
});
```

Adjust nothing — the fixture above matches the entity shape Task 5 returns. The assertion contract: KDA string, human duration, badge reflects `enrichmentStatus`.

- [ ] **Step 2: Run to verify fail**

```bash
cd apps/overwolf-client && npx jest --runInBand src/matches-view.spec.ts
```

Expected: FAIL — module not found. (Client workspace runs jest via ts-jest, same as its colocated `*.spec.ts` suites.)

- [ ] **Step 3: Implement `matches-view.ts`**

```ts
export interface MatchRowInput {
  matchId: string;
  localSteamId: string;
  localHeroId?: number | null;
  kills?: number | null;
  deaths?: number | null;
  assists?: number | null;
  souls?: string | null;
  durationSec?: number | null;
  startedAt: string;
  enrichmentStatus: 'PENDING' | 'DONE' | 'NOT_FOUND' | 'FAILED';
  players: MatchHistoryPlayer[];
  enrichment?: Record<string, unknown> | null;
}

import { MatchHistoryPlayer } from match-history types via a local re-declaration (client does not import server code — declare a structural copy here, as the client does for other server types).

export interface MatchHistoryPlayer { steamId?: string; name?: string; heroId?: number; heroName?: string; team?: number; lane?: number; level?: number; kills?: number; deaths?: number; assists?: number; souls?: number; heroDamage?: number; objectDamage?: number; healing?: number; isLocal?: boolean; }

export function enrichmentOutcome(enrichment: unknown): 'win' | 'loss' | undefined {
  if (typeof enrichment !== 'object' || enrichment === null) return undefined;
  const result = (enrichment as Record<string, unknown>).match_result;
  if (result === 'VICTORY' || result === 'WIN') return 'win';
  if (result === 'DEFEAT' || result === 'LOSS') return 'loss';
  return undefined;
}

function formatDuration(sec: number): string {
  if (sec < 3600) return `${Math.round(sec / 60)} мин`;
  return `${Math.floor(sec / 3600)} ч ${Math.round((sec % 3600) / 60)} мин`;
}

export function formatMatchRow(match: MatchRowInput): { title: string; badge: string } {
  const kda = `${match.kills ?? 0}/${match.deaths ?? 0}/${match.assists ?? 0}`;
  const duration = match.durationSec ? formatDuration(match.durationSec) : '—';
  const date = new Date(match.startedAt).toLocaleString('ru-RU');
  const title = `${date} — ${kda} — ${duration}`;
  const badge = match.enrichmentStatus === 'DONE' ? 'done' : match.enrichmentStatus === 'PENDING' ? 'pending' : 'waiting';
  return { title, badge };
}

export function createMatchesView(options: {
  apiBaseUrl: string;
  defaultSteamId?: string;
  fetchImpl?: typeof fetch;
}): { render: (steamId?: string) => Promise<void>; root: HTMLElement } {
  const fetchImpl = options.fetchImpl ?? ((input: string) => fetch(input));
  const root = document.createElement('div');

  async function render(steamId?: string): Promise<void> {
    root.textContent = 'Загрузка…';
    try {
      const usersResponse = await fetchImpl(`${options.apiBaseUrl}/deadlock/match-history/users`);
      const users = (await usersResponse.json()).users ?? [];
      const selected = steamId ?? options.defaultSteamId ?? users[0]?.steamId;
      const matchesResponse = selected
        ? await fetchImpl(`${options.apiBaseUrl}/deadlock/match-history/users/${selected}/matches`)
        : { json: async () => ({ matches: [] }) } as Response;
      const matches = (await matchesResponse.json()).matches ?? [];

      root.replaceChildren(...buildDom(users, selected, matches));
    } catch {
      root.textContent = 'Не удалось загрузить матчи';
    }
  }

  function buildDom(users: Array<{ steamId: string; playerName?: string }>, selected: string | undefined, matches: MatchRowInput[]): HTMLElement[] {
    const select = document.createElement('select');
    for (const user of users) {
      const option = document.createElement('option');
      option.value = user.steamId;
      option.textContent = user.playerName || user.steamId;
      if (user.steamId === selected) option.selected = true;
      select.append(option);
    }
    select.addEventListener('change', () => { void render(select.value); });

    const list = document.createElement('ul');
    for (const match of matches) {
      const row = formatMatchRow(match);
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.textContent = row.title + (row.badge === 'done' ? ' ✓' : row.badge === 'pending' ? ' …' : '');
      button.addEventListener('click', () => { void showDetail(match); });
      item.append(button);
      list.append(item);
    }
    if (matches.length === 0) {
      const empty = document.createElement('li');
      empty.textContent = 'Матчей пока нет';
      list.append(empty);
    }
    return [select, list];
  }

  async function showDetail(match: MatchRowInput): Promise<void> {
    const back = document.createElement('button');
    back.textContent = '← назад';
    back.addEventListener('click', () => { void render(); });
    const table = document.createElement('table');
    const head = document.createElement('tr');
    for (const label of ['Игрок', 'Герой', 'K/D/A', 'Дамаг', 'Лечение']) {
      const th = document.createElement('th');
      th.textContent = label;
      head.append(th);
    }
    table.append(head);
    for (const player of match.players) {
      const tr = document.createElement('tr');
      const cells = [
        (player.isLocal ? '★ ' : '') + (player.name ?? player.steamId ?? ''),
        player.heroName ?? String(player.heroId ?? '—'),
        `${player.kills ?? 0}/${player.deaths ?? 0}/${player.assists ?? 0}`,
        String(player.heroDamage ?? '—'),
        String(player.healing ?? '—'),
      ];
      for (const cell of cells) {
        const td = document.createElement('td');
        td.textContent = cell;
        tr.append(td);
      }
      table.append(tr);
    }
    root.replaceChildren(back, table);
  }

  return { render, root };
}
```

Move the `MatchRowInput`/`MatchHistoryPlayer` interface declarations **above** the functions; final file has interfaces first and no imports from server code.

- [ ] **Step 4: Wire the tab**

`desktop.html`: copy the `nav-settings` button block, change id to `nav-matches`, label `Матчи`. After `settings-workspace` section add:

```html
<section id="matches-workspace" class="workspace" hidden>
  <h2>Матчи</h2>
  <div id="matches-root"></div>
</section>
```

Match the existing section markup/classes of `settings-workspace` exactly (inspect around it when editing).

`ui.ts`: extend `Workspace` with `'matches'`, add `['matches', 'nav-matches']` to `WORKSPACE_NAV`, and in `showWorkspace` add `setHidden('matches-workspace', workspace !== 'matches')` plus a hook: when `workspace === 'matches'`, call a registered renderer. Export:

```ts
let renderMatches: (() => Promise<void>) | undefined;

/** index.ts registers the matches view once at boot. */
export function registerMatchesRenderer(renderer: () => Promise<void>): void {
  renderMatches = renderer;
}
```

and in `showWorkspace`: `if (workspace === 'matches' && renderMatches) void renderMatches();`

`index.ts` at boot (where `apiBaseUrl` and `currentLocalSteamId` live):

```ts
const matchesView = createMatchesView({ apiBaseUrl, defaultSteamId: currentLocalSteamId || undefined });
document.getElementById('matches-root')?.append(matchesView.root);
registerMatchesRenderer(() => matchesView.render());
```

`currentLocalSteamId` is module-level in `index.ts` and may be empty before the first game — `render()` falls back to the first user from `/users`, so empty default is fine.

- [ ] **Step 5: Run client tests + typecheck**

```bash
cd apps/overwolf-client && npx tsc --noEmit && npx jest --runInBand src/matches-view.spec.ts
```

Expected: typecheck clean, spec passes. Then the whole repo suite from root: `yarn workspaces run test`.

- [ ] **Step 6: Commit**

```bash
git add apps/overwolf-client/public/desktop.html apps/overwolf-client/src/ui.ts apps/overwolf-client/src/index.ts apps/overwolf-client/src/matches-view.ts apps/overwolf-client/src/matches-view.spec.ts
git commit -m "feat(match-history): desktop Матчи tab"
```

---

### Task 8: Deploy UAT + verify

**Files:** none (ops)

- [ ] **Step 1: Push and let CI deploy**

```bash
git push dynamo uat
```

`deploy-uat.yml` builds, runs migrations (`run-migrations.js` picks up `1792982400000`), recreates the container.

- [ ] **Step 2: Verify on the VPS**

```bash
ssh my-vps "docker inspect --format '{{.State.Health.Status}}' deadlock_dynamo_helper_uat-api-1"
ssh my-vps "curl -s http://127.0.0.1:3003/deadlock/match-history/users"
```

Expected: healthy; `{"users":[]}` (empty until someone plays with the UAT client).

- [ ] **Step 3: Smoke the write path**

POST a synthetic roster batch (matching `OverwolfLiveBatchDto`) to `http://127.0.0.1:3003/deadlock/live/events` from the VPS, then re-read `/users` and `/users/:steamId/matches`; confirm one row, then delete it via psql:

```bash
ssh my-vps 'docker exec aboba-telegramovich-postgres-1 psql -U postgres -d deadlock_builds_uat -c "delete from match_history_v1 where matchId = '"'"'smoke-test'"'"'; delete from app_users_v1 where steamId = '"'"'smoke-765'"'"';"'
```

- [ ] **Step 4: Verify the cron fired**

After 15 minutes: `docker logs deadlock_dynamo_helper_uat-api-1 --since 20m | grep -i enrich` — expect either a DONE for the smoke match (delete it after checking) or a NOT_FOUND/FAILED with a logged status. Enrichment status column tells the story; `matchId='smoke-test'` will be NOT_FOUND (no such official match), which is the correct behavior and doubles as a 404-path check.

- [ ] **Step 5: Commit nothing; report**
