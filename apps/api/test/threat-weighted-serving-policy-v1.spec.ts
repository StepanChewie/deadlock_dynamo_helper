import 'reflect-metadata';
import {
  createRecommendationItemGraph,
  observedFact,
} from '@deadlock-live-probe/build-domain';
import { deriveAdaptiveSlotStateV1, unknownAdaptiveInvestmentStateV1 } from '../src/statlocker-adaptive/adaptive-economy-v1';
import { AdaptiveEvidenceScorerV1Service } from '../src/statlocker-adaptive/adaptive-evidence-scorer-v1.service';
import { AdaptivePhaseEligibilityV1Service } from '../src/statlocker-adaptive/adaptive-phase-eligibility-v1.service';
import { AdaptiveChoiceResolverV1Service } from '../src/statlocker-adaptive/adaptive-choice-resolver-v1.service';
import { AdaptivePlannerServingRouterV1Service } from '../src/statlocker-adaptive/adaptive-planner-serving-router-v1.service';
import { AdaptiveRecommendationObservabilityV1Service } from '../src/statlocker-adaptive/adaptive-recommendation-observability-v1.service';
import { AdaptiveRecommendationV1Service } from '../src/statlocker-adaptive/adaptive-recommendation-v1.service';
import { AdaptiveDecisionTraceV1Service } from '../src/statlocker-adaptive/adaptive-decision-trace-v1.service';
import { BuildStrategyRegistryV1Service } from '../src/statlocker-adaptive/build-strategy-registry-v1.service';
import { DraftMatchupEvidenceV1Service } from '../src/statlocker-adaptive/draft-matchup-evidence-v1.service';
import { EnemyThreatHistoryV1Service } from '../src/statlocker-adaptive/enemy-threat-history-v1.service';
import { EnemyThreatV1Service } from '../src/statlocker-adaptive/enemy-threat-v1.service';
import { StrategyFirstAdaptivePlannerFacadeV1Service } from '../src/statlocker-adaptive/strategy-first-adaptive-planner-facade-v1.service';
import { StrategyFirstBuildPlannerV1Service } from '../src/statlocker-adaptive/strategy-first-build-planner-v1.service';
import {
  StrategyFirstLegacyPlannerAdapterV1Service,
} from '../src/statlocker-adaptive/strategy-first-legacy-planner-adapter-v1.service';
import { StrategyFirstPromotionGateV1Service } from '../src/statlocker-adaptive/strategy-first-promotion-gate-v1.service';
import { StrategyFirstSituationalOverlayV1Service } from '../src/statlocker-adaptive/strategy-first-situational-overlay-v1.service';
import { ThreatWeightedMatchupV1Service } from '../src/statlocker-adaptive/threat-weighted-matchup-v1.service';
import {
  goldenDecision,
  goldenEvidence,
  goldenItems,
  goldenRows,
  goldenStrategy,
} from './threat-weighted-wpa-golden-replay-v1.spec';

// Milestone 14: policy/version flag (14.1), shadow telemetry (14.2), calibration
// metrics (14.3), and the fail-closed active rollout gate (14.4).

const CATALOG_SHA = 'a'.repeat(64);
const RULESET = 'ruleset-golden';
const PATCH = 'patch-golden';
const ENEMY_FED = 20;
const ENEMY_PRIO = 30;
const ENEMY_THIRD = 40;
const BRANCH_A_ITEM = 110;
const BRANCH_B_ITEM = 111;

const BRANCH_EVIDENCE_ROWS = [
  ...goldenRows([
    { enemyHeroId: ENEMY_FED, itemId: BRANCH_B_ITEM, count: 3000, deltaWpa: 0.12 },
    { enemyHeroId: ENEMY_PRIO, itemId: BRANCH_B_ITEM, count: 2500, deltaWpa: 0.10 },
    { enemyHeroId: ENEMY_THIRD, itemId: BRANCH_B_ITEM, count: 2000, deltaWpa: 0.08 },
    { enemyHeroId: ENEMY_FED, itemId: BRANCH_A_ITEM, count: 3000, deltaWpa: 0.01 },
    { enemyHeroId: ENEMY_PRIO, itemId: BRANCH_A_ITEM, count: 2500, deltaWpa: 0.005 },
    { enemyHeroId: ENEMY_THIRD, itemId: BRANCH_A_ITEM, count: 2000, deltaWpa: 0.004 },
  ]),
];

const ENEMY_LIVE = [
  { steamId: 'steam-20', heroId: ENEMY_FED, souls: 12000, heroDamage: 22000, kills: 6, deaths: 4, assists: 7, level: 12 },
  { steamId: 'steam-30', heroId: ENEMY_PRIO, souls: 11000, heroDamage: 20000, kills: 5, deaths: 5, assists: 6, level: 12 },
  { steamId: 'steam-40', heroId: ENEMY_THIRD, souls: 10000, heroDamage: 18000, kills: 4, deaths: 6, assists: 5, level: 11 },
];

interface PolicyHarness {
  service: AdaptiveRecommendationV1Service;
  observability: AdaptiveRecommendationObservabilityV1Service;
  gate: StrategyFirstPromotionGateV1Service;
}

function buildPolicyHarness(): PolicyHarness {
  const graph = createRecommendationItemGraph(goldenItems());
  const registry = new BuildStrategyRegistryV1Service();
  registry.replaceSnapshot({
    rulesetId: RULESET,
    patchId: PATCH,
    catalogSha256: CATALOG_SHA,
    sourceSha256: 'b'.repeat(64),
    specs: [goldenStrategy()],
    itemGraph: graph,
  });

  const scorer = new AdaptiveEvidenceScorerV1Service();
  const observability = new AdaptiveRecommendationObservabilityV1Service();
  const gate = new StrategyFirstPromotionGateV1Service(observability);
  const facade = new StrategyFirstAdaptivePlannerFacadeV1Service(
    new StrategyFirstBuildPlannerV1Service(scorer),
    registry,
    new StrategyFirstSituationalOverlayV1Service(scorer),
    observability,
  );
  const router = new AdaptivePlannerServingRouterV1Service(
    new StrategyFirstLegacyPlannerAdapterV1Service(facade, new AdaptiveDecisionTraceV1Service(scorer)),
    scorer,
    new AdaptivePhaseEligibilityV1Service(),
    new AdaptiveChoiceResolverV1Service(scorer),
    gate,
  );

  const rows = BRANCH_EVIDENCE_ROWS;
  const repository = { findActive: async () => rows };
  const draftMatchupEvidence = new DraftMatchupEvidenceV1Service(
    repository as never,
    new EnemyThreatV1Service(),
    new ThreatWeightedMatchupV1Service(),
    new EnemyThreatHistoryV1Service(),
  );

  const decision = () => goldenDecision(graph, {
    ownedItemIds: [101, 102, 103, 104, 105],
    enemyLiveStates: ENEMY_LIVE,
  });
  const decisionState = { build: jest.fn().mockImplementation(decision) };
  const evidenceService = {
    resolveLocalPatchId: jest.fn(() => PATCH),
    getLocalEvidence: jest.fn(() => goldenEvidence()),
  };
  const replay = {
    getPreviousContext: jest.fn(async () => undefined),
    toReplayInput: jest.fn(() => ({ decision: { state: {} } })),
    persist: jest.fn(async () => undefined),
  };

  const service = new AdaptiveRecommendationV1Service(
    decisionState as never,
    evidenceService as never,
    router as never,
    replay as never,
    observability,
    gate,
  );
  (service as unknown as { draftMatchupEvidence?: unknown }).draftMatchupEvidence = draftMatchupEvidence;
  return { service, observability, gate };
}

async function recommend(harness: PolicyHarness) {
  return harness.service.recommend({ matchId: 'policy-match', localSteamId: 'steam-local' });
}

function branchItemIds(result: { recommendedBuild: readonly { itemId: number }[] }): { hasA: boolean; hasB: boolean } {
  return {
    hasA: result.recommendedBuild.some((row) => row.itemId === BRANCH_A_ITEM),
    hasB: result.recommendedBuild.some((row) => row.itemId === BRANCH_B_ITEM),
  };
}

describe('Threat-weighted serving policy V1 (milestone 14)', () => {
  const ORIGINAL_MODE = process.env.ADAPTIVE_THREAT_WEIGHTED_MODE;
  const ORIGINAL_APPROVED = process.env.ADAPTIVE_THREAT_WEIGHTED_PROMOTION_APPROVED;
  const ORIGINAL_MIN = process.env.ADAPTIVE_THREAT_WEIGHTED_PROMOTION_MIN_DECISIONS;

  afterEach(() => {
    if (ORIGINAL_MODE === undefined) delete process.env.ADAPTIVE_THREAT_WEIGHTED_MODE;
    else process.env.ADAPTIVE_THREAT_WEIGHTED_MODE = ORIGINAL_MODE;
    if (ORIGINAL_APPROVED === undefined) delete process.env.ADAPTIVE_THREAT_WEIGHTED_PROMOTION_APPROVED;
    else process.env.ADAPTIVE_THREAT_WEIGHTED_PROMOTION_APPROVED = ORIGINAL_APPROVED;
    if (ORIGINAL_MIN === undefined) delete process.env.ADAPTIVE_THREAT_WEIGHTED_PROMOTION_MIN_DECISIONS;
    else process.env.ADAPTIVE_THREAT_WEIGHTED_PROMOTION_MIN_DECISIONS = ORIGINAL_MIN;
  });

  it('14.1 CURRENT keeps the current decision path authoritative and skips the challenger', async () => {
    process.env.ADAPTIVE_THREAT_WEIGHTED_MODE = 'CURRENT';
    const harness = buildPolicyHarness();
    const result = await recommend(harness);
    expect(result.ready).toBe(true);
    // Without threat-weighted evidence the skeleton prior decides the branch.
    expect(branchItemIds(result)).toEqual({ hasA: true, hasB: false });
    const status = harness.observability.getStatus();
    expect(status.counters.threatWeightedShadowComparisonCount).toBe(0);
    expect(status.counters.wpaQueryCount).toBe(0);
  });

  it('14.1 THREAT_WEIGHTED_SHADOW serves the current result while recording the comparison', async () => {
    process.env.ADAPTIVE_THREAT_WEIGHTED_MODE = 'THREAT_WEIGHTED_SHADOW';
    const harness = buildPolicyHarness();
    const shadowResult = await recommend(harness);
    expect(shadowResult.ready).toBe(true);
    // The user-facing result equals the CURRENT serving result.
    expect(branchItemIds(shadowResult)).toEqual({ hasA: true, hasB: false });

    const status = harness.observability.getStatus();
    expect(status.counters.threatWeightedShadowComparisonCount).toBe(1);
    expect(status.counters.wpaQueryCount).toBe(1);
    const comparison = status.latestThreatWeightedShadow!;
    expect(comparison).toBeDefined();
    // The challenger would have switched the branch: telemetry proves it.
    expect(comparison.wouldSwitch).toBe(true);
    expect(comparison.branchDifference).toBe(true);
    expect(comparison.currentPlanFingerprint).not.toBe(comparison.challengerPlanFingerprint);
    expect(comparison.reasonCodes.length).toBeLessThanOrEqual(12);
    // Bounded telemetry only: no RAW WPA payloads may leak into the shadow record.
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain('draftMatchupByItemId');
    expect(serialized).not.toContain('rawDeltaWpa');
    expect(serialized).not.toContain('rawPayload');
  });

  it('14.1 THREAT_WEIGHTED_ACTIVE serves the threat-weighted challenger when promotable', async () => {
    process.env.ADAPTIVE_THREAT_WEIGHTED_MODE = 'THREAT_WEIGHTED_ACTIVE';
    // Zero invariant violations + external approval keep the ACTIVE mode effective.
    process.env.ADAPTIVE_THREAT_WEIGHTED_PROMOTION_APPROVED = 'true';
    const harness = buildPolicyHarness();
    const result = await recommend(harness);
    expect(result.ready).toBe(true);
    expect(branchItemIds(result)).toEqual({ hasA: false, hasB: true });
    expect(harness.observability.getStatus().counters.wpaQueryCount).toBe(1);
  });

  it('14.1 unconfigured policy fails closed to CURRENT when a gate is present', async () => {
    delete process.env.ADAPTIVE_THREAT_WEIGHTED_MODE;
    const harness = buildPolicyHarness();
    expect(harness.gate.threatWeightedConfiguredMode()).toBe('CURRENT');
  });

  it('14.4 ACTIVE is downgraded to shadow while promotion blockers exist', async () => {
    process.env.ADAPTIVE_THREAT_WEIGHTED_MODE = 'THREAT_WEIGHTED_ACTIVE';
    const harness = buildPolicyHarness();
    const status = harness.gate.threatWeightedStatus();
    expect(status.configuredMode).toBe('THREAT_WEIGHTED_ACTIVE');
    expect(status.effectiveMode).toBe('THREAT_WEIGHTED_SHADOW');
    expect(status.promotable).toBe(false);
    expect(status.blockers).toContain('THREAT_WEIGHTED_SHADOW_SAMPLE_BELOW_PROMOTION_MINIMUM');
    // The downgrade is enforced on the serving path itself.
    const result = await recommend(harness);
    expect(branchItemIds(result)).toEqual({ hasA: true, hasB: false });
  });

  it('14.4 promotion requires zero hard-core/inventory violations and shadow evidence', async () => {
    process.env.ADAPTIVE_THREAT_WEIGHTED_MODE = 'THREAT_WEIGHTED_ACTIVE';
    process.env.ADAPTIVE_THREAT_WEIGHTED_PROMOTION_APPROVED = 'true';
    const harness = buildPolicyHarness();
    // Zero violations and zero shadow samples: the externally-approved path still
    // requires the hard invariants to hold.
    expect(harness.gate.threatWeightedStatus().promotable).toBe(true);

    harness.observability.recordStrategyInvariantCheck({
      valid: false,
      violations: [{ code: 'MANDATORY_GOAL_LOST', reasonCodes: ['TEST'] }],
    });
    const withViolation = harness.gate.threatWeightedStatus();
    expect(withViolation.promotable).toBe(false);
    expect(withViolation.blockers).toContain('THREAT_WEIGHTED_HARD_CORE_VIOLATION_ATTEMPT');
    expect(withViolation.effectiveMode).toBe('THREAT_WEIGHTED_SHADOW');

    harness.observability.recordTransactionPlanInvariantCheck({
      valid: false,
      violations: [{ code: 'PROJECTED_SLOT_VIOLATION', reasonCodes: ['TEST'] }],
    });
    const withInventory = harness.gate.threatWeightedStatus();
    expect(withInventory.promotable).toBe(false);
    expect(withInventory.blockers).toContain('THREAT_WEIGHTED_INVENTORY_VIOLATION');
  });

  it('14.3 shadow evidence accumulates calibration counters', async () => {
    process.env.ADAPTIVE_THREAT_WEIGHTED_MODE = 'THREAT_WEIGHTED_SHADOW';
    const harness = buildPolicyHarness();
    await recommend(harness);
    await recommend(harness);
    const counters = harness.observability.getStatus().counters;
    expect(counters.threatWeightedShadowComparisonCount).toBe(2);
    expect(counters.threatWeightedWouldSwitchCount).toBe(2);
    expect(counters.threatWeightedBranchDifferenceCount).toBe(2);
    expect(counters.threatWeightedDisagreementCount).toBe(2);
    // The challenger never activated wildcard/replacement in this fixture.
    expect(counters.threatWeightedWildcardActivationCount).toBe(0);
    expect(counters.threatWeightedReplacementActivationCount).toBe(0);
  });

  it('14.3 WPA ingest outcomes are observed with duration, row count, and failures', () => {
    const observability = new AdaptiveRecommendationObservabilityV1Service();
    observability.recordWpaIngestOutcome({ dataset: 'VS_HERO_WPA', durationMs: 1200, rowCount: 5400 });
    observability.recordWpaIngestOutcome({ dataset: 'VS_HERO_WPA', durationMs: 300, rowCount: 0, failure: 'row insert failed' });
    const status = observability.getStatus();
    expect(status.counters.wpaIngestCount).toBe(2);
    expect(status.counters.wpaIngestFailureCount).toBe(1);
    expect(status.counters.wpaIngestRowCountTotal).toBe(5400);
    expect(status.latestWpaIngest).toEqual(expect.objectContaining({ dataset: 'VS_HERO_WPA', failure: 'row insert failed' }));
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain('rawPayload');
  });
});
