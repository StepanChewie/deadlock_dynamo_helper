# Inventory Build Progression Implementation Plan

> **Historical design record.** At the time of writing this documented the referenced work; parts have since been implemented, refined by the ADRs, or superseded. It is kept for provenance, not as current instructions. Current architecture: `docs/architecture.md`; decisions: `docs/decisions/`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make purchased Deadlock items advance the adaptive build in both Overwolf surfaces.

**Architecture:** Resolve current asset-field defaults through a shared pure catalog-semantics helper used by import and runtime compilation. Rebase the published plan against the freshest decision state, then harden GEP identity normalization for zero Steam IDs and match transitions.

**Tech Stack:** TypeScript, NestJS, TypeORM, Jest, Yarn workspaces, GitHub Actions, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-09-03-inventory-build-progression-design.md`

## Global Constraints

- Do not mutate existing production catalog rows.
- Overlay must omit `OWNED`; desktop must retain `OWNED`.
- Candidate generation continues to use the strict item graph.
- Every behavior change starts with a failing regression test.

---

### Task 1: Restore current asset semantics

**Files:**
- Create: `apps/api/src/deadlock-live/recommendation-catalog-asset-semantics.ts`
- Modify: `apps/api/src/deadlock-live/recommendation-catalog-content-v1.service.ts`
- Modify: `apps/api/src/statlocker-adaptive/adaptive-decision-state-v1.service.ts`
- Test: `apps/api/test/catalog-content.spec.ts`
- Test: `apps/api/test/adaptive-decision-state-v1.spec.ts`

**Interfaces:**
- Produces: `resolveRecommendationCatalogAssetSemantics(input)` returning resolved `itemType`, `activationType`, `shopable`, `disabled`, `active`, and `isActiveItem`.
- Consumes: stored row fields plus the original `rawPayload`.

- [ ] **Step 1: Write failing import and runtime tests**

```ts
expect(saved).toMatchObject({ itemType: 'upgrade', activationType: 'passive', disabled: false, active: true });
expect([...result.state.inventory.heldByItemId.keys()]).toEqual([1]);
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `yarn workspace @deadlock-live-probe/api test catalog-content.spec.ts adaptive-decision-state-v1.spec.ts`

Expected: imported fields remain undefined and the runtime drops the owned item.

- [ ] **Step 3: Implement shared semantics and use it on both paths**

```ts
const disabled = input.disabled ?? rawBoolean(raw, 'disabled') ?? false;
const active = input.active ?? rawBoolean(raw, 'active') ?? !disabled;
```

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `yarn workspace @deadlock-live-probe/api test catalog-content.spec.ts adaptive-decision-state-v1.spec.ts`

Expected: both suites pass.

### Task 2: Publish the plan against fresh inventory

**Files:**
- Modify: `apps/api/src/statlocker-adaptive/adaptive-recommendation-v1.service.ts`
- Test: `apps/api/test/adaptive-recommendation-v1.spec.ts`

**Interfaces:**
- Consumes: `fresh.state.inventory.heldByItemId` from the existing second state read.
- Produces: final `recommendedBuild` and `nextTargetItemId` rebased to the fresh inventory.

- [ ] **Step 1: Write the purchase-race regression test**

```ts
const result = await service.recommend(request);
expect(result.recommendedBuild).toEqual([
  expect.objectContaining({ itemId: 1, status: 'OWNED' }),
  expect.objectContaining({ itemId: 2, status: 'NEXT' }),
]);
expect(result.nextTargetItemId).toBe(2);
```

- [ ] **Step 2: Run the test and verify RED**

Run: `yarn workspace @deadlock-live-probe/api test adaptive-recommendation-v1.spec.ts`

Expected: item 1 remains `NEXT`.

- [ ] **Step 3: Rebase the planned result before legality selection**

```ts
const freshBuild = rebasePlanAgainstOwnedInventory(
  planned.recommendedBuild,
  [...fresh.state.inventory.heldByItemId.keys()],
);
```

- [ ] **Step 4: Run the test and verify GREEN**

Run: `yarn workspace @deadlock-live-probe/api test adaptive-recommendation-v1.spec.ts`

Expected: the purchased item becomes `OWNED` and the target advances.

### Task 3: Harden GEP player binding

**Files:**
- Modify: `apps/api/src/deadlock-live/live-inventory-event-normalizer.service.ts`
- Modify: `apps/api/src/deadlock-live/live-match-state.service.ts`
- Test: `apps/api/test/live-inventory-event-normalizer.service.spec.ts`
- Test: `apps/api/test/live-match-state-local-player.spec.ts`

**Interfaces:**
- Consumes: inventory payloads whose direct Steam ID is empty or `"0"`.
- Produces: normalized local Steam ID resolved by slot/name, with no identity leakage across matches.

- [ ] **Step 1: Write failing zero-ID and match-transition tests**

```ts
expect(normalized.events[0].payload).toMatchObject({ steam_id: localSteamId });
expect(nextMatch.playersBySteamId[oldSteamId]).toBeUndefined();
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `yarn workspace @deadlock-live-probe/api test live-inventory-event-normalizer.service.spec.ts live-match-state-local-player.spec.ts`

Expected: `"0"` blocks fallback or the old identity leaks.

- [ ] **Step 3: Reject zero as a direct inventory identity and clear caches on match change**

```ts
const directSteamId = rawSteamId && rawSteamId !== '0' ? rawSteamId : undefined;
this.localSteamIdByClientId.delete(clientId);
this.clientLocalSteamIds.delete(clientId);
```

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `yarn workspace @deadlock-live-probe/api test live-inventory-event-normalizer.service.spec.ts live-match-state-local-player.spec.ts`

Expected: both suites pass.

### Task 4: Verify, integrate, and deploy

**Files:**
- Verify: all modified API and Overwolf files.

**Interfaces:**
- Produces: a deployable commit whose production response matches live inventory.

- [ ] **Step 1: Run focused backend and client tests**

Run: `yarn workspace @deadlock-live-probe/api test adaptive-decision-state-v1.spec.ts adaptive-recommendation-v1.spec.ts live-inventory-event-normalizer.service.spec.ts live-match-state-local-player.spec.ts catalog-content.spec.ts`

Run: `yarn workspace @deadlock-live-probe/overwolf-client test ui.spec.ts adaptive-recommendation-client.spec.ts overwolf/live-event-buffer-inventory-refresh.spec.ts`

- [ ] **Step 2: Run build and diff checks**

Run: `yarn workspace @deadlock-live-probe/api build`

Run: `git diff --check`

- [ ] **Step 3: Commit the implementation**

```bash
git add apps/api/src apps/api/test docs/superpowers
git commit -m "fix: advance adaptive build after item purchases"
```

- [ ] **Step 4: Integrate and push main**

```bash
git checkout main
git merge --ff-only fix/inventory-build-progression
git push origin main
```

- [ ] **Step 5: Verify production**

Check `/deadlock/live/matches/103332534/state` and `/deadlock/adaptive/v1/recommend`; matching held IDs must be `OWNED`, and the first non-owned plan item must be `NEXT`.

### Task 5: Keep fresh actions and alternatives internally consistent

**Files:**
- Modify: `apps/api/src/statlocker-adaptive/adaptive-recommendation-v1.service.ts`
- Test: `apps/api/test/adaptive-recommendation-v1.spec.ts`
- Test: `apps/overwolf-client/src/adaptive-recommendation-presentation.spec.ts`

**Interfaces:**
- Consumes: the fresh feasible-candidate map and the rebased build produced by Task 2.
- Produces: a `nextAction` whose target-specific key matches its target, plus alternatives that cannot expose freshly owned items.

- [ ] **Step 1: Write failing wrapper-key and stale-alternative tests**

```ts
expect(result.nextAction).toMatchObject({ actionKey: 'WAIT_SAVE:2', targetItemId: 2 });
expect(result.rankedImmediateCandidates.some(({ action }) => action.targetItemId === 1)).toBe(false);
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `yarn workspace @deadlock-live-probe/api test adaptive-recommendation-v1.spec.ts`

Run: `yarn workspace @deadlock-live-probe/overwolf-client test adaptive-recommendation-presentation.spec.ts`

Expected: a semantic `HOLD`/`CONTINUE_CORE` retains `WAIT_SAVE:1`, or the stale owned alternative remains visible.

- [ ] **Step 3: Reconcile action identity and ranked candidates with fresh feasibility**

```ts
const freshRanked = planned.rankedImmediateCandidates.filter(({ action }) =>
  feasibleByActionKey.has(action.actionKey),
);
```

Select a fresh targeted wait only when its canonical key exists; otherwise preserve the generic `WAIT_SAVE` candidate without an encoded target. Publish the fresh feasible ranked subset.

- [ ] **Step 4: Run focused tests and API build for GREEN**

Run: `yarn workspace @deadlock-live-probe/api test adaptive-recommendation-v1.spec.ts`

Run: `yarn workspace @deadlock-live-probe/overwolf-client test adaptive-recommendation-presentation.spec.ts`

Run: `yarn workspace @deadlock-live-probe/api build`

Expected: all commands pass and action identity agrees with the fresh target.
