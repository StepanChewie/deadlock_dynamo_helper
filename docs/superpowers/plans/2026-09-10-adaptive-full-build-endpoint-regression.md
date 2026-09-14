# Adaptive Full Build Endpoint Regression Implementation Plan

> **Historical design record.** At the time of writing this documented the referenced work; parts have since been implemented, refined by the ADRs, or superseded. It is kept for provenance, not as current instructions. Current architecture: `docs/architecture.md`; decisions: `docs/decisions/`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lock the already-merged adaptive full-build-path fix across the real Nest HTTP route and the Overwolf HTTP-client-to-presentation path so transaction barriers can never collapse the semantic `recommendedBuild` again.

**Architecture:** Keep the runtime code unchanged unless a regression test exposes a real defect. Add one API HTTP contract test that boots `AdaptiveRecommendationV1Controller` in a Nest application and verifies `POST /deadlock/adaptive/v1/recommend` serializes the complete semantic build alongside internal `planActions`. Add one Overwolf integration test that sends the same response shape through `AdaptiveRecommendationClient` and `buildAdaptiveRecommendationPresentation`, proving the user-facing Build Path is driven by `recommendedBuild`, not barrier rows.

**Tech Stack:** TypeScript, NestJS 11, Jest 30, Node.js 22 built-in `fetch`, Overwolf client TypeScript.

**Spec:** `docs/superpowers/plans/2026-09-10-adaptive-full-build-endpoint-regression.md` (closure plan for the merged full-build-path work from PRs #77/#79)

## Global Constraints

- The canonical HTTP route is `POST /deadlock/adaptive/v1/recommend`.
- `recommendedBuild` is the semantic Build Path source of truth for presentation.
- `planActions` may contain multiple transaction/barrier rows for the same target item and must not become duplicate Build Path rows.
- `NEXT` remains the current semantic target while transaction requirements/action detail come from the current plan action.
- No new production dependency is required; use Nest testing utilities and Node.js built-in `fetch`.
- Do not modify planner/scorer weights or serving policy as part of this regression closure.

---

### Task 1: HTTP endpoint contract

**Files:**
- Create: `apps/api/test/adaptive-recommendation-full-build-http-v1.integration.spec.ts`

**Interfaces:**
- Consumes: `AdaptiveRecommendationV1Controller` at `POST /deadlock/adaptive/v1/recommend`.
- Produces: A transport-level regression proving the full `recommendedBuild` survives Nest routing/serialization with `planActions` present.

- [ ] **Step 1: Write the HTTP regression test**

```ts
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AdaptiveRecommendationV1Controller } from '../src/statlocker-adaptive/adaptive-recommendation-v1.controller';
import { AdaptiveRecommendationV1Service } from '../src/statlocker-adaptive/adaptive-recommendation-v1.service';
import { AdaptiveRecommendationObservabilityV1Service } from '../src/statlocker-adaptive/adaptive-recommendation-observability-v1.service';
import { StatlockerEvidenceService } from '../src/statlocker-adaptive/statlocker-evidence.service';
import { StatlockerRefreshService } from '../src/statlocker-adaptive/statlocker-refresh.service';
import { StrategyFirstOperationsV1Service } from '../src/statlocker-adaptive/strategy-first-operations-v1.service';
import { StrategyFirstPromotionGateV1Service } from '../src/statlocker-adaptive/strategy-first-promotion-gate-v1.service';

const itemIds = [1342610602, 3862866912, 968099481, 1437614329, 7409189];

function plannedItem(itemId: number, position: number, status: 'NEXT' | 'PLANNED') {
  return {
    itemId,
    position,
    status,
    score: 0.5,
    confidence: 0.5,
    skeletonStrength: 0.5,
    contextualSupport: 0.5,
    reasonCodes: [],
  };
}

function recommendation() {
  return {
    ready: true,
    blockers: [],
    decisionId: 'decision-http-full-build',
    stateRevision: 'revision-http-full-build',
    gameState: 'BEHIND',
    nextAction: {
      actionKey: 'HOLD:1342610602',
      type: 'HOLD',
      targetItemId: 1342610602,
      reasonCodes: ['PLAN_REQUIREMENTS_BLOCKED'],
    },
    nextTargetItemId: 1342610602,
    planActions: [
      {
        planActionId: 'close-quarters:wait-current',
        sequence: 1,
        status: 'BLOCKED',
        action: {
          actionKey: 'WAIT:1342610602',
          type: 'WAIT',
          targetItemId: 1342610602,
          reasonCodes: ['WAIT_FOR_REQUIREMENTS'],
        },
        targetItemId: 1342610602,
        sourceItemIds: [],
        requirements: [{
          type: 'SOULS',
          requiredSouls: 800,
          currentSouls: 650,
          shortfallSouls: 150,
          evidence: 'OBSERVED',
        }],
        goalId: 'close-quarters-goal',
        reasonCodes: [],
      },
      {
        planActionId: 'close-quarters:wait-for-souls',
        sequence: 2,
        status: 'PLANNED',
        action: {
          actionKey: 'WAIT_FOR_SOULS:1342610602',
          type: 'WAIT',
          targetItemId: 1342610602,
          reasonCodes: [],
        },
        targetItemId: 1342610602,
        sourceItemIds: [],
        requirements: [{ type: 'SOULS', requiredSouls: 800, evidence: 'UNKNOWN' }],
        goalId: 'close-quarters-goal',
        reasonCodes: [],
      },
      {
        planActionId: 'close-quarters:buy',
        sequence: 3,
        status: 'PLANNED',
        action: {
          actionKey: 'BUY:1342610602',
          type: 'BUY',
          buyItemId: 1342610602,
          targetItemId: 1342610602,
          reasonCodes: [],
        },
        targetItemId: 1342610602,
        sourceItemIds: [],
        requirements: [],
        goalId: 'close-quarters-goal',
        reasonCodes: [],
      },
    ],
    recommendedBuild: itemIds.map((itemId, index) => plannedItem(
      itemId,
      index + 1,
      index === 0 ? 'NEXT' : 'PLANNED',
    )),
    changes: [],
    rankedImmediateCandidates: [],
    totalScore: 0.72,
    confidence: 0.56,
    scorerVersion: 'adaptive-evidence-scorer-v1',
    plannerVersion: 'adaptive-build-planner-v1',
    configVersion: 'statlocker-adaptive-v1.3.0',
    evidence: {
      rulesetVersion: 'ruleset-a',
      catalogSha256: 'a'.repeat(64),
      statlockerPatchId: '15-1',
      snapshotIds: ['snapshot-a'],
      families: [],
      degradedReasons: [],
    },
  };
}

describe('adaptive recommendation full-build HTTP contract', () => {
  let app: INestApplication;
  const service = { recommend: jest.fn() };

  beforeEach(async () => {
    service.recommend.mockResolvedValue(recommendation());
    const moduleRef = await Test.createTestingModule({
      controllers: [AdaptiveRecommendationV1Controller],
      providers: [
        { provide: AdaptiveRecommendationV1Service, useValue: service },
        { provide: StatlockerRefreshService, useValue: {} },
        { provide: StatlockerEvidenceService, useValue: {} },
        { provide: AdaptiveRecommendationObservabilityV1Service, useValue: {} },
        { provide: StrategyFirstPromotionGateV1Service, useValue: {} },
        { provide: StrategyFirstOperationsV1Service, useValue: {} },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
  });

  afterEach(async () => {
    await app.close();
    jest.clearAllMocks();
  });

  it('returns the complete semantic build without converting barrier rows into build rows', async () => {
    const response = await fetch(`${await app.getUrl()}/deadlock/adaptive/v1/recommend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matchId: 'match-a', localSteamId: 'steam-a' }),
    });
    const body = await response.json() as any;

    expect(response.status).toBe(201);
    expect(service.recommend).toHaveBeenCalledWith({ matchId: 'match-a', localSteamId: 'steam-a' });
    expect(body.recommendedBuild.map((row: any) => row.itemId)).toEqual(itemIds);
    expect(body.recommendedBuild.map((row: any) => row.status)).toEqual([
      'NEXT', 'PLANNED', 'PLANNED', 'PLANNED', 'PLANNED',
    ]);
    expect(body.planActions).toHaveLength(3);
    expect(body.planActions.every((row: any) => row.targetItemId === 1342610602)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the focused API test**

Run: `yarn workspace @deadlock-live-probe/api test --runTestsByPath test/adaptive-recommendation-full-build-http-v1.integration.spec.ts`

Expected on current `main`: PASS. The runtime behavior was already repaired by the merged full-build-path work, so this closure test is expected to lock existing behavior rather than manufacture an artificial RED.

- [ ] **Step 3: Run the related API regressions**

Run: `yarn workspace @deadlock-live-probe/api test --runTestsByPath test/adaptive-recommendation-controller-v1.spec.ts test/strategy-first-transaction-plan-completeness-v1.integration.spec.ts test/strategy-first-transaction-plan-v1.integration.spec.ts`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/test/adaptive-recommendation-full-build-http-v1.integration.spec.ts
git commit -m "test(api): lock full adaptive build HTTP contract"
```

### Task 2: Overwolf HTTP-to-presentation contract

**Files:**
- Create: `apps/overwolf-client/src/adaptive-recommendation-full-build-client.integration.spec.ts`

**Interfaces:**
- Consumes: `AdaptiveRecommendationClient.schedule()` and `buildAdaptiveRecommendationPresentation()`.
- Produces: A client-side regression proving the endpoint payload reaches Build Path presentation intact.

- [ ] **Step 1: Write the client integration regression**

```ts
import { AdaptiveRecommendationClient } from './adaptive-recommendation-client';
import { buildAdaptiveRecommendationPresentation } from './adaptive-recommendation-presentation';

const itemIds = [1342610602, 3862866912, 968099481, 1437614329, 7409189];

function plannedItem(itemId: number, position: number, status: 'NEXT' | 'PLANNED') {
  return {
    itemId,
    position,
    status,
    score: 0.5,
    confidence: 0.5,
    skeletonStrength: 0.5,
    contextualSupport: 0.5,
    reasonCodes: [],
  };
}

function payload(): any {
  return {
    ready: true,
    blockers: [],
    decisionId: 'decision-client-full-build',
    stateRevision: 'revision-client-full-build',
    gameState: 'BEHIND',
    nextAction: {
      actionKey: 'HOLD:1342610602',
      type: 'HOLD',
      targetItemId: 1342610602,
      reasonCodes: ['PLAN_REQUIREMENTS_BLOCKED'],
    },
    nextTargetItemId: 1342610602,
    planActions: [
      {
        planActionId: 'close-quarters:wait-current',
        sequence: 1,
        status: 'BLOCKED',
        action: {
          actionKey: 'WAIT:1342610602',
          type: 'WAIT',
          targetItemId: 1342610602,
          reasonCodes: ['WAIT_FOR_REQUIREMENTS'],
        },
        targetItemId: 1342610602,
        sourceItemIds: [],
        requirements: [{
          type: 'SOULS',
          requiredSouls: 800,
          currentSouls: 650,
          shortfallSouls: 150,
          evidence: 'OBSERVED',
        }],
        goalId: 'close-quarters-goal',
        reasonCodes: [],
      },
      {
        planActionId: 'close-quarters:wait-for-souls',
        sequence: 2,
        status: 'PLANNED',
        action: {
          actionKey: 'WAIT_FOR_SOULS:1342610602',
          type: 'WAIT',
          targetItemId: 1342610602,
          reasonCodes: [],
        },
        targetItemId: 1342610602,
        sourceItemIds: [],
        requirements: [{ type: 'SOULS', requiredSouls: 800, evidence: 'UNKNOWN' }],
        goalId: 'close-quarters-goal',
        reasonCodes: [],
      },
      {
        planActionId: 'close-quarters:buy',
        sequence: 3,
        status: 'PLANNED',
        action: {
          actionKey: 'BUY:1342610602',
          type: 'BUY',
          buyItemId: 1342610602,
          targetItemId: 1342610602,
          reasonCodes: [],
        },
        targetItemId: 1342610602,
        sourceItemIds: [],
        requirements: [],
        goalId: 'close-quarters-goal',
        reasonCodes: [],
      },
    ],
    recommendedBuild: itemIds.map((itemId, index) => plannedItem(
      itemId,
      index + 1,
      index === 0 ? 'NEXT' : 'PLANNED',
    )),
    changes: [],
    rankedImmediateCandidates: [],
    totalScore: 0.72,
    confidence: 0.56,
    scorerVersion: 'adaptive-evidence-scorer-v1',
    plannerVersion: 'adaptive-build-planner-v1',
    configVersion: 'statlocker-adaptive-v1.3.0',
    evidence: {
      rulesetVersion: 'ruleset-a',
      catalogSha256: 'a'.repeat(64),
      statlockerPatchId: '15-1',
      snapshotIds: ['snapshot-a'],
      families: [],
      degradedReasons: [],
    },
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('adaptive recommendation full-build client pipeline', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('renders the complete semantic build received from the recommendation endpoint', async () => {
    const fetcher = jest.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: jest.fn().mockResolvedValue(payload()),
    } as any);
    let presented: ReturnType<typeof buildAdaptiveRecommendationPresentation> | undefined;
    const client = new AdaptiveRecommendationClient('https://api.example', fetcher, 10);

    client.schedule(
      { matchId: 'match-a', localSteamId: 'steam-a' },
      { onResult: (result) => { presented = buildAdaptiveRecommendationPresentation(result); } },
    );
    jest.advanceTimersByTime(10);
    await flush();

    expect(fetcher).toHaveBeenCalledWith(
      'https://api.example/deadlock/adaptive/v1/recommend',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(presented?.plan.items.map((row) => row.item.id)).toEqual(itemIds);
    expect(presented?.plan.items).toHaveLength(5);
    expect(presented?.plan.items[0]).toMatchObject({
      statusLabel: 'Next',
      actionLabel: 'Hold',
      requirements: ['Save until 800 souls'],
    });
    expect(presented?.plan.items.slice(1).every((row) => row.actionLabel === 'Planned')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the focused Overwolf test**

Run: `yarn workspace @deadlock-live-probe/overwolf-client test --runTestsByPath src/adaptive-recommendation-full-build-client.integration.spec.ts`

Expected: PASS.

- [ ] **Step 3: Run related Overwolf regressions**

Run: `yarn workspace @deadlock-live-probe/overwolf-client test --runTestsByPath src/adaptive-recommendation-client.spec.ts src/adaptive-recommendation-full-build-path.spec.ts src/adaptive-recommendation-presentation.spec.ts src/adaptive-transaction-plan-presentation.spec.ts src/ui.spec.ts`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/overwolf-client/src/adaptive-recommendation-full-build-client.integration.spec.ts
git commit -m "test(overwolf): lock full build HTTP presentation path"
```

### Task 3: Full verification and integration

**Files:**
- Verify only; no runtime source changes are expected.

**Interfaces:**
- Consumes: repository CI defined in `.github/workflows/ci.yml`.
- Produces: a green PR whose normal CI executes full API and Overwolf suites plus builds.

- [ ] **Step 1: Run/observe the PR CI**

Expected required jobs: `Build project`, `Build Overwolf client`, `Run tests`, and `Validate production runtime` all PASS.

- [ ] **Step 2: Verify the branch diff against `main`**

Expected: only the plan document plus the two regression specs; no planner/scorer/serving runtime changes.

- [ ] **Step 3: Merge after green CI**

Use the repository's normal pull-request path. The merge must not be claimed complete until the merge result is confirmed by GitHub.

- [ ] **Step 4: Verify the merge landed on `main`**

Confirm `main` contains both regression specs and the merge commit is an ancestor of the current `main` head.
