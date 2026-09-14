# ADR-004: Immutable per-match archetype lock

## Status

Accepted

## Date

2026-09-10

## Context

The threat-weighted WPA design (2026-09-09) established that skeleton/consensus ("what build archetype makes sense for this hero?") and matchup/live adaptation ("which version of that structure is best against these exact six enemies right now?") are different questions answered from different evidence families. If archetype selection can react to live performance signals, recommendations oscillate as souls/KDA/levels fluctuate, and the HUD becomes a union of branches instead of one coherent build.

## Decision

- Normal selection waits for the **full enemy roster** before choosing an archetype.
- Initial archetype selection uses `VS_HERO_WPA` against the full enemy roster. At selection time, live-performance signals (KDA, souls, damage, level) are **not** used.
- One archetype is selected once per match and **locked** until the match ends.
- After lock, live signals may change item order, `CHOICE` decisions, situational additions, `SELL`/`REPLACE` decisions, and the projected full plan — but never the archetype.
- Archetype snapshots and match locks are persisted; every decision exposes a structured decision trace.

## Alternatives Considered

### Continuous re-selection with hysteresis

- Pros: adapts to the match "as it really is".
- Cons: hysteresis damping on a wrong archetype still serves the wrong structure; oscillation is reduced, not eliminated, and each switch invalidates committed investment reasoning.
- Rejected: the lock gives stability by construction instead of by damping.

### Score items individually and sort by raw WPA

- Pros: simple.
- Cons: produces an incoherent union of branches; ignores synergy, upgrade continuity, timing, economy, and slots.
- Rejected: selection is whole-build utility (per the 2026-09-09 design), never per-item sorting.

## Consequences

- Matchup intelligence lives inside the fixed skeleton: situational/outside-archetype items are discovered from the wider legal item universe only when they are materially and credibly better and do not destroy build coherence.
- Enemy threat weighting derives from several live signals (souls share, damage, kills/assists, deaths, level); missing metrics degrade to neutral weighting instead of invented confidence.
- A wrong early archetype choice lasts the whole match — archetype-selection quality gates (ADR-003 publication gates) are the compensating control.
