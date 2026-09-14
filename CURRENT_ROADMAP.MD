# Roadmap: Fix Item Deduplication in UI & Upgrade Lineage Continuity

## 1. Executive Summary & Root Cause Analysis

### Issue 1: Items Duplicated 2-3 Times in UI
* **Observed in UI**: Items like *Dispel Magic*, *Mystic Expansion*, *Point Blank* appear 2-3 consecutive times as separate cards (e.g., Step 32: Dispel Magic [WAIT FOR FLEX], Step 33: Dispel Magic [WAIT FOR GOLD], Step 34: Dispel Magic [BUY]).
* **Root Cause**: In `apps/overwolf-client/src/ui.ts` and `apps/overwolf-client/src/adaptive-recommendation-presentation.ts`, when `view.plan.isTransactionPlan` is enabled, the UI maps every raw step in `planSession.steps` into a standalone item card. Because the planner breaks down each transaction into prerequisite barriers (`WAIT_FOR_FLEX`, `WAIT_FOR_GOLD`) followed by the actual `TRANSACTION` step, one single planned item produces multiple cards.
* **Solution**: Aggregate and present each planned item once in the build sequence. Integrate barriers into the item card as requirement badges/chips (e.g., `[Wait for Flex]`, `[Save 3,200 Souls]`, `[Sell X]`) rather than rendering individual barriers as separate cards.

---

### Issue 2: Upgrade Ignored & Contradictory Sells (*Close Quarters* vs *Point Blank*)
* **Observed in Plan**: *Point Blank* (which builds from *Close Quarters*) is compiled as `REPLACE` selling *Slowing Bullets*, while *Close Quarters* remains in inventory and is later recommended to be sold for *Escalating Resilience*.
* **Root Cause**:
  1. In `packages/deadlock-build-domain/src/recommendation-ruleset-catalog.ts`, `compileStrictRecommendationCatalogV1()` strips out `upgradeRecipes` if `recipe.soulsCost` has no verified mechanics enrichment (`!hasValue(recipe.soulsCost)`).
  2. Because `upgradeRecipes` was empty on *Point Blank*, `BuildSlotPlannerV1Service` did not recognize that *Point Blank* upgrades from *Close Quarters*, treated it as a brand-new item requiring a fresh slot, and generated a `REPLACE` selling an unrelated item.
  3. *Close Quarters* was never consumed in the simulated inventory, leading the planner to believe it was still available to be sold downstream for *Escalating Resilience*.
* **Solution**:
  1. In catalog compilation, if `soulsCost` is unverified in enrichment, deterministically derive `soulsCost = Math.max(0, targetItem.cost - componentItem.cost)` when direct purchase costs are known, preserving valid executable `upgradeRecipes`.
  2. In `BuildSlotPlannerV1Service` and `TransactionPlanCompilerV1Service`, reinforce upgrade detection via `itemGraph.isComponentAncestor()`, ensuring upgraded components are consumed immediately and removed from simulated inventory.

---

## 2. Actionable Implementation Plan

### Phase 1: Catalog & Graph Upgrade Recipe Integrity
- [ ] **Task 1.1: Fallback Upgrade Cost Derivation in Catalog Compilation**
  - Update `packages/deadlock-build-domain/src/recommendation-ruleset-catalog.ts` in `buildCatalogItem` / `compileStrictRecommendationCatalogV1` to compute `soulsCost = Math.max(0, directPurchaseCost - componentCost)` when enrichment is absent.
  - Ensure all upgrade recipes (including *Point Blank* from *Close Quarters*, *Tankbuster* from *Mystic Burst*, *Greater Expansion* from *Mystic Expansion*) are preserved in `RecommendationItemDefinition.upgradeRecipes`.
- [ ] **Task 1.2: Domain Unit Tests for Upgrade Lineage & Recipes**
  - Add tests in `packages/deadlock-build-domain/test/recommendation-ruleset-catalog.spec.ts` and `recommendation-candidate-generator.spec.ts` verifying that items with components always retain executable `upgradeRecipes`.

---

### Phase 2: Slot Planner & Transaction Compiler Upgrade Continuity
- [ ] **Task 2.1: Robust Upgrade Detection in `BuildSlotPlannerV1Service`**
  - In `apps/api/src/statlocker-adaptive/build-slot-planner-v1.service.ts`, update `transitionForTarget` to check both `target.upgradeRecipes` and `itemGraph.isComponentAncestor(ownedId, targetItemId)` so an upgrade is never missed.
  - Return `requirement: 'UPGRADE'` with `sourceItemId: componentId`.
- [ ] **Task 2.2: Inventory Consumption in `TransactionPlanCompilerV1Service`**
  - In `apps/api/src/statlocker-adaptive/transaction-plan-compiler-v1.service.ts`, ensure that when an `UPGRADE` step is compiled, the consumed source item is removed from `state.inventory` and replaced by the target item.
  - Verify downstream steps cannot sell an item that was already upgraded/consumed.
- [ ] **Task 2.3: Integration Tests for Full Inventory Upgrades**
  - Add test in `apps/api/test/transaction-plan-full-slot-regression.spec.ts` verifying that with full slots, buying *Point Blank* consumes *Close Quarters* without selling unrelated items and without attempting to sell *Close Quarters* later.

---

### Phase 3: UI Deduplication & Presentation Aggregation
- [ ] **Task 3.1: Aggregate Barriers with Transactions in Presentation Layer**
  - In `apps/overwolf-client/src/adaptive-recommendation-presentation.ts`, transform `planSession.steps` into clean aggregated item rows or present `recommendedBuild` items annotated with their active/locked transaction requirements and barriers.
  - Ensure each planned item appears **exactly once** in the build list.
- [ ] **Task 3.2: Enhance Overwolf UI Item Card Rendering**
  - In `apps/overwolf-client/src/ui.ts` and `adaptive-transaction-plan-presentation.ts`, render the item card with clear sub-badges:
    - Gold requirement: `Save until X Souls`
    - Flex requirement: `Requires Flex Slot`
    - Replace/Sell requirement: `Sell [Item Name] before purchase`
- [ ] **Task 3.3: Overwolf Client Presentation Unit Tests**
  - Update tests in `apps/overwolf-client/src/adaptive-recommendation-presentation.spec.ts` and `adaptive-transaction-plan-presentation.spec.ts` to assert zero duplicated items in presented plan.

---

### Phase 4: Full Validation & Deployment
- [ ] **Task 4.1: Run Full Test Suite**
  - Run all tests across `@deadlock-live-probe/build-domain`, `@deadlock-live-probe/api`, and `@deadlock-live-probe/overwolf-client`.
- [ ] **Task 4.2: Commit & Deploy to VPS**
  - Push changes to `main` branch to trigger GitHub Actions runner on `my-vps`.
- [ ] **Task 4.3: Live Match Verification**
  - Run live test against production container `deadlock_dynamo_helper-api-1` and verify recommendation payload with full slots.
