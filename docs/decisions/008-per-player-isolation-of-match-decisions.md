# ADR-008: Per-player isolation of match decisions

## Status

Accepted

## Date

2026-09-14

## Context

ADR-004 established one immutable archetype lock per match, and the decision trace store was built with the same key. Both were keyed by `matchId` alone.

That assumption breaks as soon as two players using the app are in the same match — the normal case, not an edge case:

- `build_archetype_match_locks_v2` has `PRIMARY KEY ("matchId")`. The second player's request finds the first player's lock, fails the hero check in `AdaptiveRecommendationV2Service.reuseLock`, and returns `ready:false` with `LOCKED_ARCHETYPE_HERO_MISMATCH`. The second player never receives a build.
- `BuildDebugTraceStoreV2Service` is keyed by `matchId` for both stored revisions and SSE streams. Two players' traces overwrite each other, and hysteresis (`previousPlan`) is read from the shared slot, so one player's plan search can be suppressed by the other player's plan.

Per-player data (live state, inventory, souls, item graph, evidence) was already correct; only the two match-scoped keys were not.

## Decision

Every decision-scoped key becomes `(matchId, steamId)`:

- `build_archetype_match_locks_v2` — primary key `("matchId", "steamId")`.
- `BuildDebugTraceStoreV2Service` — internal key `matchId|steamId`; `BuildDecisionTraceV2` carries `steamId`; revisions increase per player.
- `AdaptiveRecommendationV2Service` — session and trace access use the resolved `decision.localSteamId`, never the raw request body.
- Debug endpoints under `/debug/build-v2` take the player dimension.

The lock stays immutable per player for the duration of a match; only its scope changes. ADR-004 remains in force for everything else (selection waits for the full enemy roster, live-performance signals do not influence selection, one lock per player per match).

## Alternatives Considered

### Key the lock by `(matchId, heroId)`

- Pros: two players on the same hero would share a lock, marginally fewer rows.
- Cons: the lock is a decision for a player's match context, not a per-hero cache; a shared row for two players reintroduces coupling (for example, `lockedGameTimeS` and `degradedReasons` would belong to whichever player locked first).
- Rejected: the requirement is explicitly per player.

### Keep `matchId` and store the second player's lock elsewhere

- Pros: no primary key change.
- Cons: two code paths for the same concept, and the trace store problem stays.
- Rejected: solves neither problem cleanly.

### Rekey the trace store but keep the lock per match

- Pros: fixes hysteresis only.
- Cons: the second player still gets `ready:false` and no build, so the primary defect remains.
- Rejected.

## Consequences

- Two or more players in one match each get their own archetype, build plan and trace.
- Hysteresis stops borrowing another player's plan in multi-player matches; behaviour changes for those matches, intentionally.
- Existing lock rows cannot be attributed to a player after the fact; the migration deletes them. Locks only matter within an active match, so the loss is limited to a single archetype re-selection if a match is live during the deploy.
- Downstream consumers of the trace store (the build debugger) must pass a `steamId`. The debugger's client is updated in this same change to address the match list, the trace fetch and the SSE stream by `(matchId, steamId)`, so two players in one match are distinguishable and the selected player survives stream reconnects.
- Per-player build history (`adaptive_build_iterations_v1`) can now be keyed consistently; see the 2026-09-14 design.
