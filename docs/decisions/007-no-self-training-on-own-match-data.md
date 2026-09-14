# ADR-007: No self-training on own match data

## Status

Accepted

## Date

2026-09-12

## Context

An earlier architecture included an ML model pipeline and a match crawler that collected historical matches for training and sell-policy learning. Besides the operational cost (crawler state, match/player tables, model serving), it created two risks: learning from our own players' match histories (privacy exposure of live-captured personal play data) and policy feedback loops (the system learning from the behavior it recommends). The build-evidence architecture (ADR-003) made the crawler and ML pipeline redundant: build structure comes from Statlocker pro profiles, and mechanics validity comes from the game's own item graph.

## Decision

No training, mining, or sell-policy learning may use:

- our own players' data;
- our own captured match histories;
- local historical build trajectories.

Evidence layers are exactly:

1. **Statlocker `PRO_BUILD_ANALYSIS`** — build and progression evidence (ADR-003);
2. **Statlocker hero-item WPA evidence** — replacement ranking and matchup protection (ADR-006);
3. **Verified game mechanics** (item graph, recipes, prices, capacity) — execution validation only.

Live-captured events from the Overwolf probe are used for state reduction, inventory shadow replay, and decision tracing — never as a training corpus.

## Alternatives Considered

### Keep the ML sell-policy pipeline trained on crawled matches

- Pros: a learned policy could in principle capture effects the rules miss.
- Cons: redundant with Statlocker usefulness evidence, adds a serving artifact, violates the privacy boundary, and risks self-reinforcing policy loops.
- Rejected: pipeline removed (`chore: remove ML model pipeline, legacy v1 serving and dead code`, `chore(db): drop legacy match and crawler tables`).

## Consequences

- Smaller operational surface: no crawler, no model artifacts, no training jobs; legacy match/crawler tables dropped.
- Every scoring component must be traceable to one of the three evidence layers — enforced by the decision trace and offline golden fixtures.
- If a future policy needs learning, this ADR must be superseded first.
