# Statlocker `VS_HERO_WPA` field semantics

Status date: 2026-09-09

This document records only what is supported by Statlocker documentation or directly observed in the current `VS_HERO_WPA` response contract. It intentionally distinguishes verified product semantics from implementation observations and inference.

## Evidence sources

1. Statlocker Item Meta Model / WPA explanation: https://statlocker.gg/vision/wpa
2. Statlocker WPA analysis UI: https://statlocker.gg/wpa-analysis
3. Statlocker changelog: https://statlocker.gg/changelog
4. Statlocker API documentation: https://statlocker.gg/api
5. Repository regression fixture: `apps/api/test/fixtures/statlocker-vs-hero-wpa-v1.json`
6. Existing live-contract regression: `apps/api/test/statlocker-normalizer-v1.spec.ts`

Statlocker's public API documentation explicitly describes the API as early-state with incomplete coverage/documentation. The public pages explain WPA generally, but do not currently define the internal `VS_HERO_WPA` leaf fields `mean_wpa`, `delta_wpa`, or `_baseline` precisely.

## WPA

**Status: VERIFIED**

Statlocker defines WPA as **Win Probability Added** and describes a WPA of `+3%` as a purchase being associated with a three percentage-point higher chance of winning. Statlocker also states that the model is context-aware and accounts for game state and team compositions rather than using raw item win rate alone.

This establishes the unit/meaning of WPA generally. It does not by itself establish the exact meaning of every field inside the `VS_HERO_WPA` response.

## `mean_wpa`

**Status: INFERRED for matchup-leaf relationship; UNKNOWN as an independent scoring signal**

Observed `VS_HERO_WPA` leaves contain `mean_wpa`. In the captured live-contract regression:

```text
_baseline.mean_wpa = -0.002370
Apollo.mean_wpa    = -0.001782
Apollo.delta_wpa   =  0.000588
```

Numerically:

```text
Apollo.mean_wpa - _baseline.mean_wpa = 0.000588
```

This is consistent with `delta_wpa` representing the matchup leaf's mean WPA relative to the corresponding baseline. That relationship is **INFERRED from observed data**, not VERIFIED by current public Statlocker documentation.

The repository's current nested `VS_HERO_WPA` normalizer intentionally does not copy matchup `mean_wpa` into the normalized matchup item. Therefore current recommendation scoring does not use matchup `mean_wpa` independently.

Whether matchup `mean_wpa` contains information that is safe to score in addition to `delta_wpa` is **UNKNOWN**. Treating both as independent additive utility would risk double counting the same modeled effect.

## `delta_wpa`

**Status: INFERRED**

Observed payloads contain finite `delta_wpa` values on enemy matchup leaves but not on `_baseline`. The observed numeric relation above is consistent with:

```text
delta_wpa ~= matchup.mean_wpa - _baseline.mean_wpa
```

The current application treats `delta_wpa` as the exact-enemy matchup adjustment and count-weights it when collapsing multiple rank buckets.

Statlocker's public WPA explanation verifies the meaning of WPA generally, but current public documentation does not explicitly define the `VS_HERO_WPA.delta_wpa` formula. Therefore the exact formula remains INFERRED rather than VERIFIED.

## `_baseline`

**Status: INFERRED for role; UNKNOWN for exact population/model construction**

`_baseline` is directly observed as a sibling of named enemy heroes under one hero/item/rank bucket. It contains `mean_wpa` and `count`, while named enemy leaves additionally contain `delta_wpa`.

Its position and the observed arithmetic strongly suggest that it is the comparison baseline used to derive matchup deltas. This role is **INFERRED**.

The exact baseline population is **UNKNOWN**. Current public Statlocker documentation does not establish whether it means all opponents in that rank bucket, a model-conditioned counterfactual, an enemy-neutral population, or another aggregation. `_baseline` must therefore not be converted into a fake enemy hero row.

## `count`

**Status: VERIFIED as sample-count data in the response; INFERRED as the correct rank-collapse weight**

Every observed baseline/matchup leaf carries `count`. Statlocker publicly states that larger sample sizes provide more reliable WPA measurements. The changelog also documents sample-size filtering and rank aggregation fixes.

The current application uses matchup `count` as the weight when aggregating the same hero/enemy/item across rank buckets:

```text
aggregateDeltaWpa = sum(delta_wpa_r * count_r) / sum(count_r)
```

That formula is VERIFIED as current application behavior by `statlocker-vs-hero-wpa-roadmap-fixture-v1.spec.ts`. It is not claimed as a publicly documented Statlocker formula, so its equivalence to Statlocker's own all-rank aggregation policy is INFERRED.

## Rank buckets

**Status: VERIFIED as response structure; current collapse behavior VERIFIED locally**

The nested response contains separate rank buckets such as `rank_8` and `rank_9`. Statlocker's changelog confirms that WPA has rank filtering and that aggregation across ranks has received fixes; as of August 2026, WPA defaults to all ranks.

The current normalizer iterates rank buckets and irreversibly count-weights them into one normalized hero/enemy/item value. Task 1.3 replaces that ingest-time collapse with persisted per-rank relational rows so future rank policy does not require re-fetching RAW snapshots.

## Scoring gate

Until Statlocker publishes authoritative semantics or another authoritative source verifies the exact relationship between `mean_wpa`, `delta_wpa`, and `_baseline`:

- persist valid matchup `mean_wpa` for audit/debug/re-normalization;
- display it in debug output when useful;
- score exact-enemy adaptation from `delta_wpa` under the configured confidence/shrink policy;
- do **not** add matchup `mean_wpa` as a second independent utility bonus;
- do **not** represent `_baseline` as an enemy hero;
- retain immutable RAW snapshots so these rules can be revised without re-fetching historical Statlocker responses.
