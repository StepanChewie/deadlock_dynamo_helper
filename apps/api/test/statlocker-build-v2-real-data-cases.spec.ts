import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildRecommendationRulesetCatalogV1,
  compileStrictRecommendationCatalogV1,
} from '@deadlock-live-probe/build-domain';
import type { StatlockerBuildV2Fixture } from '../src/scripts/capture-statlocker-build-v2-fixture';
import { resolveRecommendationCatalogAssetSemantics } from '../src/deadlock-live/recommendation-catalog-asset-semantics';
import { BuildArchetypeCompilerV2Service } from '../src/statlocker-adaptive/build-archetype-compiler-v2.service';
import { BuildArchetypeMinerV2Service } from '../src/statlocker-adaptive/build-archetype-miner-v2.service';
import { BuildArchetypeSelectorV2Service } from '../src/statlocker-adaptive/build-archetype-selector-v2.service';
import { BuildArchetypeV2 } from '../src/statlocker-adaptive/build-archetype-v2';
import {
  DesiredBuildStateV2,
  DesiredFamilyStateV2,
} from '../src/statlocker-adaptive/build-desired-state-v2.service';
import { FullBuildMatchupProtectionV1Service } from '../src/statlocker-adaptive/full-build-matchup-protection-v1.service';
import {
  FullBuildReplacementContextV2,
  FullBuildReplacementV2Service,
} from '../src/statlocker-adaptive/full-build-replacement-v2.service';
import { FullBuildSellRankerV1Service } from '../src/statlocker-adaptive/full-build-sell-ranker-v1.service';
import { FullBuildTransactionPlannerV2Service } from '../src/statlocker-adaptive/full-build-transaction-planner-v2.service';
import { FullBuildTransitionValueV2Service } from '../src/statlocker-adaptive/full-build-transition-value-v2.service';
import { BuildItemUtilityV2Service } from '../src/statlocker-adaptive/build-item-utility-v2.service';
import { simulateFullBuildInventoryV2 } from '../src/statlocker-adaptive/full-build-inventory-simulator-v2';
import { toStatlockerBuildProfileV2 } from '../src/statlocker-adaptive/statlocker-build-profile-v2';
import { ThreatWeightedMatchupV1Service } from '../src/statlocker-adaptive/threat-weighted-matchup-v1.service';
import { StatlockerHeroItemLifecycleV1 } from '../src/statlocker-adaptive/statlocker-adaptive.types';
import { StatlockerVsHeroWpaAggregateSourceV1 } from '../src/statlocker-adaptive/statlocker-vs-hero-wpa-repository-v1.service';

/**
 * Captured replacement and timeline regressions built entirely from real
 * Statlocker captures for Billy (hero 72, match 676255623445218601):
 * - build evidence, graph and archetype families: billy-real.fixture.json
 * - verified per-hero lifecycle rows: statlocker-item-meta-model/billy.expected.json
 * - captured VS_HERO_WPA aggregate rows: sell-protection-calibration.json
 * The archetype is selected by the production VS_HERO_WPA selector over the
 * real captured rows, so the selected cluster is the same one the real-data
 * e2e locks. Game time 1800s is the only synthesized input (the captured
 * request samples the start of the match) and it only feeds utility timing.
 */

const HERO_ID = 72;
const CAPACITY = 12;
const GAME_TIME_SEC = 1800;
const BILLY_ENEMY_ROSTER = [6, 10, 13, 27, 31, 35];

interface CalibrationFixture {
  rows: StatlockerVsHeroWpaAggregateSourceV1[];
}

function loadFixture(): StatlockerBuildV2Fixture {
  return JSON.parse(readFileSync(
    join(__dirname, 'fixtures/statlocker-build-v2/billy-real.fixture.json'),
    'utf8',
  )) as StatlockerBuildV2Fixture;
}

function loadLifecycleEvidence(): StatlockerHeroItemLifecycleV1[] {
  const expected = JSON.parse(readFileSync(
    join(__dirname, 'fixtures/statlocker-item-meta-model/billy.expected.json'),
    'utf8',
  )) as {
    items: { itemId: number; generalWpa: number; averagePurchaseTimeS: number }[];
  };
  return expected.items.map((row) => ({
    heroId: HERO_ID,
    itemId: row.itemId,
    generalWpa: row.generalWpa,
    averagePurchaseTimeS: row.averagePurchaseTimeS,
  }));
}

function loadCalibrationRows(): StatlockerVsHeroWpaAggregateSourceV1[] {
  const calibration = JSON.parse(readFileSync(
    join(__dirname, 'fixtures/statlocker-vs-hero-wpa/sell-protection-calibration.json'),
    'utf8',
  )) as CalibrationFixture;
  return calibration.rows;
}

function buildGraph(fixture: StatlockerBuildV2Fixture) {
  const version = fixture.catalog.version;
  const source = buildRecommendationRulesetCatalogV1({
    version: {
      catalogVersionId: version.catalogVersionId,
      contentCatalogVersionId: version.contentCatalogVersionId,
      clientVersion: version.clientVersion,
      rulesetKey: version.rulesetKey,
      source: version.source,
      payloadSha256: version.payloadSha256,
      importedAt: version.importedAt ?? '2026-09-10T00:00:00.000Z',
    },
    items: fixture.catalog.items.map((row) => {
      const semantics = resolveRecommendationCatalogAssetSemantics(row);
      return {
        itemId: Number(row.itemId),
        name: row.name,
        className: row.className,
        itemType: semantics.itemType,
        slotType: row.slotType,
        cost: row.cost,
        tier: row.tier,
        shopable: semantics.shopable,
        disabled: semantics.disabled,
        active: semantics.active,
        isActiveItem: semantics.isActiveItem,
        activationType: semantics.activationType,
        rawPayload: row.rawPayload,
      };
    }),
    recipeEdges: fixture.catalog.recipes.map((row) => ({
      parentItemId: Number(row.parentItemId),
      componentItemId: Number(row.componentItemId),
      componentOrder: row.componentOrder,
    })),
    upgradePricingPolicy: {
      mode: 'TARGET_COST_MINUS_VERIFIED_COMPONENT_CREDIT',
      componentCreditRatio: 1,
      evidence: 'OBSERVED',
      source: 'deadlock-shop-full-component-credit',
    },
  });
  return compileStrictRecommendationCatalogV1(source);
}

/** Mines the captured profiles and selects the archetype the production selector picks on real rows. */
function selectCapturedArchetype(): {
  fixture: StatlockerBuildV2Fixture;
  archetype: BuildArchetypeV2;
  graph: ReturnType<typeof compileStrictRecommendationCatalogV1>['graph'];
} {
  const fixture = loadFixture();
  const compiled = buildGraph(fixture);
  const rankByAccount = new Map(
    fixture.leaderboard.profiles.map((profile) => [profile.accountId, profile.rank]),
  );
  const profiles = fixture.proBuildAnalyses.map((analysis) =>
    toStatlockerBuildProfileV2(analysis, compiled.graph, rankByAccount.get(analysis.accountId)),
  );
  const mining = new BuildArchetypeMinerV2Service().mine(profiles, {});
  const archetypes = mining.accepted.map((cluster) =>
    new BuildArchetypeCompilerV2Service().compile({
      cluster,
      profiles,
      rulesetVersion: fixture.metadata.identity.rulesetVersion,
      statlockerPatchId: fixture.metadata.identity.statlockerPatchId,
      catalogSha256: fixture.metadata.identity.catalogSha256,
      itemGraph: compiled.graph,
    }),
  );
  const selection = new BuildArchetypeSelectorV2Service().select({
    heroId: HERO_ID,
    snapshot: {
      snapshotId: 'captured-cases',
      heroId: HERO_ID,
      rulesetVersion: fixture.metadata.identity.rulesetVersion,
      statlockerPatchId: fixture.metadata.identity.statlockerPatchId,
      catalogSha256: fixture.metadata.identity.catalogSha256,
      generatedAt: '2026-09-10T00:00:00.000Z',
      sourceProfileAccountIds: profiles.map((profile) => profile.accountId),
      archetypes,
    },
    enemyHeroIds: BILLY_ENEMY_ROSTER,
    vsHeroRows: loadCalibrationRows().filter((row) => row.heroId === HERO_ID),
  });
  const archetype = archetypes.find((entry) => entry.archetypeId === selection.archetypeId);
  if (!archetype) throw new Error('captured archetype selection failed');
  return { fixture, archetype, graph: compiled.graph };
}

function buildReplacementStack(): FullBuildReplacementV2Service {
  const utility = new BuildItemUtilityV2Service(new ThreatWeightedMatchupV1Service());
  return new FullBuildReplacementV2Service(
    new FullBuildTransitionValueV2Service(utility),
    new FullBuildMatchupProtectionV1Service(),
    new FullBuildSellRankerV1Service(),
  );
}

function replacementContext(
  fixture: StatlockerBuildV2Fixture,
  rows: readonly StatlockerVsHeroWpaAggregateSourceV1[],
  lifecycle: readonly StatlockerHeroItemLifecycleV1[],
): FullBuildReplacementContextV2 {
  return {
    heroId: HERO_ID,
    gameTimeSec: GAME_TIME_SEC,
    enemyHeroIds: BILLY_ENEMY_ROSTER,
    enemyThreats: [],
    vsHeroRows: rows,
    wpaPatchData: fixture.wpaPatchData,
    t4Chains: fixture.t4Chains,
    lifecycleEvidence: lifecycle,
  };
}

function desiredFamily(
  familyId: number,
  requirement: 'REQUIRED' | 'SITUATIONAL' | 'OPTIONAL',
  terminalItemId: number,
): DesiredFamilyStateV2 {
  return {
    familyId,
    requirement,
    goalKind: requirement === 'REQUIRED'
      ? 'REQUIRED'
      : requirement === 'SITUATIONAL'
        ? 'SITUATIONAL_MATCHUP_SELECTED'
        : 'OPTIONAL',
    selectedTerminalItemId: terminalItemId,
    selectedTerminalKind: 'DEFAULT_TERMINAL',
    score: 0.5,
    confidence: 0.8,
    reasonCodes: [],
  };
}

/** Every captured family's DEFAULT terminal, expressed as planner goals. */
function capturedDesiredState(archetype: BuildArchetypeV2): DesiredBuildStateV2 {
  const families = archetype.families ?? [];
  return {
    families: families.map((family) => {
      const terminal = family.terminalCandidates.find((entry) => entry.kind === 'DEFAULT_TERMINAL');
      if (!terminal) throw new Error(`family ${family.familyId} has no default terminal`);
      return desiredFamily(
        family.familyId,
        family.requirement as 'REQUIRED' | 'SITUATIONAL' | 'OPTIONAL',
        terminal.itemId,
      );
    }),
    selectedChoiceFamilyIdsByGroup: {},
    reasonCodes: [],
  };
}

describe('Statlocker build v2 captured replacement cases (Billy, hero 72)', () => {
  it('plans the captured 17-family timeline with more than 12 transactions while the inventory peaks at exactly 12', () => {
    const { fixture, archetype, graph } = selectCapturedArchetype();
    const rows = loadCalibrationRows();
    const lifecycle = loadLifecycleEvidence();
    const planner = new FullBuildTransactionPlannerV2Service(buildReplacementStack());

    const result = planner.plan({
      archetype,
      desiredState: capturedDesiredState(archetype),
      itemGraph: graph,
      rulesetId: fixture.metadata.identity.rulesetVersion,
      capacity: CAPACITY,
      currentInventoryItemIds: [],
      replacementContext: replacementContext(fixture, rows, lifecycle),
    });

    // Verified pricing unlocks the three confirmed progressions: each runs as
    // a component BUY followed by an in-place UPGRADE. The 12 standalone and
    // component purchases fill the inventory while the upgrades interleave
    // without ever needing a new slot, so no replacement is required and the
    // last goals stay blocked at 12/12 (no held item carries lifecycle
    // evidence in this timeline, so no safe replacement exists).
    expect(result.actions.length).toBeGreaterThan(12);
    expect(result.actions.filter((action) => action.action === 'BUY')).toHaveLength(12);
    expect(result.actions.filter((action) => action.action === 'UPGRADE')).toHaveLength(3);
    expect(result.actions.every((action) => action.action !== 'REPLACE')).toBe(true);

    let maxHeld = 0;
    const inventoryByStep = simulateFullBuildInventoryV2({
      rulesetId: fixture.metadata.identity.rulesetVersion,
      itemGraph: graph,
      capacity: CAPACITY,
      initialInventoryItemIds: [],
      actions: result.actions,
    });
    expect(inventoryByStep.validation.valid).toBe(true);
    for (const step of inventoryByStep.steps) {
      maxHeld = Math.max(maxHeld, step.inventoryAfter.length);
      expect(step.inventoryAfter.length).toBeLessThanOrEqual(CAPACITY);
    }
    // The simulator maximum held count is exactly the capacity: the timeline
    // actually reaches 12/12 and never exceeds it.
    expect(maxHeld).toBe(CAPACITY);

    // Every confirmed progression executes as component BUY before in-place
    // UPGRADE, never a direct terminal BUY.
    const confirmedProgressions: ReadonlyArray<readonly [number, number]> = [
      [1672893796, 112198670],
      [393974127, 3791587546],
      [754480263, 1193964439],
    ];
    const semanticKeys = result.actions.map((action) =>
      action.action === 'BUY'
        ? `BUY:${action.buyItemId}`
        : action.action === 'UPGRADE'
          ? `UPGRADE:${action.buyItemId}:${action.recipeId}`
          : `REPLACE:${action.sellItemId}->${action.buyItemId}`,
    );
    for (const [componentItemId, terminalItemId] of confirmedProgressions) {
      expect(semanticKeys).not.toContain(`BUY:${terminalItemId}`);
      const buyIndex = semanticKeys.indexOf(`BUY:${componentItemId}`);
      const upgradeIndex = semanticKeys.indexOf(`UPGRADE:${terminalItemId}:upgrade:${terminalItemId}`);
      expect(buyIndex).toBeGreaterThanOrEqual(0);
      expect(upgradeIndex).toBeGreaterThan(buyIndex);
    }
    expect(result.reasonCodes).not.toContain('CONFIRMED_PROGRESSION_RECIPE_UNAVAILABLE');
    // The goals that would need a 13th slot stay honestly blocked: no held
    // item carries lifecycle evidence, so no safe replacement exists.
    expect(result.reasonCodes).toContain('CAPACITY_BLOCKED_NO_SAFE_REPLACEMENT');
    expect(result.reasonCodes).toContain('ITEM_META_EVIDENCE_MISSING');
    for (const reasonCode of result.reasonCodes) {
      expect(['REQUIRED_FAMILY_REGRESSION', 'IMMEDIATE_BUY_REPLACE_CHURN', 'POINTLESS_PURCHASE_CHURN']).not.toContain(reasonCode);
    }
  });

  it('at exactly 12/12 the lifecycle evidence picks the early low-WPA item while calibrated matchup protection shields the strongest item', () => {
    const { fixture, archetype, graph } = selectCapturedArchetype();
    const rows = loadCalibrationRows();
    const lifecycle = loadLifecycleEvidence();
    const replacement = buildReplacementStack();

    // Captured 12/12 inventory: three lifecycle-evidenced items (Weapon
    // Shielding - the earliest captured purchase time at 734.5s - plus
    // Crippling Headshot and Indomitable), the two items with the strongest
    // calibrated full-team matchup scores (Stalker 0.002663/0.741 and Close
    // Quarters 0.002245/0.633), and captured family terminals without
    // lifecycle rows. The incoming REQUIRED goal (Scourge) is not held.
    const projectedInventory = [
      805079544, 3884003354, 951866250, 98582110, 1342610602, 1009965641,
      3190916303, 1235347618, 3731635960, 1813726886, 2971868509, 2463960640,
    ];
    expect(projectedInventory).toHaveLength(CAPACITY);
    const decision = replacement.decide({
      archetype,
      desiredFamily: desiredFamily(2417568017, 'REQUIRED', 2417568017),
      buyItemId: 2417568017,
      projectedInventoryItemIds: projectedInventory,
      activeProgressionProtectedItemIds: new Set(),
      itemGraph: graph,
      rulesetId: fixture.metadata.identity.rulesetVersion,
      context: replacementContext(fixture, rows, lifecycle),
    });

    expect(decision.kind).toBe('REPLACE');
    if (decision.kind !== 'REPLACE') return;
    // Weapon Shielding dominates the other lifecycle-evidenced candidates on
    // the captured hero distribution (earlier purchase time, lower WPA than
    // Crippling Headshot and Indomitable), so it is the Pareto pick.
    expect(decision.sellItemId).toBe(805079544);
    // Stalker and Close Quarters clear the calibrated team gates and are
    // removed before ranking; the drop is reported alongside the fillers
    // that have no lifecycle row.
    expect(decision.reasonCodes).toContain('MATCHUP_PROTECTED');
    expect(decision.reasonCodes).toContain('SELL_CANDIDATE_LIFECYCLE_MISSING');
    expect(decision.reasonCodes).not.toContain('ITEM_META_EVIDENCE_MISSING');
  });

  it('executes the captured 12/12 replacement in place through the planner without ever consulting replacement below capacity', () => {
    const { fixture, archetype, graph } = selectCapturedArchetype();
    const rows = loadCalibrationRows();
    const lifecycle = loadLifecycleEvidence();
    const planner = new FullBuildTransactionPlannerV2Service(buildReplacementStack());

    const initialInventory = [
      805079544, 3884003354, 951866250, 98582110, 1342610602, 1009965641,
      3190916303, 1235347618, 3731635960, 1813726886, 2971868509, 2463960640,
    ];
    const result = planner.plan({
      archetype,
      desiredState: {
        families: [desiredFamily(2417568017, 'REQUIRED', 2417568017)],
        selectedChoiceFamilyIdsByGroup: {},
        reasonCodes: [],
      },
      itemGraph: graph,
      rulesetId: fixture.metadata.identity.rulesetVersion,
      capacity: CAPACITY,
      currentInventoryItemIds: initialInventory,
      replacementContext: replacementContext(fixture, rows, lifecycle),
    });

    expect(result.actions).toHaveLength(1);
    const action = result.actions[0];
    expect(action.action).toBe('REPLACE');
    if (action.action !== 'REPLACE') return;
    expect(action.sellItemId).toBe(805079544);
    expect(action.buyItemId).toBe(2417568017);
    expect(result.reasonCodes).not.toContain('CAPACITY_BLOCKED_NO_SAFE_REPLACEMENT');

    const simulation = simulateFullBuildInventoryV2({
      rulesetId: fixture.metadata.identity.rulesetVersion,
      itemGraph: graph,
      capacity: CAPACITY,
      initialInventoryItemIds: initialInventory,
      actions: result.actions,
    });
    expect(simulation.validation.valid).toBe(true);
    expect(simulation.steps[0].inventoryBefore).toHaveLength(CAPACITY);
    expect(simulation.steps[0].inventoryAfter).toHaveLength(CAPACITY);
    // The protected item (Stalker) and the incoming goal terminal are both
    // held afterwards; the lifecycle pick is gone.
    expect(simulation.finalInventoryItemIds).toContain(98582110);
    expect(simulation.finalInventoryItemIds).toContain(2417568017);
    expect(simulation.finalInventoryItemIds).not.toContain(805079544);
  });
});
