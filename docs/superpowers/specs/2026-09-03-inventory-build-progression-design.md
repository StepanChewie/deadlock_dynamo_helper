# Inventory Build Progression Design

> **Historical design record.** At the time of writing this documented the referenced work; parts have since been implemented, refined by the ADRs, or superseded. It is kept for provenance, not as current instructions. Current architecture: `docs/architecture.md`; decisions: `docs/decisions/`.

## Goal

When Deadlock reports a purchased item, the adaptive recommendation must mark it `OWNED`, advance `NEXT`, hide the owned item from the in-game overlay, and retain the owned marker in the normal Overwolf window.

## Confirmed failure

Production match `103332534` contains twelve items for Steam ID `76561198066539144` in both live state and inventory shadow. The recommendation response nevertheless returns those same item IDs as `NEXT` or `PLANNED`.

The latest recommendation catalog has 725 rows, all with `active = null`; 626 also have `disabled = null`. The upstream asset payload omits `active` and often omits `disabled`, while the strict compiler requires resolved availability. Consequently, owned items are absent from the compiled graph and are dropped from the decision inventory.

## Design

1. Normalize current Deadlock asset semantics in one pure helper. Missing `disabled` means `false`; missing `active` means `!disabled`. Accept both legacy and current field names such as `item_type`/`type` and `activation_type`/`activation`.
2. Apply the same helper during future catalog imports and while reading already-imported catalog rows. This fixes production without mutating historical database rows.
3. Rebase the final recommendation plan against the second, freshest decision-state read. This closes the purchase race between initial planning and the existing legality recheck.
4. Treat inventory `steam_id: "0"` as unresolved so slot/name fallback can bind the item event. Clear cached local identity when a client changes matches.
5. Keep UI behavior unchanged: desktop renders all statuses; overlay filters `OWNED`. Existing UI tests already enforce this contract.

## Safety

- No database migration or destructive backfill.
- Candidate legality remains based on the strict compiled graph.
- The runtime only reconstructs semantics already used by the legacy asset importer.
- Deployment verification compares the production recommendation with the known live inventory.
