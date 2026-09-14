# Deadlock Live Probe Implementation Plan

> **Historical design record.** At the time of writing this documented the referenced work; parts have since been implemented, refined by the ADRs, or superseded. It is kept for provenance, not as current instructions. Current architecture: `docs/architecture.md`; decisions: `docs/decisions/`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local MVP that captures Deadlock live data through Overwolf, ships it to a NestJS API, logs raw events, reduces a minimal match state, and exposes a debug page for live lobby verification.

**Architecture:** Use a Yarn workspace monorepo with three packages: a NestJS API in `apps/api`, an Overwolf runtime app in `apps/overwolf-client`, and shared TypeScript DTO/state types in `packages/shared`. The API owns ingest, logging, reduction, and debug inspection, while the Overwolf app owns GEP integration, event buffering, and transport to the API.

**Tech Stack:** Yarn workspaces, TypeScript, NestJS, Jest, Overwolf GEP runtime APIs, plain HTML debug page, NDJSON file storage.

---

## File Structure

### Workspace root

- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `README.md`

### Shared package

- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/index.ts`
- Create: `packages/shared/src/live-events.ts`

### API app

- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `apps/api/tsconfig.build.json`
- Create: `apps/api/nest-cli.json`
- Create: `apps/api/src/main.ts`
- Create: `apps/api/src/app.module.ts`
- Create: `apps/api/src/deadlock-live/deadlock-live.module.ts`
- Create: `apps/api/src/deadlock-live/live-ingest.controller.ts`
- Create: `apps/api/src/deadlock-live/live-match-state.service.ts`
- Create: `apps/api/src/deadlock-live/raw-event-log.service.ts`
- Create: `apps/api/src/deadlock-live/recent-live-events.service.ts`
- Create: `apps/api/src/deadlock-live/debug-page.controller.ts`
- Create: `apps/api/test/live-match-state.service.spec.ts`
- Create: `apps/api/test/live-ingest.controller.spec.ts`

### Overwolf client

- Create: `apps/overwolf-client/package.json`
- Create: `apps/overwolf-client/tsconfig.json`
- Create: `apps/overwolf-client/webpack.config.js`
- Create: `apps/overwolf-client/public/manifest.json`
- Create: `apps/overwolf-client/public/desktop.html`
- Create: `apps/overwolf-client/src/global.d.ts`
- Create: `apps/overwolf-client/src/index.ts`
- Create: `apps/overwolf-client/src/ui.ts`
- Create: `apps/overwolf-client/src/overwolf/set-required-features.ts`
- Create: `apps/overwolf-client/src/overwolf/listen-overwolf-events.ts`
- Create: `apps/overwolf-client/src/overwolf/live-event-buffer.ts`
- Create: `apps/overwolf-client/src/overwolf/parse-json-safely.ts`
- Create: `apps/overwolf-client/src/overwolf/parse-json-safely.spec.ts`
- Create: `apps/overwolf-client/src/overwolf/live-event-buffer.spec.ts`

### Docs

- Modify: `docs/superpowers/specs/2026-07-09-deadlock-live-probe-design.md`
- Create: `docs/overwolf-deadlock-live-probe-runbook.md`

## Task 1: Bootstrap Yarn Workspace

**Files:**
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `README.md`

- [ ] **Step 1: Write the failing workspace check**

Create `README.md` with the expected workspace commands so the first install command has an explicit contract:

```md
# Deadlock Live Probe

Expected root commands:

- `yarn install`
- `yarn build`
- `yarn test`
```

- [ ] **Step 2: Run install to verify the workspace does not exist yet**

Run: `yarn install`
Expected: FAIL because no root `package.json` exists yet.

- [ ] **Step 3: Write the minimal workspace files**

Create `package.json`:

```json
{
  "name": "deadlock-live-probe",
  "private": true,
  "packageManager": "yarn@1.22.22",
  "workspaces": [
    "apps/*",
    "packages/*"
  ],
  "scripts": {
    "build": "yarn workspaces run build",
    "test": "yarn workspaces run test",
    "lint": "yarn workspaces run lint"
  }
}
```

Create `tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2021",
    "module": "commonjs",
    "moduleResolution": "node",
    "strict": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "baseUrl": ".",
    "paths": {
      "@deadlock-live-probe/shared": [
        "packages/shared/src"
      ]
    }
  }
}
```

Create `.gitignore`:

```gitignore
node_modules
dist
.yarn
coverage
storage
```

- [ ] **Step 4: Run install to verify the workspace now resolves**

Run: `yarn install`
Expected: PASS with a generated `yarn.lock`.

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.base.json .gitignore README.md yarn.lock
git commit -m "chore: bootstrap yarn workspace"
```

## Task 2: Add Shared Live Types

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/index.ts`
- Create: `packages/shared/src/live-events.ts`

- [ ] **Step 1: Write the failing type build check**

Create `packages/shared/package.json`:

```json
{
  "name": "@deadlock-live-probe/shared",
  "version": "0.0.1",
  "private": true,
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "echo \"shared: no tests\"",
    "lint": "echo \"shared: no lint\""
  },
  "devDependencies": {
    "typescript": "^5.9.2"
  }
}
```

Create `packages/shared/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "declaration": true
  },
  "include": [
    "src/**/*.ts"
  ]
}
```

- [ ] **Step 2: Run the package build to verify it fails**

Run: `yarn workspace @deadlock-live-probe/shared build`
Expected: FAIL because `src/index.ts` does not exist yet.

- [ ] **Step 3: Write the minimal shared types**

Create `packages/shared/src/live-events.ts`:

```ts
export type OverwolfLiveEventSource = 'onInfoUpdates2' | 'onNewEvents';

export type OverwolfLiveEventDto = {
  matchId?: string;
  receivedAt: number;
  source: OverwolfLiveEventSource;
  feature?: string;
  category?: string;
  key?: string;
  payload: unknown;
};

export type OverwolfLiveBatchDto = {
  clientId: string;
  events: OverwolfLiveEventDto[];
};

export type MinimalItemState = {
  id: number;
  name: string;
  className: string;
  enhanced: boolean;
  firstSeenAtSec?: number;
};

export type MinimalPlayerState = {
  steamId: string;
  playerName: string;
  heroId?: number;
  heroName?: string;
  teamId?: number;
  lane?: number;
  level?: number;
  souls?: number;
  health?: number;
  maxHealth?: number;
  kills?: number;
  deaths?: number;
  assists?: number;
  heroDamage?: number;
  objectDamage?: number;
  healing?: number;
  items: MinimalItemState[];
};

export type MinimalMatchState = {
  matchId: string;
  gameTimeSec?: number;
  playersBySteamId: Record<string, MinimalPlayerState>;
  lastUpdatedAt: string;
};
```

Create `packages/shared/src/index.ts`:

```ts
export * from './live-events';
```

- [ ] **Step 4: Run the build to verify it passes**

Run: `yarn workspace @deadlock-live-probe/shared build`
Expected: PASS with `dist/index.js` and type declarations.

- [ ] **Step 5: Commit**

```bash
git add packages/shared
git commit -m "feat: add shared live event types"
```

## Task 3: Scaffold NestJS API

**Files:**
- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `apps/api/tsconfig.build.json`
- Create: `apps/api/nest-cli.json`
- Create: `apps/api/src/main.ts`
- Create: `apps/api/src/app.module.ts`
- Create: `apps/api/src/deadlock-live/deadlock-live.module.ts`

- [ ] **Step 1: Write the failing API boot check**

Create `apps/api/package.json`:

```json
{
  "name": "@deadlock-live-probe/api",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "build": "nest build",
    "start": "nest start",
    "start:dev": "nest start --watch",
    "test": "jest --runInBand",
    "lint": "echo \"api: no lint\""
  },
  "dependencies": {
    "@deadlock-live-probe/shared": "0.0.1",
    "@nestjs/common": "^11.1.6",
    "@nestjs/core": "^11.1.6",
    "@nestjs/platform-express": "^11.1.6",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.2"
  },
  "devDependencies": {
    "@nestjs/cli": "^11.0.10",
    "@nestjs/testing": "^11.1.6",
    "@types/jest": "^30.0.0",
    "@types/node": "^24.2.1",
    "jest": "^30.0.5",
    "ts-jest": "^29.4.1",
    "ts-node": "^10.9.2",
    "typescript": "^5.9.2"
  }
}
```

- [ ] **Step 2: Run the API build to verify it fails**

Run: `yarn workspace @deadlock-live-probe/api build`
Expected: FAIL because Nest config and source files do not exist yet.

- [ ] **Step 3: Write the minimal Nest app shell**

Create `apps/api/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": ".",
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true
  },
  "include": [
    "src/**/*.ts",
    "test/**/*.ts"
  ]
}
```

Create `apps/api/tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "exclude": [
    "test/**/*.ts"
  ]
}
```

Create `apps/api/nest-cli.json`:

```json
{
  "collection": "@nestjs/schematics",
  "sourceRoot": "src"
}
```

Create `apps/api/src/main.ts`:

```ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  await app.listen(3000);
}

void bootstrap();
```

Create `apps/api/src/app.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { DeadlockLiveModule } from './deadlock-live/deadlock-live.module';

@Module({
  imports: [DeadlockLiveModule],
})
export class AppModule {}
```

Create `apps/api/src/deadlock-live/deadlock-live.module.ts`:

```ts
import { Module } from '@nestjs/common';

@Module({})
export class DeadlockLiveModule {}
```

- [ ] **Step 4: Run the API build to verify it passes**

Run: `yarn workspace @deadlock-live-probe/api build`
Expected: PASS and emit `apps/api/dist`.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat: scaffold nest api app"
```

## Task 4: Build the Match State Reducer with TDD

**Files:**
- Create: `apps/api/src/deadlock-live/live-match-state.service.ts`
- Create: `apps/api/test/live-match-state.service.spec.ts`
- Modify: `apps/api/src/deadlock-live/deadlock-live.module.ts`

- [ ] **Step 1: Write the failing reducer tests**

Create `apps/api/test/live-match-state.service.spec.ts`:

```ts
import { LiveMatchStateService } from '../src/deadlock-live/live-match-state.service';

describe('LiveMatchStateService', () => {
  it('extracts match id and match clock', () => {
    const service = new LiveMatchStateService();
    const state = service.applyBatch({
      clientId: 'test-client',
      events: [
        { receivedAt: 1, source: 'onInfoUpdates2', key: 'match_id', payload: '42' },
        { receivedAt: 2, source: 'onInfoUpdates2', key: 'match_clock', payload: '01:30' },
      ],
    });

    expect(state?.matchId).toBe('42');
    expect(state?.gameTimeSec).toBe(90);
  });

  it('merges roster updates by steam id', () => {
    const service = new LiveMatchStateService();
    service.applyBatch({
      clientId: 'test-client',
      events: [
        {
          receivedAt: 1,
          source: 'onInfoUpdates2',
          key: 'roster_0',
          payload: { steam_id: 's1', player_name: 'P1', hero_name: 'Warden', team: 1, souls: 500 },
        },
      ],
    });

    const state = service.applyBatch({
      clientId: 'test-client',
      events: [
        {
          receivedAt: 2,
          source: 'onInfoUpdates2',
          key: 'roster_0',
          payload: { steam_id: 's1', health: 900, kills: 2, deaths: 1, assists: 3 },
        },
      ],
    });

    expect(state?.playersBySteamId.s1.heroName).toBe('Warden');
    expect(state?.playersBySteamId.s1.teamId).toBe(1);
    expect(state?.playersBySteamId.s1.souls).toBe(500);
    expect(state?.playersBySteamId.s1.health).toBe(900);
    expect(state?.playersBySteamId.s1.kills).toBe(2);
  });

  it('replaces item lists for a player', () => {
    const service = new LiveMatchStateService();
    service.applyBatch({
      clientId: 'test-client',
      events: [
        { receivedAt: 1, source: 'onInfoUpdates2', key: 'match_id', payload: '42' },
        { receivedAt: 2, source: 'onInfoUpdates2', key: 'match_clock', payload: '02:00' },
        {
          receivedAt: 3,
          source: 'onInfoUpdates2',
          key: 'items_0',
          payload: { steam_id: 's1', items: [{ id: 1, name: 'Boots', class_name: 'boots', enhanced: false }] },
        },
      ],
    });

    const state = service.applyBatch({
      clientId: 'test-client',
      events: [
        {
          receivedAt: 4,
          source: 'onInfoUpdates2',
          key: 'items_0',
          payload: { steam_id: 's1', items: [{ id: 2, name: 'Gun', class_name: 'gun', enhanced: true }] },
        },
      ],
    });

    expect(state?.playersBySteamId.s1.items).toEqual([
      { id: 2, name: 'Gun', className: 'gun', enhanced: true, firstSeenAtSec: 120 },
    ]);
  });

  it('ignores malformed payloads without throwing', () => {
    const service = new LiveMatchStateService();

    expect(() =>
      service.applyBatch({
        clientId: 'test-client',
        events: [{ receivedAt: 1, source: 'onNewEvents', key: 'roster_0', payload: 'bad' }],
      }),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the reducer tests to verify they fail**

Run: `yarn workspace @deadlock-live-probe/api test apps/api/test/live-match-state.service.spec.ts`
Expected: FAIL because `LiveMatchStateService` does not exist.

- [ ] **Step 3: Write the minimal reducer implementation**

Create `apps/api/src/deadlock-live/live-match-state.service.ts` with the tolerant reducer from the approved spec, including:

```ts
import { Injectable } from '@nestjs/common';
import {
  MinimalMatchState,
  OverwolfLiveBatchDto,
  OverwolfLiveEventDto,
} from '@deadlock-live-probe/shared';

@Injectable()
export class LiveMatchStateService {
  private readonly states = new Map<string, MinimalMatchState>();

  applyBatch(batch: OverwolfLiveBatchDto): MinimalMatchState | undefined {
    let currentMatchId = this.extractMatchId(batch.events) ?? 'unknown';

    const state = this.states.get(currentMatchId) ?? {
      matchId: currentMatchId,
      playersBySteamId: {},
      lastUpdatedAt: new Date().toISOString(),
    };

    for (const event of batch.events) {
      this.applyEvent(state, event);
    }

    state.lastUpdatedAt = new Date().toISOString();
    this.states.set(currentMatchId, state);

    return state;
  }

  getState(matchId: string): MinimalMatchState | undefined {
    return this.states.get(matchId);
  }

  getAllStates(): MinimalMatchState[] {
    return [...this.states.values()];
  }

  private applyEvent(state: MinimalMatchState, event: OverwolfLiveEventDto): void {
    if (event.key === 'match_clock') {
      const seconds = this.parseClockSeconds(event.payload);
      if (seconds !== undefined) state.gameTimeSec = seconds;
      return;
    }

    if (event.key?.startsWith('roster')) {
      this.applyRosterPayload(state, event.payload);
      return;
    }

    if (event.key?.startsWith('items')) {
      this.applyItemsPayload(state, event.payload);
    }
  }

  private extractMatchId(events: OverwolfLiveEventDto[]): string | undefined { return undefined; }
  private parseClockSeconds(payload: unknown): number | undefined { return undefined; }
  private applyRosterPayload(state: MinimalMatchState, payload: unknown): void {}
  private applyItemsPayload(state: MinimalMatchState, payload: unknown): void {}
}
```

Then fill in the helper methods exactly as defined in the approved design.

Modify `apps/api/src/deadlock-live/deadlock-live.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { LiveMatchStateService } from './live-match-state.service';

@Module({
  providers: [LiveMatchStateService],
  exports: [LiveMatchStateService],
})
export class DeadlockLiveModule {}
```

- [ ] **Step 4: Run the reducer tests to verify they pass**

Run: `yarn workspace @deadlock-live-probe/api test --runTestsByPath test/live-match-state.service.spec.ts`
Expected: PASS with 4 passing tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/deadlock-live/live-match-state.service.ts apps/api/src/deadlock-live/deadlock-live.module.ts apps/api/test/live-match-state.service.spec.ts
git commit -m "feat: add live match state reducer"
```

## Task 5: Add Raw Event Logging and Recent Events Storage

**Files:**
- Create: `apps/api/src/deadlock-live/raw-event-log.service.ts`
- Create: `apps/api/src/deadlock-live/recent-live-events.service.ts`
- Modify: `apps/api/src/deadlock-live/deadlock-live.module.ts`

- [ ] **Step 1: Write the failing service import check**

Update `apps/api/src/deadlock-live/deadlock-live.module.ts` to reference services that do not exist yet:

```ts
import { Module } from '@nestjs/common';
import { LiveMatchStateService } from './live-match-state.service';
import { RawEventLogService } from './raw-event-log.service';
import { RecentLiveEventsService } from './recent-live-events.service';

@Module({
  providers: [LiveMatchStateService, RawEventLogService, RecentLiveEventsService],
  exports: [LiveMatchStateService, RawEventLogService, RecentLiveEventsService],
})
export class DeadlockLiveModule {}
```

- [ ] **Step 2: Run the API build to verify it fails**

Run: `yarn workspace @deadlock-live-probe/api build`
Expected: FAIL because the two services do not exist.

- [ ] **Step 3: Write the minimal logging and recent-event services**

Create `apps/api/src/deadlock-live/raw-event-log.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { OverwolfLiveEventDto } from '@deadlock-live-probe/shared';

@Injectable()
export class RawEventLogService {
  private readonly baseDir = join(process.cwd(), 'storage', 'deadlock-live');

  async appendEvents(events: OverwolfLiveEventDto[]): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });

    for (const event of events) {
      const matchId = event.matchId ?? 'unknown';
      const filePath = join(this.baseDir, `${matchId}.ndjson`);
      await appendFile(filePath, `${JSON.stringify(event)}\n`, 'utf8');
    }
  }
}
```

Create `apps/api/src/deadlock-live/recent-live-events.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { OverwolfLiveEventDto } from '@deadlock-live-probe/shared';

@Injectable()
export class RecentLiveEventsService {
  private readonly limit = 100;
  private readonly events: OverwolfLiveEventDto[] = [];

  append(events: OverwolfLiveEventDto[]): void {
    this.events.push(...events);
    if (this.events.length > this.limit) {
      this.events.splice(0, this.events.length - this.limit);
    }
  }

  getRecent(): OverwolfLiveEventDto[] {
    return [...this.events];
  }
}
```

- [ ] **Step 4: Run the API build to verify it passes**

Run: `yarn workspace @deadlock-live-probe/api build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/deadlock-live/raw-event-log.service.ts apps/api/src/deadlock-live/recent-live-events.service.ts apps/api/src/deadlock-live/deadlock-live.module.ts
git commit -m "feat: add raw event logging services"
```

## Task 6: Add Ingest, State, Recent Events, and Debug Page Endpoints

**Files:**
- Create: `apps/api/src/deadlock-live/live-ingest.controller.ts`
- Create: `apps/api/src/deadlock-live/debug-page.controller.ts`
- Create: `apps/api/test/live-ingest.controller.spec.ts`
- Modify: `apps/api/src/deadlock-live/deadlock-live.module.ts`

- [ ] **Step 1: Write the failing controller test**

Create `apps/api/test/live-ingest.controller.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { LiveIngestController } from '../src/deadlock-live/live-ingest.controller';
import { LiveMatchStateService } from '../src/deadlock-live/live-match-state.service';
import { RawEventLogService } from '../src/deadlock-live/raw-event-log.service';
import { RecentLiveEventsService } from '../src/deadlock-live/recent-live-events.service';

describe('LiveIngestController', () => {
  it('ingests events and exposes state and recent events', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [LiveIngestController],
      providers: [
        LiveMatchStateService,
        RecentLiveEventsService,
        {
          provide: RawEventLogService,
          useValue: { appendEvents: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    const controller = moduleRef.get(LiveIngestController);

    await controller.ingestEvents({
      clientId: 'client',
      events: [{ receivedAt: 1, source: 'onInfoUpdates2', key: 'match_id', payload: 'm1' }],
    });

    expect(controller.getStates()).toHaveLength(1);
    expect(controller.getRecentEvents()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the controller test to verify it fails**

Run: `yarn workspace @deadlock-live-probe/api test --runTestsByPath test/live-ingest.controller.spec.ts`
Expected: FAIL because the controller does not exist.

- [ ] **Step 3: Write the minimal controllers**

Create `apps/api/src/deadlock-live/live-ingest.controller.ts`:

```ts
import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { OverwolfLiveBatchDto } from '@deadlock-live-probe/shared';
import { LiveMatchStateService } from './live-match-state.service';
import { RawEventLogService } from './raw-event-log.service';
import { RecentLiveEventsService } from './recent-live-events.service';

@Controller('deadlock/live')
export class LiveIngestController {
  constructor(
    private readonly rawEventLogService: RawEventLogService,
    private readonly liveMatchStateService: LiveMatchStateService,
    private readonly recentLiveEventsService: RecentLiveEventsService,
  ) {}

  @Post('events')
  async ingestEvents(@Body() batch: OverwolfLiveBatchDto): Promise<{ ok: true }> {
    await this.rawEventLogService.appendEvents(batch.events);
    this.recentLiveEventsService.append(batch.events);
    this.liveMatchStateService.applyBatch(batch);
    return { ok: true };
  }

  @Get('states')
  getStates() {
    return this.liveMatchStateService.getAllStates();
  }

  @Get('matches/:matchId/state')
  getState(@Param('matchId') matchId: string) {
    return this.liveMatchStateService.getState(matchId);
  }

  @Get('events/recent')
  getRecentEvents() {
    return this.recentLiveEventsService.getRecent();
  }
}
```

Create `apps/api/src/deadlock-live/debug-page.controller.ts`:

```ts
import { Controller, Get, Header } from '@nestjs/common';

@Controller('deadlock/live')
export class DebugPageController {
  @Get('debug')
  @Header('Content-Type', 'text/html; charset=utf-8')
  getDebugPage(): string {
    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Deadlock Live Debug</title>
  </head>
  <body>
    <h1>Deadlock Live Debug</h1>
    <pre id="state">loading</pre>
    <pre id="events">loading</pre>
    <script>
      async function refresh() {
        const states = await fetch('/deadlock/live/states').then((res) => res.json());
        const events = await fetch('/deadlock/live/events/recent').then((res) => res.json());
        document.getElementById('state').textContent = JSON.stringify(states, null, 2);
        document.getElementById('events').textContent = JSON.stringify(events, null, 2);
      }
      setInterval(refresh, 1000);
      refresh();
    </script>
  </body>
</html>`;
  }
}
```

Modify `apps/api/src/deadlock-live/deadlock-live.module.ts` to register both controllers.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn workspace @deadlock-live-probe/api test --runTestsByPath test/live-ingest.controller.spec.ts test/live-match-state.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/deadlock-live/live-ingest.controller.ts apps/api/src/deadlock-live/debug-page.controller.ts apps/api/src/deadlock-live/deadlock-live.module.ts apps/api/test/live-ingest.controller.spec.ts
git commit -m "feat: add deadlock live api endpoints"
```

## Task 7: Add Overwolf Parser and Event Buffer with TDD

**Files:**
- Create: `apps/overwolf-client/package.json`
- Create: `apps/overwolf-client/tsconfig.json`
- Create: `apps/overwolf-client/src/overwolf/parse-json-safely.ts`
- Create: `apps/overwolf-client/src/overwolf/live-event-buffer.ts`
- Create: `apps/overwolf-client/src/overwolf/parse-json-safely.spec.ts`
- Create: `apps/overwolf-client/src/overwolf/live-event-buffer.spec.ts`

- [ ] **Step 1: Write the failing helper tests**

Create `apps/overwolf-client/src/overwolf/parse-json-safely.spec.ts`:

```ts
import { parseJsonSafely } from './parse-json-safely';

describe('parseJsonSafely', () => {
  it('parses valid JSON strings', () => {
    expect(parseJsonSafely('{\"a\":1}')).toEqual({ a: 1 });
  });

  it('returns raw value for invalid JSON', () => {
    expect(parseJsonSafely('not-json')).toBe('not-json');
  });
});
```

Create `apps/overwolf-client/src/overwolf/live-event-buffer.spec.ts`:

```ts
import { LiveEventBuffer } from './live-event-buffer';

describe('LiveEventBuffer', () => {
  it('flushes a batch to the api', async () => {
    const calls: unknown[] = [];
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      return { ok: true } as Response;
    };

    const buffer = new LiveEventBuffer('client-1', 'http://localhost:3000', fetchImpl, 10);
    buffer.push({ receivedAt: 1, source: 'onInfoUpdates2', payload: { ok: true } });

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(calls).toEqual([
      {
        clientId: 'client-1',
        events: [{ receivedAt: 1, source: 'onInfoUpdates2', payload: { ok: true } }],
      },
    ]);
  });
});
```

- [ ] **Step 2: Run the Overwolf tests to verify they fail**

Run: `yarn workspace @deadlock-live-probe/overwolf-client test`
Expected: FAIL because the package and source files do not exist.

- [ ] **Step 3: Write the minimal package and helper implementations**

Create `apps/overwolf-client/package.json`:

```json
{
  "name": "@deadlock-live-probe/overwolf-client",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "build": "webpack --mode production",
    "dev": "webpack --mode development",
    "test": "jest --runInBand",
    "lint": "echo \"overwolf: no lint\""
  },
  "dependencies": {
    "@deadlock-live-probe/shared": "0.0.1"
  },
  "devDependencies": {
    "@types/jest": "^30.0.0",
    "@types/node": "^24.2.1",
    "jest": "^30.0.5",
    "ts-jest": "^29.4.1",
    "ts-loader": "^9.5.4",
    "typescript": "^5.9.2",
    "webpack": "^5.101.3",
    "webpack-cli": "^6.0.1"
  }
}
```

Create `apps/overwolf-client/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "lib": ["ES2021", "DOM"],
    "types": ["node", "jest"]
  },
  "include": ["src/**/*.ts"]
}
```

Create `apps/overwolf-client/src/overwolf/parse-json-safely.ts`:

```ts
export function parseJsonSafely(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
```

Create `apps/overwolf-client/src/overwolf/live-event-buffer.ts`:

```ts
import { OverwolfLiveBatchDto, OverwolfLiveEventDto } from '@deadlock-live-probe/shared';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class LiveEventBuffer {
  private readonly events: OverwolfLiveEventDto[] = [];
  private timerId?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly clientId: string,
    private readonly apiBaseUrl: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly flushDelayMs = 1000,
  ) {}

  push(event: OverwolfLiveEventDto): void {
    this.events.push(event);

    if (this.timerId) {
      return;
    }

    this.timerId = setTimeout(() => {
      void this.flush();
    }, this.flushDelayMs);
  }

  private async flush(): Promise<void> {
    const events = this.events.splice(0);
    this.timerId = undefined;

    if (events.length === 0) {
      return;
    }

    const body: OverwolfLiveBatchDto = {
      clientId: this.clientId,
      events,
    };

    await this.fetchImpl(`${this.apiBaseUrl}/deadlock/live/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
}
```

- [ ] **Step 4: Run the Overwolf tests to verify they pass**

Run: `yarn workspace @deadlock-live-probe/overwolf-client test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/overwolf-client/package.json apps/overwolf-client/tsconfig.json apps/overwolf-client/src/overwolf
git commit -m "feat: add overwolf buffer primitives"
```

## Task 8: Build the Overwolf Runtime App

**Files:**
- Create: `apps/overwolf-client/webpack.config.js`
- Create: `apps/overwolf-client/public/manifest.json`
- Create: `apps/overwolf-client/public/desktop.html`
- Create: `apps/overwolf-client/src/global.d.ts`
- Create: `apps/overwolf-client/src/index.ts`
- Create: `apps/overwolf-client/src/ui.ts`
- Create: `apps/overwolf-client/src/overwolf/set-required-features.ts`
- Create: `apps/overwolf-client/src/overwolf/listen-overwolf-events.ts`

- [ ] **Step 1: Write the failing runtime build check**

Run: `yarn workspace @deadlock-live-probe/overwolf-client build`
Expected: FAIL because webpack config and entry files do not exist.

- [ ] **Step 2: Write the minimal Overwolf runtime files**

Create `apps/overwolf-client/src/global.d.ts` with minimal Overwolf typings used by the app.

Create `apps/overwolf-client/src/overwolf/set-required-features.ts`:

```ts
const REQUIRED_FEATURES = ['game_info', 'match_info'];

export function setRequiredFeatures(): Promise<void> {
  return new Promise((resolve, reject) => {
    overwolf.games.events.setRequiredFeatures(REQUIRED_FEATURES, (result) => {
      if (!result.success) {
        reject(new Error(result.error ?? 'Failed to set required features'));
        return;
      }

      resolve();
    });
  });
}
```

Create `apps/overwolf-client/src/overwolf/listen-overwolf-events.ts` using `parseJsonSafely` and the event normalization contract from the approved spec.

Create `apps/overwolf-client/src/ui.ts` with a tiny DOM helper that updates:

- connection status
- last event timestamp
- total buffered sends
- last error

Create `apps/overwolf-client/src/index.ts` to:

- instantiate `LiveEventBuffer`
- call `setRequiredFeatures()`
- attach listeners
- log raw events to `console.log`
- update the UI state

Create `apps/overwolf-client/public/desktop.html` with:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Deadlock Live Probe</title>
  </head>
  <body>
    <h1>Deadlock Live Probe</h1>
    <div id="status">booting</div>
    <div id="last-event">never</div>
    <div id="last-send">never</div>
    <div id="last-error">none</div>
    <script src="../dist/index.js"></script>
  </body>
</html>
```

Create `apps/overwolf-client/public/manifest.json` with a valid Overwolf desktop-window manifest targeting the Deadlock game id that will be supplied from the current Overwolf developer documentation before finalizing the file.

Create `apps/overwolf-client/webpack.config.js` to bundle `src/index.ts` into `dist/index.js`.

- [ ] **Step 3: Run the runtime build to verify it passes**

Run: `yarn workspace @deadlock-live-probe/overwolf-client build`
Expected: PASS and emit `apps/overwolf-client/dist/index.js`.

- [ ] **Step 4: Smoke-check the output layout**

Run: `find apps/overwolf-client -maxdepth 3 -type f | sort`
Expected: includes `public/manifest.json`, `public/desktop.html`, and `dist/index.js`.

- [ ] **Step 5: Commit**

```bash
git add apps/overwolf-client
git commit -m "feat: add overwolf deadlock client app"
```

## Task 9: Wire API Debug Experience and Runbook

**Files:**
- Modify: `apps/api/src/deadlock-live/debug-page.controller.ts`
- Create: `docs/overwolf-deadlock-live-probe-runbook.md`
- Modify: `README.md`

- [ ] **Step 1: Write the failing operator check**

Update `README.md` to expect exact verification commands:

```md
## Verification

- `yarn workspace @deadlock-live-probe/api start:dev`
- Open `http://localhost:3000/deadlock/live/debug`
- Load the Overwolf app from `apps/overwolf-client/public/manifest.json`
```

- [ ] **Step 2: Run a manual doc check to confirm missing details**

Run: `sed -n '1,200p' README.md`
Expected: missing the full runbook before this task is complete.

- [ ] **Step 3: Write the minimal operator docs and improve the debug page**

Expand `apps/api/src/deadlock-live/debug-page.controller.ts` to render labeled sections for:

- match ids
- current match clock
- player summaries
- recent raw events

Create `docs/overwolf-deadlock-live-probe-runbook.md` with:

- prerequisites
- `yarn install`
- `yarn workspace @deadlock-live-probe/api start:dev`
- `yarn workspace @deadlock-live-probe/overwolf-client build`
- how to load the Overwolf manifest in developer mode
- how to start Deadlock and join a test lobby
- which browser URL to open
- what successful signals to look for
- where NDJSON files are written

Update `README.md` to link the runbook.

- [ ] **Step 4: Run the API tests and a root build to verify documentation matches reality**

Run: `yarn test`
Expected: PASS across all workspace tests.

Run: `yarn build`
Expected: PASS across all workspace builds.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/overwolf-deadlock-live-probe-runbook.md apps/api/src/deadlock-live/debug-page.controller.ts
git commit -m "docs: add deadlock live probe runbook"
```

## Self-Review

- Spec coverage check: the plan covers monorepo bootstrap, shared DTOs, NestJS ingest/logging/state/debug, Overwolf required features and listeners, batching, recent events inspection, and local run instructions.
- Placeholder scan: one implementation detail still requires live confirmation from current Overwolf docs before finalizing `manifest.json`, specifically the Deadlock game id and any required manifest permissions.
- Type consistency check: shared DTO names and state names match the approved spec and are reused consistently across the API and Overwolf tasks.

## Open Verification Item

Before executing Task 8, confirm the current Deadlock Overwolf game id and any manifest-specific requirements from primary Overwolf documentation. This is required because that value is time-sensitive and not safe to hardcode from memory.
