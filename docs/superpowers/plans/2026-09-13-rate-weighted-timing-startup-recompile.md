# Plan: Rate-weighted archetype timing + startup snapshot recompile

Date: 2026-09-13
Spec: approved in chat (brainstorming). Design authority = this plan.

## Context

Full-build plan ordering sorts families by item `timing.medianBuyTimeS`
(`full-build-transaction-planner-v2.service.ts:302-309,355-358`). The cluster
median is computed in `compileProgressionNode`
(`apps/api/src/statlocker-adaptive/build-archetype-compiler-v2.service.ts:311-327`)
as a plain median over per-profile medians. With a 2-profile cluster this lets
one early-timing, low-purchaseRate player put a situational item first in the
buy list (real case: Graves heroId 76, Enchanter's Emblem 363s vs global crawl
median 735s).

Second pain: archetype snapshots are only recompiled when the cron hero-refresh
decides a hero is due; after a code change the stale snapshot (compiled by old
code) keeps serving until a patch change. User wants recompilation on every
service restart.

## Global Constraints

- No new dependencies. No network calls in the startup recompile path — it
  must work with the StatLocker evidence already in the DB store.
- Startup recompile must not block application bootstrap and must not crash
  the app on errors (log + continue).
- Behavior back-compat: profiles with equal purchaseRate must produce the same
  ordering the old plain median produced (weighted median degenerates to
  median when weights are equal).
- Tests: jest, `yarn test` inside `apps/api` (testRegex `test/.*\.spec\.ts$`).
- Keep diffs minimal; follow existing code style (no new abstractions).

## Task 1: Rate-weighted timing median in the archetype compiler

File: `apps/api/src/statlocker-adaptive/build-archetype-compiler-v2.service.ts`
(`compileProgressionNode`, ~line 311).

Current code takes `median(times)` over per-profile `medianBuyTimeS` values.
Replace with a purchaseRate-weighted median:

- Weight of each profile = its `purchaseRate` for that item
  (`StatlockerBuildProfileItemV2.purchaseRate`).
- Weighted median definition: sort observations by time ascending; walk
  cumulative weight; the weighted median is the first time where cumulative
  weight >= total weight / 2.
- If total weight is 0 (or non-finite), fall back to the existing plain
  median so the node compiles instead of throwing.
- `spreadS` stays as-is in shape: median of absolute deviations from the new
  timing median (same formula, no weighting).
- Back-compat: with all-equal weights the result must equal the old plain
  median.

Tests: `apps/api/test/build-archetype-compiler-v2.spec.ts` — add cases:

1. Two profiles, different rates: early-timing profile has small rate, later
   profile bigger rate → resulting node `timing.medianBuyTimeS` equals the
   later profile's time (weighted median moved past it).
2. Two profiles with equal rates → weighted median equals plain median of the
   two times (back-compat).
3. Purchase rates summing to 0 → falls back to plain median, no throw.

Use the same fixture builders the existing spec uses for
`StatlockerBuildProfileItemV2` (read the spec for the existing helper shape;
reuse, don't reinvent). Run the compiler spec file, then the full
`yarn test` for the statlocker-adaptive related specs if the harness allows;
at minimum the touched spec must pass.

## Task 2: Startup archetype recompile on service bootstrap

File: `apps/api/src/statlocker-adaptive/statlocker-refresh.service.ts`.

Add a NestJS `onApplicationBootstrap` hook that kicks a fire-and-forget
background job:

- Must not block or reject unhandled: wrap everything, catch and log
  (`Logger`-style consistent with the file).
- Resolve identity the same way `bootstrapIdentity()` does (rulesetVersion +
  catalogSha256 from the latest catalog version). If identity unavailable →
  skip silently (cron will handle later).
- Resolve current `statlockerPatchId` from the store the same way
  `isHeroDue` derives `currentV2PatchId` (prefer WPA_PATCH_DATA/T4_CHAINS
  rows, else latest HERO_LEADERBOARD row). If none → skip (nothing stored
  yet).
- For each heroId in `STATLOCKER_HERO_IDS_V1`, sequentially (no parallel
  fan-out) call `this.archetypeRefreshV2?.refreshHero(heroId, { rulesetVersion,
  catalogSha256, statlockerPatchId })`, swallowing and logging per-hero errors
  and continuing with the next hero.
- No network: do NOT call the collector. Pure recompile from stored evidence.
- Guard against overlapping with itself (a boolean in-flight flag is enough).

Tests: `apps/api/test/statlocker-refresh-v1.spec.ts` (or a sibling spec file
matching existing naming) — add cases:

1. With identity + stored patch id present, bootstrap triggers refreshHero
   for every pool hero, sequentially, with the resolved identity.
2. One hero's refreshHero rejects → other heroes still refreshed.
3. No identity (no catalog version) → refreshHero never called, no unhandled
   rejection.
4. In-flight guard: calling bootstrap twice while running does not start two
   loops.

Reuse the existing spec's mocking helpers for the store/repos (read the spec
first; follow its established patterns).

## Completion criteria

- Both tasks implemented, specs pass.
- After deploy + restart: all pool heroes' V2 archetypes recompiled from
  stored evidence; Graves' snapshot rebuilt with weighted timing.
