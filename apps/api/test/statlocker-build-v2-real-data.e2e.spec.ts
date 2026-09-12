import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  RecommendationCandidate,
  RecommendationDecisionState,
  buildInventoryInstancesForRecommendation,
  buildRecommendationRulesetCatalogV1,
  compileStrictRecommendationCatalogV1,
  generateRecommendationCandidates,
  observedFact,
  unknownFact,
} from '@deadlock-live-probe/build-domain';
import type { StatlockerBuildV2Fixture } from '../src/scripts/capture-statlocker-build-v2-fixture';
import { resolveRecommendationCatalogAssetSemantics } from '../src/deadlock-live/recommendation-catalog-asset-semantics';
import {
  CANONICAL_ADAPTIVE_SLOT_RULES_V1,
  candidateGeneratorRulesFromSlotStateV1,
  createCanonicalEconomyRulesV1,
  deriveAdaptiveInvestmentStateV1,
  deriveAdaptiveSlotStateV1,
} from '../src/statlocker-adaptive/adaptive-economy-v1';
import { AdaptiveRecommendationV2Controller } from '../src/statlocker-adaptive/adaptive-recommendation-v2.controller';
import { AdaptiveRecommendationV2Service } from '../src/statlocker-adaptive/adaptive-recommendation-v2.service';
import { BuildArchetypeCompilerV2Service } from '../src/statlocker-adaptive/build-archetype-compiler-v2.service';
import { BuildArchetypeMinerV2Service } from '../src/statlocker-adaptive/build-archetype-miner-v2.service';
import { BuildArchetypeQualityGateV2Service } from '../src/statlocker-adaptive/build-archetype-quality-gate-v2.service';
import { BuildArchetypeSelectorV2Service } from '../src/statlocker-adaptive/build-archetype-selector-v2.service';
import { BuildArchetypeSessionV2Service } from '../src/statlocker-adaptive/build-archetype-session-v2.service';
import { BuildArchetypeSnapshotStoreV2Service } from '../src/statlocker-adaptive/build-archetype-snapshot-store-v2.service';
import { BuildArchetypeSnapshotV2, BuildArchetypeV2 } from '../src/statlocker-adaptive/build-archetype-v2';
import { BuildDebugTraceStoreV2Service } from '../src/statlocker-adaptive/build-debug-trace-store-v2.service';
import { BuildDecisionTraceCollectorV2, BuildDecisionTraceStageV2 } from '../src/statlocker-adaptive/build-decision-trace-v2';
import { BuildItemUtilityV2Service } from '../src/statlocker-adaptive/build-item-utility-v2.service';
import { EnemyThreatV1Service } from '../src/statlocker-adaptive/enemy-threat-v1.service';
import { FamilyFirstFullBuildResolverV2Service } from '../src/statlocker-adaptive/family-first-full-build-resolver-v2.service';
import { MatchupCandidateDiscoveryV2Service } from '../src/statlocker-adaptive/matchup-candidate-discovery-v2.service';
import { STATLOCKER_HERO_POOL_V1 } from '../src/statlocker-adaptive/statlocker-hero-pool';
import { ThreatWeightedMatchupV1Service } from '../src/statlocker-adaptive/threat-weighted-matchup-v1.service';
import { toStatlockerBuildProfileV2 } from '../src/statlocker-adaptive/statlocker-build-profile-v2';

const REQUIRED_TRACE_STAGES: readonly BuildDecisionTraceStageV2[] = [
  'SOURCE',
  'ARCHETYPE_MINING',
  'ARCHETYPE_QUALITY_GATE',
  'ARCHETYPE_SELECTION',
  'LIVE_CONTEXT',
  'CANDIDATE_DISCOVERY',
  'DESIRED_STATE',
  'PLAN_SEARCH',
  'SEMANTIC_VALIDATION',
  'FINAL_PLAN',
];

const FORBIDDEN_CHURN_REASON_CODES = new Set([
  'REQUIRED_FAMILY_REGRESSION',
  'IMMEDIATE_BUY_REPLACE_CHURN',
  'POINTLESS_PURCHASE_CHURN',
]);

interface ApprovedBillyGoldenV2 {
  selectedArchetypeId: string;
  desiredFamilies: readonly {
    familyId: number;
    selectedTerminalItemId: number;
    selectedTerminalKind: 'DEFAULT_TERMINAL' | 'OPTIONAL_TERMINAL';
  }[];
  selectedChoiceFamilyIdsByGroup: Readonly<Record<string, readonly number[]>>;
  actionSemanticKeys: readonly string[];
  finalFamilySatisfaction: readonly {
    familyId: number;
    status: string;
    terminalItemId: number;
  }[];
  mechanicalValidation: boolean;
  semanticValidation: boolean;
}

function loadFixture(): StatlockerBuildV2Fixture {
  return JSON.parse(readFileSync(
    join(__dirname, 'fixtures/statlocker-build-v2/billy-real.fixture.json'),
    'utf8',
  )) as StatlockerBuildV2Fixture;
}

function loadExpected(): ApprovedBillyGoldenV2 {
  return JSON.parse(readFileSync(
    join(__dirname, 'fixtures/statlocker-build-v2/billy-real.expected.json'),
    'utf8',
  )) as ApprovedBillyGoldenV2;
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
      importedAt: version.importedAt ?? latestProvenanceTime(fixture),
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
  });
  return compileStrictRecommendationCatalogV1(source);
}

function latestProvenanceTime(fixture: StatlockerBuildV2Fixture): string {
  return fixture.metadata.snapshotProvenance
    .map((entry) => entry.fetchedAt)
    .sort()
    .at(-1) ?? '2026-09-10T00:00:00.000Z';
}

function snapshotPersistence() {
  const rows: any[] = [];
  const repository = {
    create: jest.fn((value: any) => ({ ...value })),
    save: jest.fn(async (value: any) => {
      const index = rows.findIndex((row) => row.snapshotId === value.snapshotId);
      if (index >= 0) rows[index] = { ...value };
      else rows.push({ ...value });
      return value;
    }),
    update: jest.fn(async (where: Record<string, unknown>, patch: Record<string, unknown>) => {
      let affected = 0;
      for (const row of rows) {
        if (!matches(row, where)) continue;
        Object.assign(row, patch);
        affected += 1;
      }
      return { affected };
    }),
    findOne: jest.fn(async (options: any) => {
      const candidates = rows.filter((row) => matches(row, options?.where ?? {}));
      candidates.sort((left, right) =>
        right.publishedAt.getTime() - left.publishedAt.getTime() ||
        String(left.snapshotId).localeCompare(String(right.snapshotId)),
      );
      return candidates[0];
    }),
  };
  const manager = { getRepository: jest.fn(() => repository) };
  return {
    rows,
    dataSource: {
      getRepository: jest.fn(() => repository),
      transaction: jest.fn(async (callback: (value: any) => Promise<unknown>) => callback(manager)),
    } as any,
  };
}

function lockPersistence() {
  let row: any;
  const repository = {
    findOne: jest.fn(async ({ where }: any) => row?.matchId === where.matchId ? row : null),
    create: jest.fn((value: any) => ({ ...value })),
    save: jest.fn(async (value: any) => {
      if (!row) row = { ...value };
      return row;
    }),
  };
  return { repository, get: () => row };
}

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => row[key] === value);
}

function buildDecision(fixture: StatlockerBuildV2Fixture, compiled: ReturnType<typeof compileStrictRecommendationCatalogV1>) {
  const request = fixture.request;
  const graph = compiled.graph;
  const heldByItemId = buildInventoryInstancesForRecommendation(request.ownedItemIds, graph);
  const state: RecommendationDecisionState = {
    decisionId: `real-fixture:${request.stateRevision}`,
    matchId: request.matchId,
    playerSlot: 0,
    gameTimeSec: request.gameTimeSec,
    rulesetId: compiled.rulesetId,
    heroId: request.heroId,
    inventory: {
      initializedFromSnapshot: true,
      heldByItemId,
      lifecycleCountByItemId: new Map(request.ownedItemIds.map((itemId) => [itemId, 1])),
      nextInstanceSequence: heldByItemId.size + 1,
    },
    economy: {
      spendableSouls: observedFact(request.spendableSouls, 'real-fixture-request'),
      shopOpportunity: unknownFact('real-fixture-shop-opportunity-unobserved'),
    },
  };
  const slotRules = {
    ...CANONICAL_ADAPTIVE_SLOT_RULES_V1,
    maxFlexSlots: request.totalCapacity,
  };
  const slots = deriveAdaptiveSlotStateV1(
    request.ownedItemIds,
    graph,
    slotRules,
    { unlockedFlexSlots: request.totalCapacity, evidence: 'OBSERVED' },
  );
  const economyRules = createCanonicalEconomyRulesV1(compiled.rulesetId, fixture.metadata.identity.catalogSha256);
  return {
    state,
    itemGraph: graph,
    catalogVersionId: fixture.catalog.version.catalogVersionId,
    catalogSha256: fixture.metadata.identity.catalogSha256,
    rulesetId: compiled.rulesetId,
    localSteamId: request.localSteamId ?? 'real-fixture-local',
    allyHeroIds: [...(request.allyHeroIds ?? [])],
    enemyHeroIds: [...request.enemyHeroIds],
    enemyHeroes: request.enemyHeroIds.map((heroId) => ({ heroId })),
    enemyLiveStates: request.enemyHeroIds.map((heroId) => {
      const source = request.enemyLiveStates?.find((entry) => Number(entry.heroId) === heroId);
      return {
        steamId: `real-fixture-enemy:${heroId}`,
        heroId,
        ...copyFinite(source, ['level', 'souls', 'kills', 'deaths', 'assists', 'heroDamage']),
      };
    }),
    allyItemIds: [...(request.allyItemIds ?? [])],
    enemyItemIds: [...(request.enemyItemIds ?? [])],
    slots,
    investment: deriveAdaptiveInvestmentStateV1(request.ownedItemIds, graph, economyRules),
    economyRules,
    economyRulesEvidence: 'RECONSTRUCTED' as const,
    stateRevision: request.stateRevision,
  };
}

function copyFinite(source: Record<string, unknown> | undefined, keys: readonly string[]): Record<string, number> {
  if (!source) return {};
  const result: Record<string, number> = {};
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
  }
  return result;
}

function evidenceBundle(fixture: StatlockerBuildV2Fixture) {
  const fresh = (dataset: string, scopeKey: string, payload?: unknown) => ({
    dataset,
    scopeKey,
    freshness: 'FRESH' as const,
    confidence: 1,
    ...(payload === undefined ? {} : { payload }),
  });
  const unavailable = (dataset: string, scopeKey: string) => ({
    dataset,
    scopeKey,
    freshness: 'UNAVAILABLE' as const,
    confidence: 0,
  });
  const byDataset = {
    WPA_PATCH_DATA: fresh('WPA_PATCH_DATA', `patch:${fixture.metadata.identity.statlockerPatchId}`, fixture.wpaPatchData),
    VS_HERO_WPA: fresh('VS_HERO_WPA', 'global'),
    T4_CHAINS: fresh('T4_CHAINS', 'global', fixture.t4Chains),
    CONSENSUS_SKELETON: unavailable('CONSENSUS_SKELETON', `hero:${fixture.request.heroId}:consensus`),
    WPA_FILTERED_ITEMS: unavailable('WPA_FILTERED_ITEMS', `hero:${fixture.request.heroId}`),
  };
  return {
    heroId: fixture.request.heroId,
    rulesetVersion: fixture.metadata.identity.rulesetVersion,
    catalogSha256: fixture.metadata.identity.catalogSha256,
    statlockerPatchId: fixture.metadata.identity.statlockerPatchId,
    usable: true,
    snapshotIds: fixture.metadata.snapshotProvenance.map((entry) => entry.snapshotId).sort(),
    degradedReasons: [],
    families: Object.values(byDataset),
    byDataset,
  };
}

function legalStrategicCandidates(decision: ReturnType<typeof buildDecision>): ReadonlyMap<number, RecommendationCandidate> {
  const generated = generateRecommendationCandidates({
    state: decision.state,
    itemGraph: decision.itemGraph,
    rules: candidateGeneratorRulesFromSlotStateV1(decision.slots, {
      allowSellOnlyActions: false,
      generateTargetedWaitActions: false,
    }),
  });
  const result = new Map<number, RecommendationCandidate>();
  for (const candidate of generated) {
    const targetItemId = candidateTargetItemId(candidate);
    if (targetItemId === undefined || result.has(targetItemId)) continue;
    if (!candidate.feasible || !candidate.recommendationEligible) continue;
    result.set(targetItemId, candidate);
  }
  return result;
}

function candidateTargetItemId(candidate: RecommendationCandidate): number | undefined {
  if (candidate.action.type === 'BUY_ITEM' || candidate.action.type === 'UPGRADE_ITEM') return candidate.action.itemId;
  if (candidate.action.type === 'REPLACE_ITEM') return candidate.action.buyItemId;
  return undefined;
}

function observedStrategicItemIds(fixture: StatlockerBuildV2Fixture): Set<number> {
  const observed = new Set<number>();
  for (const analysis of fixture.proBuildAnalyses) {
    for (const item of analysis.items) observed.add(Number(item.itemId));
  }
  return observed;
}

function minimumRequiredOccupancy(archetype: BuildArchetypeV2): number {
  const required = (archetype.families ?? []).filter((family) => family.requirement === 'REQUIRED').length;
  const choice = archetype.groups
    .filter((group) => group.type === 'CHOICE')
    .reduce((sum, group) => sum + group.minSelect, 0);
  return required + choice;
}

function allPlanReasonCodes(result: any): string[] {
  return [
    ...(result.fullBuild?.validation?.reasonCodes ?? []),
    ...(result.fullBuild?.mechanicalValidation?.reasonCodes ?? []),
    ...(result.fullBuild?.semanticValidation?.reasonCodes ?? []),
    ...(result.fullBuild?.degradedReasons ?? []),
    ...(result.fullBuild?.steps ?? []).flatMap((step: any) => step.reasonCodes ?? []),
  ];
}

function actionSemanticKey(step: any): string {
  if (step.action === 'BUY') return `BUY:${step.buyItemId}`;
  if (step.action === 'UPGRADE') return `UPGRADE:${step.buyItemId}:${step.recipeId}`;
  return `REPLACE:${step.sellItemId}->${step.buyItemId}`;
}

function approvedGoldenFor(result: any, selection: { archetypeId: string }): ApprovedBillyGoldenV2 {
  const desiredState = result.fullBuild?.desiredState;
  const finalFamilyStates = new Map<number, any>(
    (result.fullBuild?.semanticValidation?.finalFamilyStates ?? [])
      .map((state: any) => [state.familyId, state]),
  );
  const requiredOrChoiceFamilies = (desiredState?.families ?? [])
    .filter((family: any) => family.requirement === 'REQUIRED' || family.requirement === 'CHOICE');

  return {
    selectedArchetypeId: selection.archetypeId,
    desiredFamilies: (desiredState?.families ?? []).map((family: any) => ({
      familyId: family.familyId,
      selectedTerminalItemId: family.selectedTerminalItemId,
      selectedTerminalKind: family.selectedTerminalKind,
    })),
    selectedChoiceFamilyIdsByGroup: desiredState?.selectedChoiceFamilyIdsByGroup ?? {},
    actionSemanticKeys: (result.fullBuild?.steps ?? []).map(actionSemanticKey),
    finalFamilySatisfaction: requiredOrChoiceFamilies.map((family: any) => {
      const state = finalFamilyStates.get(family.familyId);
      return {
        familyId: family.familyId,
        status: state?.status ?? 'UNSATISFIED',
        terminalItemId: state?.terminalItemId ?? 0,
      };
    }),
    mechanicalValidation: result.fullBuild?.mechanicalValidation?.valid === true,
    semanticValidation: result.fullBuild?.semanticValidation?.valid === true,
  };
}

function renderReport(input: {
  fixture: StatlockerBuildV2Fixture;
  snapshot: BuildArchetypeSnapshotV2;
  mining: ReturnType<BuildArchetypeMinerV2Service['mine']>;
  selection: { archetypeId: string; mode: string; scores: readonly { archetypeId: string; score: number; confidence: number; coverage: number }[] };
  result: any;
  stages: readonly BuildDecisionTraceStageV2[];
}): string {
  const names = new Map(input.fixture.catalog.items.map((catalogItem) => [catalogItem.itemId, catalogItem.name]));
  const heroNames = new Map(STATLOCKER_HERO_POOL_V1.map((hero) => [hero.heroId, hero.name]));
  const item = (itemId: number) => `${names.get(itemId) ?? 'Unknown item'} [${itemId}]`;
  const selectedArchetype = input.snapshot.archetypes.find((archetype) => archetype.archetypeId === input.selection.archetypeId);
  const finalInventory = input.result.fullBuild?.steps?.at(-1)?.inventoryAfter ?? input.fixture.request.ownedItemIds;
  const lines: string[] = [];

  lines.push('BUILD_V2_E2E_REPORT_START');
  lines.push(`Hero: Billy (${input.fixture.request.heroId})`);
  lines.push(`Enemy roster: ${input.fixture.request.enemyHeroIds.map((heroId) => `${heroNames.get(heroId) ?? 'Unknown hero'} [${heroId}]`).join(', ')}`);
  lines.push(`Source profiles: ${input.snapshot.sourceProfileAccountIds.length}`);
  lines.push(`Statlocker VS_HERO_WPA rows: ${input.fixture.vsHeroWpaRows.length}`);
  lines.push(`Archetypes found: ${input.snapshot.archetypes.map((archetype) => archetype.archetypeId).join(', ')}`);
  for (const rejected of input.mining.rejected) {
    lines.push(`Rejected cluster ${rejected.clusterId}: ${rejected.reasonCodes.join(', ')}`);
  }

  lines.push('FAMILY SEMANTICS:');
  for (const family of selectedArchetype?.families ?? []) {
    const progression = family.progressionNodes.map((node) => item(node.itemId)).join(' -> ');
    const defaultTerminal = family.terminalCandidates.find((terminal) => terminal.kind === 'DEFAULT_TERMINAL');
    const optionalTerminals = family.terminalCandidates.filter((terminal) => terminal.kind === 'OPTIONAL_TERMINAL');
    lines.push(
      `  family ${family.familyId}: requirement=${family.requirement}, progression=${progression || 'none'}, default=${defaultTerminal ? item(defaultTerminal.itemId) : 'none'}, optional=${optionalTerminals.map((terminal) => item(terminal.itemId)).join(' | ') || 'none'}`,
    );
  }

  lines.push(`Selected archetype: ${input.selection.archetypeId} (${input.selection.mode})`);
  lines.push('Selection evidence:');
  for (const score of input.selection.scores) {
    lines.push(`  VS_HERO_WPA ${score.archetypeId}: score=${score.score.toFixed(6)}, confidence=${score.confidence.toFixed(4)}, coverage=${score.coverage.toFixed(4)}`);
  }

  lines.push('DESIRED BUILD STATE:');
  const desiredState = input.result.fullBuild?.desiredState;
  const choiceEntries = Object.entries(desiredState?.selectedChoiceFamilyIdsByGroup ?? {});
  lines.push(`  selected CHOICE families: ${choiceEntries.length ? choiceEntries.map(([groupId, ids]) => `${groupId}=[${(ids as number[]).join(', ')}]`).join('; ') : 'none'}`);
  for (const family of desiredState?.families ?? []) {
    lines.push(
      `  family ${family.familyId}: requirement=${family.requirement}, terminal=${item(family.selectedTerminalItemId)}, kind=${family.selectedTerminalKind}, score=${family.score.toFixed(6)}, confidence=${family.confidence.toFixed(4)}, reasons=${family.reasonCodes.join(', ') || 'none'}`,
    );
  }

  lines.push('FULL BUILD - PURCHASE ORDER:');
  for (const step of input.result.fullBuild?.steps ?? []) {
    if (step.action === 'BUY') {
      lines.push(`  ${step.sequence}. BUY ${item(step.buyItemId)} -> [${step.inventoryAfter.map(item).join(', ')}]`);
    } else if (step.action === 'UPGRADE') {
      lines.push(`  ${step.sequence}. UPGRADE ${step.consumedItemIds.map(item).join(' + ')} -> ${item(step.buyItemId)} -> [${step.inventoryAfter.map(item).join(', ')}]`);
    } else {
      lines.push(`  ${step.sequence}. REPLACE ${item(step.sellItemId)} -> ${item(step.buyItemId)} -> [${step.inventoryAfter.map(item).join(', ')}]`);
    }
  }

  lines.push('FINAL INVENTORY - ORDER IS NOT PURCHASE ORDER:');
  lines.push(`  Final occupancy: ${finalInventory.length}/${input.fixture.request.totalCapacity}`);
  for (const itemId of finalInventory) lines.push(`  ${item(itemId)}`);

  lines.push('FAMILY SATISFACTION:');
  for (const state of input.result.fullBuild?.semanticValidation?.finalFamilyStates ?? []) {
    const desired = desiredState?.families?.find((family: any) => family.familyId === state.familyId);
    if (desired?.requirement !== 'REQUIRED' && desired?.requirement !== 'CHOICE') continue;
    lines.push(
      `  family ${state.familyId}: requirement=${desired.requirement}, status=${state.status}, terminal=${state.terminalItemId ? item(state.terminalItemId) : 'none'}, current=[${state.currentItemIds.map(item).join(', ')}]`,
    );
  }

  const runtimeTrace = input.result.trace;
  if (runtimeTrace) lines.push(`Trace revision: ${runtimeTrace.revision}`);
  lines.push(`Trace stages: ${input.stages.join(', ')}`);
  lines.push(`Inventory simulation: ${input.result.fullBuild?.mechanicalValidation?.valid ? 'PASS' : 'FAIL'}`);
  lines.push(`Semantic validation: ${input.result.fullBuild?.semanticValidation?.valid ? 'PASS' : 'FAIL'}`);
  lines.push(`Combined validation: ${input.result.fullBuild?.validation?.valid ? 'PASS' : 'FAIL'}`);
  lines.push(`Degraded reasons: ${(input.result.fullBuild?.degradedReasons ?? []).join(', ') || 'none'}`);
  lines.push('BUILD_V2_E2E_REPORT_END');
  return lines.join('\n');
}

describe('Statlocker Build V2 real Billy fixture', () => {
  it('fails closed on confirmed Statlocker progression when the frozen fixture has no verified upgrade-pricing mechanics', async () => {
    const fixture = loadFixture();
    expect(fixture.metadata.buildEvidenceSource).toBe('STATLOCKER_ONLY');
    expect(fixture.metadata.liveContextSource).toBe('REQUEST');
    expect(fixture.request.heroId).toBe(72);
    expect(fixture.proBuildAnalyses).toHaveLength(10);
    expect(fixture.request.enemyHeroIds).toHaveLength(6);
    expect(fixture.vsHeroWpaRows.length).toBeGreaterThan(0);

    const compiled = buildGraph(fixture);
    expect(compiled.rulesetId).toBe(fixture.metadata.identity.rulesetVersion);
    const rankByAccount = new Map(fixture.leaderboard.profiles.map((profile) => [profile.accountId, profile.rank]));
    const profiles = fixture.proBuildAnalyses.map((analysis) =>
      toStatlockerBuildProfileV2(analysis, compiled.graph, rankByAccount.get(analysis.accountId)),
    );
    expect(profiles).toHaveLength(10);

    const precomputeTrace = new BuildDecisionTraceCollectorV2();
    const mining = new BuildArchetypeMinerV2Service().mine(profiles, {}, precomputeTrace);
    expect(mining.accepted.length).toBeGreaterThan(0);
    const compiler = new BuildArchetypeCompilerV2Service();
    const archetypes = mining.accepted.map((cluster) => compiler.compile({
      cluster,
      profiles,
      rulesetVersion: fixture.metadata.identity.rulesetVersion,
      statlockerPatchId: fixture.metadata.identity.statlockerPatchId,
      catalogSha256: fixture.metadata.identity.catalogSha256,
      itemGraph: compiled.graph,
    }));

    const observedItemIds = observedStrategicItemIds(fixture);
    for (const archetype of archetypes) {
      for (const family of archetype.families ?? []) {
        for (const terminal of family.terminalCandidates) {
          expect(observedItemIds.has(terminal.itemId)).toBe(true);
        }
      }
      expect(minimumRequiredOccupancy(archetype)).toBeLessThanOrEqual(fixture.request.totalCapacity);
    }

    const snapshot: BuildArchetypeSnapshotV2 = {
      snapshotId: `real-billy:${fixture.metadata.identity.catalogSha256.slice(0, 24)}`,
      heroId: fixture.request.heroId,
      rulesetVersion: fixture.metadata.identity.rulesetVersion,
      statlockerPatchId: fixture.metadata.identity.statlockerPatchId,
      catalogSha256: fixture.metadata.identity.catalogSha256,
      generatedAt: latestProvenanceTime(fixture),
      sourceProfileAccountIds: profiles
        .slice()
        .sort((left, right) => (left.leaderboardRank ?? 999) - (right.leaderboardRank ?? 999))
        .map((entry) => entry.accountId),
      archetypes,
    };
    const gate = new BuildArchetypeQualityGateV2Service();
    const quality = gate.evaluate(snapshot, compiled.graph);
    precomputeTrace.record({
      stage: 'ARCHETYPE_QUALITY_GATE',
      reasonCodes: [...quality.reasonCodes],
      payload: {
        results: quality.archetypes.map((entry) => ({
          archetypeId: entry.archetypeId,
          accepted: entry.accepted,
          reasonCodes: [...entry.reasonCodes],
        })),
      },
    });
    expect(quality.accepted).toBe(true);

    const snapshotDb = snapshotPersistence();
    const snapshotStore = new BuildArchetypeSnapshotStoreV2Service(snapshotDb.dataSource);
    await snapshotStore.publishValidated(snapshot, quality, new Date(snapshot.generatedAt));
    expect(snapshotDb.rows).toHaveLength(1);

    const decision = buildDecision(fixture, compiled);
    const lockDb = lockPersistence();
    const session = new BuildArchetypeSessionV2Service(lockDb.repository as any);
    const selector = new BuildArchetypeSelectorV2Service();
    const matchup = new ThreatWeightedMatchupV1Service();
    const utility = new BuildItemUtilityV2Service(matchup);
    const threat = new EnemyThreatV1Service();
    const discovery = new MatchupCandidateDiscoveryV2Service(utility, matchup);
    const resolver = new FamilyFirstFullBuildResolverV2Service(utility);
    const traceStore = new BuildDebugTraceStoreV2Service();
    const evidence = evidenceBundle(fixture);
    const service = new AdaptiveRecommendationV2Service(
      { build: jest.fn(async () => decision) } as any,
      {
        resolveLocalPatchId: jest.fn(() => fixture.metadata.identity.statlockerPatchId),
        getLocalEvidence: jest.fn(() => evidence),
      } as any,
      snapshotStore,
      { findActive: jest.fn(async () => fixture.vsHeroWpaRows) } as any,
      selector,
      session,
      threat,
      discovery,
      resolver,
      traceStore,
    );
    const controller = new AdaptiveRecommendationV2Controller(service);

    const result = await controller.recommend({ matchId: fixture.request.matchId });
    const runtimeTrace = traceStore.get(fixture.request.matchId);
    const combinedStages = [
      ...precomputeTrace.stages().map((entry) => entry.stage),
      ...(runtimeTrace?.stages.map((entry) => entry.stage) ?? []),
    ];
    const selection = (lockDb.get()?.selection ?? {}) as any;
    const selectedArchetype = snapshot.archetypes.find((archetype) => archetype.archetypeId === selection.archetypeId);
    expect(selectedArchetype).toBeDefined();

    const report = renderReport({
      fixture,
      snapshot,
      mining,
      selection,
      result: { ...result, trace: runtimeTrace },
      stages: combinedStages,
    });
    process.stdout.write(`\n${report}\n`);

    expect(result.ready).toBe(false);
    expect(result.lock?.archetypeId).toBe(selection.archetypeId);
    expect(result.lock?.selectionMode).toBe('VS_HERO_WPA');
    expect(result.fullBuild?.validation.valid).toBe(false);
    expect(result.fullBuild?.degradedReasons).toContain('CONFIRMED_PROGRESSION_RECIPE_UNAVAILABLE');
    expect(result.blockers).toContain('CONFIRMED_PROGRESSION_RECIPE_UNAVAILABLE');
    expect(result.nextAction).toEqual({
      type: 'HOLD',
      reasonCodes: expect.arrayContaining(['CONFIRMED_PROGRESSION_RECIPE_UNAVAILABLE']),
    });
    expect(result.fullBuild?.steps.every((step) => step.inventoryAfter.length <= fixture.request.totalCapacity)).toBe(true);

    for (const reasonCode of allPlanReasonCodes(result)) {
      expect(FORBIDDEN_CHURN_REASON_CODES.has(reasonCode)).toBe(false);
    }
    expect(approvedGoldenFor(result, selection)).not.toEqual(loadExpected());

    expect(lockDb.get()).toBeDefined();
    const second = await controller.recommend({ matchId: fixture.request.matchId });
    expect(second.lock?.archetypeId).toBe(result.lock?.archetypeId);
    expect(lockDb.repository.save).toHaveBeenCalledTimes(1);
    expect(combinedStages).toEqual(expect.arrayContaining(REQUIRED_TRACE_STAGES));
    expect(legalStrategicCandidates(decision)).toBeInstanceOf(Map);
  });
});
