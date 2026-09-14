# ADR-003: Statlocker-only build evidence and profile-level archetypes

## Status

Accepted

## Date

2026-09-10

## Context

The V1 compilation model aligned variable-length, variable-order pro build data by ordinal transaction position. Support was diluted across positions, valid milestones were discarded, and survivors could be duplicated across positions or branch/soft goals. The real "Billy" production case produced only seven unique recommended items from much richer upstream evidence.

Design authority: `docs/superpowers/specs/2026-09-10-statlocker-build-strategy-v2-design.md` (continued by ADR-005, ADR-006).

## Decision

- Build evidence comes from **Statlocker only**: top 10 accounts from `HERO_LEADERBOARD` → `PRO_BUILD_ANALYSIS` per hero.
- Build archetypes are mined at **profile level** (semantic items/families/progressions), not by aligning purchase positions.
- Publish multiple archetypes only when the top-10 profiles show strong, coherent structural separation; otherwise publish one consensus archetype.
- The Deadlock API is not a build source. Raw historical match trajectories (ours or anyone's) are not an authoritative build source. Live match state is used only for runtime adaptation inside a locked strategy.
- There is no V1 shadow phase: V2 is validated offline (deterministic real-Billy fixture), then cut over directly. Broken V1 positional strategy is never a production fallback.

## Alternatives Considered

### Fix V1 positional compilation

- Pros: keeps the existing serving path.
- Cons: positional alignment is the root cause; support dilution cannot be patched away.
- Rejected.

### Use the Deadlock API as an additional build source

- Pros: more data volume.
- Cons: inconsistent evidence semantics; violates the single-authority model.
- Rejected: Statlocker is the sole build authority (ADR-006 defines what mechanics validation may add).

## Consequences

- An immutable, schema-validated strategy artifact is compiled offline and published per `(heroId, rulesetId, catalogSha256)`; runtime never mines archetypes from raw matches.
- Archetype snapshots recompile from stored evidence on service bootstrap (2026-09-13 plan: rate-weighted timing + startup recompile), so a code change cannot keep serving a stale snapshot compiled by old code.
- Family purchase timing is weighted by family `purchaseRate`, not a plain median — one low-rate outlier profile can no longer put a situational item first (the Graves/Enchanter's Emblem case).
