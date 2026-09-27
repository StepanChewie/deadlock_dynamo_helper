# Situational Items Mode Design

## Status

Direction agreed with the owner on 2026-09-27. **Not implemented.** The owner has
approved the approach described here; implementation starts only after this
document has been reviewed.

## Goal

A second recommendation mode for players who already know what they want to
build. The existing mode answers "what should I buy next, in order"; this one
answers a narrower and different question:

> You build what you like. Here are the five items that are best against *this*
> enemy team, and here is who each one is for.

Core items are deliberately absent from the answer — a player who knows his build
already buys them, and showing them adds nothing.

## Why this is cheap to build

The evidence for situational judgement already exists, and the hard part is
already computed and then thrown away.

- `statlocker_vs_hero_wpa_rows_v1` is **item × enemy-hero**, not hero-vs-hero:
  one row per `(heroId, itemId, enemyHeroId)` with `deltaWpa` and `count`
  (`apps/api/src/deadlock-live/entities/statlocker-vs-hero-wpa-row-v1.entity.ts:30`).
- `ThreatWeightedMatchupV1Service.scoreItem()` already turns that into a
  per-enemy breakdown — `contributions[]`, one entry per enemy with
  `rawDeltaWpa`, `count`, `sampleConfidence`, `weightedContribution`
  (`apps/api/src/statlocker-adaptive/threat-weighted-matchup-v1.service.ts:45`).
- The current HTTP response **discards it**: `evidenceSummary()` emits only a
  row count (`adaptive-recommendation-v2.service.ts:575`).

So the feature is mostly a new read path over data the system already has, plus
a presentation surface.

## Scope

### In scope

- A new endpoint, `POST /deadlock/adaptive/v2/situational`.
- A new service that selects up to five non-core items ranked purely by
  matchup-against-the-enemy-team, each with its top two or three enemy heroes.
- A mode switch in the Overwolf client, a new panel, and a dedicated 30-second
  poll for the new endpoint.
- Tests, including one that pins the existing recommendation response as
  unchanged.

### Out of scope

- **Any change to `POST /deadlock/adaptive/v2/recommend`** — request, response or
  behaviour. That contract is currently with Overwolf for review.
- Changes to planner, scoring, transaction legality, or recommendation ordering
  in the existing mode.
- Affordability filtering (souls, timing) or slot filtering. See "Decisions".
- Overwolf resubmission. Shipping this in the client is a separate decision with
  its own review cycle.
- Data retention or cleanup work.

## Decisions taken

Each of these was decided by the owner during design, and the reasoning is
recorded because several are counter-intuitive.

| Question | Decision |
|---|---|
| Where does it live? | A **new endpoint**. The existing one is untouched. |
| What is a "core" item? | Whatever the existing flow already calls core: `role === 'CORE'` on the archetype snapshot, which `roleForTier()` derives straight from statlocker's own `frequencyTier` (`build-archetype-compiler-v2.service.ts:828`). Not a new definition. |
| Ranked by what? | **Pure matchup.** `ThreatWeightedMatchupV1Service.scoreItem().normalized`. Not `baseWpa`, and not the `structure` / `progression` / `transition` layers. |
| Candidate pool? | The **whole shopable catalog**, minus core items, minus what the player already owns. |
| Affordability filter? | **None.** An item costing 6400 is shown at minute 3 if the evidence supports it. |
| How many enemies per item? | **Two or three**, with magnitudes. |
| How is it polled? | A **dedicated 30-second timer** in the client. |
| What is reused? | Both the old flow's selection machinery and its row rendering. |

### Why pure matchup, and not the full utility formula

`BuildItemUtilityV2Service` computes `utility.total` as a weighted sum of four
layers: `structure` (fit with the archetype), `matchup` (vs-hero plus the item's
general WPA on the hero), `progression` (T4 synergies) and `transition`
(replacement cost) — `build-item-utility-v2.service.ts:98`.

Two of those layers actively work against this feature. `structure` rewards
items *because* they are core, and the requirement is to exclude core items.
Ranking by `utility.total` would therefore surface "the least bad core items"
rather than the best situational ones. And `transition` measures the cost of
replacing something in a prescribed build — there is no prescribed build in this
mode. `baseWpa` was also rejected explicitly: an item must earn its place by
being good *against these enemies*, not by being generally strong on the hero.

### Two places where the agreed answers pull apart

Both are resolved here rather than silently.

**1. "Reuse the old flow's selection" vs "the whole catalog".**
`MatchupCandidateDiscoveryV2Service.discover()` only considers items that are
*outside the archetype* (`matchup-candidate-discovery-v2.service.ts:60`). Items
the archetype carries with role `SITUATIONAL` or `FLEX` would therefore never
appear, although the pool decision says they must. **Resolution:** reuse the
service's gates and its matchup-driven mechanics, but widen its candidate set to
the whole catalog.

**2. "Reuse the old flow's selection" vs "pure matchup ordering".**
`discover()` sorts its output by `utility.total`, i.e. by all four layers
(`matchup-candidate-discovery-v2.service.ts:141`). **Resolution:** keep its
gates, replace its ordering with `normalized`.

`resolveOutsideCompetition()` is **not** reused
(`family-first-full-build-resolver-v2.service.ts:348`). It competes outside
candidates against `OPTIONAL`/`SITUATIONAL` families for adaptive capacity
inside a prescribed build. This mode has no prescribed build — the build is the
player's own — so there is no capacity to compete for.

## Contract

### Request

```
POST /deadlock/adaptive/v2/situational
{ "matchId": string, "localSteamId"?: string }
```

Identical body to the existing endpoint. Validation follows the same rules as
`validateRequest` in `adaptive-recommendation-v2.service.ts:654`.

A separate controller owns the route, so the file that serves the reviewed
client is not edited at all.

### Response

```ts
interface AdaptiveSituationalResultV2 {
  mode: 'situational';
  ready: boolean;
  blockers: readonly string[];
  decisionId: string;
  stateRevision: string;
  heroId?: number;
  lock?: AdaptiveArchetypeLockSummaryV2;              // reused verbatim
  situationalItems: readonly AdaptiveSituationalItemV2[];
  degradedReasons: readonly string[];
}

interface AdaptiveSituationalItemV2 {
  itemId: number;
  score: number;          // scoreItem().normalized, the ranking key
  confidence: number;
  coverage: number;
  against: readonly AdaptiveSituationalTargetV2[];   // top 2-3
  reasonCodes: readonly string[];
}

interface AdaptiveSituationalTargetV2 {
  enemyHeroId: number;
  deltaWpa: number;        // rawDeltaWpa, the magnitude shown to the player
  count: number;           // sample size behind that number
}
```

`mode` is present so the client can narrow the two response types without
guessing. Item names, icons and hero names are resolved **client-side**, exactly
as today (`presentItem()`, `getAdaptiveHeroDisplayName()`); the server keeps
sending ids only.

`lock` is the same `AdaptiveArchetypeLockSummaryV2` the existing response
carries, so the client can keep using the enemy-roster and degraded-reason
plumbing it already has.

## Selection algorithm

1. **Resolve the lock.** The same step the full path performs — decision state,
   then lock create-or-reuse. The archetype is needed twice over: it defines
   "core" for the exclusion, and it carries `enemyHeroIds`. See "Shared state".
2. **Resolve the enemy roster.** If it is not six distinct valid hero ids, stop
   with `ready: false` and the existing blocker semantics.
3. **Build the candidate pool.** Every item in the recommendation item catalog
   that is shopable, not disabled, not owned by the player, and not carried by
   the archetype with `role === 'CORE'`.
4. **Score each candidate** with
   `ThreatWeightedMatchupV1Service.scoreItem({ ourHeroId, itemId, enemyHeroIds,
   rows, enemyThreats })`. Only `normalized` is used as the ranking key.
5. **Gate.** Apply the thresholds the existing flow already applies in
   `discover()`, taken from the same config object —
   `STATLOCKER_BUILD_V2_CONFIG.outsideMatchupDiscovery`
   (`statlocker-build-v2.config.ts:210`), whose current values are
   `minCoverage: 0.30`, `minConfidence: 0.35` and `minNormalizedSupport: 0`:

   ```
   matchup.coverage   < config.minCoverage            -> reject
   matchup.confidence < config.minConfidence          -> reject
   matchup.normalized <= config.minNormalizedSupport  -> reject
   ```

   `replacementMinConfidence` (0.40) is not used: it applies to candidates that
   replace an owned item, and this mode does not reason about replacements.
   **No new threshold constants are introduced** — the gate is the existing one.
   `minNormalizedSupport` being `0` is what enforces "the item must help against
   them", which is the property this mode is built on.
6. **Order** by `normalized` descending, tie-broken by `confidence`, then
   `coverage`, then `itemId` for determinism.
7. **Take up to five.**
8. **Attach enemies.** For each selected item, take the two or three entries of
   `contributions[]` with the highest `weightedContribution`, keeping only
   positive contributions, and emit them as `against`.

No backfill logic is needed: the pool is re-derived in full on every request, so
once a purchased item leaves the pool the list closes up by itself.

## Shared state, and the one refactor of existing code

The lock step currently lives inside `AdaptiveRecommendationV2Service.recommend()`
(`adaptive-recommendation-v2.service.ts:88`). Both modes must go through the same
`AdaptiveDecisionStateV1Service` and produce the same lock for the same match —
otherwise the two modes could disagree about the enemy team or the archetype.

**The refactor:** extract the lock step into a shared private method, or into a
small collaborator both services call. This is the only change to existing
behaviour-bearing code in this design, and it is the main risk surface.

It is covered: `apps/api/test/adaptive-recommendation-v2-lock-lifecycle.spec.ts`
already pins the lock's lifecycle, so a behaviour change here fails the suite
rather than reaching production. That test is the reason this refactor is
acceptable at all.

## Degraded behaviour

| Situation | Response |
|---|---|
| Enemy roster incomplete or not six valid heroes | `ready: false`, existing blocker code |
| `selectionMode === 'OFFLINE_DEFAULT'` (no `VS_HERO_WPA`) | `ready: false`, blocker — the whole feature is matchup evidence, so without it the answer is meaningless |
| Fewer than five items pass the gate | Return however many pass. Do not pad to five. |
| No item passes the gate | `ready: false` with a blocker, rather than an empty list rendered as "here are your options" |

## Client

### Mode switch

A two-state control in the desktop top bar (`.topbar-actions`,
`desktop.html:854`) rather than in Settings, because it is switched while
playing. It follows the existing preference control pattern exactly:
`#setting-overlay-auto-show` (`desktop.html:892`) plus a `mainWindow.setX`
handler in `index.ts` and a new key in `PREFERENCE_KEYS`
(`src/player-preferences.ts:50`), so the choice survives a restart.

The switch selects **which loop is active**, not both at once: either the
existing event-driven recommendation loop, or the new 30-second situational
loop. Polling both would double the request load to answer a question the player
is not currently asking.

### Polling

A dedicated `setInterval` of 30 seconds for the situational request, independent
of GEP events. Accepted consequence, recorded so it is not rediscovered as a bug:
**a purchased item stays in the list for up to 30 seconds.** The inventory event
that the existing loop already forces a refresh on
(`index.ts:311`, `forceLiveBuildRecommendationRefresh`) is available and would
make this immediate; wiring it is a one-line follow-up if the delay turns out to
matter.

### Panel

A new panel inside the build workspace, hidden by default. It reuses the
existing row rendering — `renderPurchaseRoute()` / `createPurchaseRow()`
(`ui.ts:431`) — so a row looks identical to the existing mode, with the item
card, name and price the player already knows. The "against whom" annotation is
built the same way as the existing `presentAgainst()`
(`adaptive-recommendation-presentation.ts:394`), which already turns enemy hero
ids into a `"vs X, Y"` label.

### Traps this must respect

- **`display: flex` outranks the user-agent `[hidden]` rule.** The new panel must
  restate `.panel[hidden] { display: none; }` alongside the existing override at
  `desktop.html:451`. Without it the switch looks broken and nothing errors.
- **The surface-contract test is a hard gate.** A new panel must be added to the
  hardcoded arrays in `player-surface-contract.spec.ts` — the `[hidden]`
  restatement list (`:74`) and the unique-rendering-target id list (`:99`) — and
  any new markup handler must be assigned as `mainWindow.<name> =` in `index.ts`
  or the handler sweep (`:60`) fails. `ui.spec.ts` keeps a DOM element
  allow-list that also needs the new ids.

## Testing

- **Ranking, as a pure unit test.** Core exclusion, owned exclusion, the gate,
  ordering, and the `against` selection. Hand-built rows and no mocks, matching
  the style of `apps/api/test/threat-weighted-matchup-v1.spec.ts`.
- **The safety test for the frozen contract:** with the new endpoint absent from
  the picture, the existing `/v2/recommend` response is unchanged. This is the
  assertion that protects the build currently under Overwolf review.
- **Contract test** for the situational response shape and the `mode`
  discriminator.
- **Lock sharing:** both modes resolve the same lock for the same match.
- **Client:** extend `player-surface-contract.spec.ts` and `ui.spec.ts`.
- **Mutation-test the new gate** — raise `minNormalizedSupport` above the score
  of a fixture item and confirm the intended test goes red — per the repository
  convention.

## Risks and open questions

- **Tier-1 components in the output.** The pool is the whole catalog with no tier
  filter, so an ingredient could in principle reach the top five. The
  `coverage` / `confidence` gate should exclude most of them — components rarely
  have a large sample against one specific enemy — but it does not guarantee it.
  **Decision: ship without a tier filter and look at real output.** If junk
  appears, excluding ingredients is a one-line change.
- **The lock refactor** is the only edit to code the existing modes depend on.
  Covered by the existing lock-lifecycle suite, but it deserves the review
  attention.
- **Two modes, one archetype.** Because both modes share the lock, switching
  modes mid-match does not re-select the archetype. That is intentional —
  "core" must mean the same thing in both — but it means a mid-match switch does
  not re-evaluate against a possibly different archetype.
- **Overwolf resubmission** is not addressed here and is a separate decision.

## File map

New:

- `apps/api/src/statlocker-adaptive/adaptive-situational-v2.controller.ts`
- `apps/api/src/statlocker-adaptive/adaptive-situational-v2.service.ts`
- `packages/shared/src/adaptive-situational-v2.ts` (the response types)
- tests: ranking unit, controller contract, lock sharing
- client: panel markup in `desktop.html` and `in_game.html`, render function in
  `ui.ts`, mode preference, the 30-second loop

Touched:

- `adaptive-recommendation-v2.service.ts` — the lock-step extraction only
- `player-preferences.ts` — one new preference key
- `index.ts` — the mode handler and the situational loop
- `player-surface-contract.spec.ts`, `ui.spec.ts` — new panel and handler
