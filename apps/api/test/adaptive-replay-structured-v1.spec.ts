import { performance } from 'node:perf_hooks';
import { AdaptiveBuildPlannerV1Service } from '../src/statlocker-adaptive/adaptive-build-planner-v1.service';
import { AdaptiveEvidenceScorerV1Service } from '../src/statlocker-adaptive/adaptive-evidence-scorer-v1.service';
import {
  AdaptiveReplayInputV1,
  AdaptiveReplayOutputV1,
  AdaptiveReplayV1Service,
} from '../src/statlocker-adaptive/adaptive-replay-v1.service';
import { ADAPTIVE_POLICY_V1_CONFIG } from '../src/statlocker-adaptive/statlocker-adaptive.config';

const catalogSha256 = 'a'.repeat(64);
const PLANNER_P95_GATE_MS = 100;

function family(dataset: string, scopeKey: string, payload: unknown) {
  return {
    dataset,
    scopeKey,
    snapshotId: `${dataset}-snapshot`,
    contentSha256: 'b'.repeat(64),
    fetchedAt: '2026-09-01T12:00:00.000Z',
    freshness: 'FRESH',
    confidence: 1,
    payload,
  } as any;
}

function candidate(itemId: number, medianBuyTimeS: number, strength: number) {
  return {
    itemId,
    strength,
    coverage: 0.9,
    purchaseRate: 0.9,
    medianBuyTimeS,
    timingSpreadS: 30,
    sourceProfileCount: 10,
    frequencyTier: 'CORE' as const,
    rushEvidence: false,
  };
}

function directItem(itemId: number, cost = 500, refund = Math.floor(cost / 2)) {
  return {
    itemId,
    name: `Item ${itemId}`,
    slotType: 'weapon' as const,
    active: false,
    availableRulesetIds: ['ruleset-a'],
    directPurchaseCost: cost,
    upgradeRecipes: [],
    sellTransition: { soulsRefund: refund, returnedItemIds: [] as number[] },
    maxCopies: 1,
  };
}

function upgradeItem(itemId: number, componentId: number) {
  return {
    itemId,
    name: `Item ${itemId}`,
    slotType: 'weapon' as const,
    active: false,
    availableRulesetIds: ['ruleset-a'],
    upgradeRecipes: [{
      recipeId: `upgrade-${itemId}`,
      consumedItemIds: [componentId],
      soulsCost: 500,
    }],
    sellTransition: { soulsRefund: 500, returnedItemIds: [] as number[] },
    maxCopies: 1,
  };
}

function replayInput(): AdaptiveReplayInputV1 {
  const byDataset = {
    WPA_PATCH_DATA: family('WPA_PATCH_DATA', 'patch:15-1', {
      patchId: '15-1',
      items: [
        {
          heroId: 10,
          itemId: 1,
          meanWpa: 0.02,
          sampleSize: 1000,
          wpaConfidence: 1,
          gameState: { even: 0.02 },
          purchaseTiming: { medianPurchaseSec: 180 },
        },
        {
          heroId: 10,
          itemId: 2,
          meanWpa: 0.95,
          sampleSize: 5000,
          wpaConfidence: 1,
          gameState: { even: 0.95 },
          purchaseTiming: { medianPurchaseSec: 120 },
        },
      ],
    }),
    VS_HERO_WPA: family('VS_HERO_WPA', 'global', {
      slices: [{
        heroId: 10,
        enemyHeroId: 20,
        items: [
          { itemId: 1, deltaWpa: 0, count: 1000 },
          { itemId: 2, deltaWpa: 0.95, count: 5000 },
        ],
      }],
    }),
    T4_CHAINS: family('T4_CHAINS', 'global', { chains: [] }),
    CONSENSUS_SKELETON: family('CONSENSUS_SKELETON', 'hero:10:consensus', {
      heroId: 10,
      profileCount: 10,
      groups: [
        {
          groupId: 'hero:10:EARLY:REQUIRED:1',
          phase: 'EARLY',
          type: 'REQUIRED',
          minSelect: 1,
          maxSelect: 1,
          candidates: [candidate(1, 180, 0.8)],
          confidence: 0.8,
          inferred: true,
        },
        {
          groupId: 'hero:10:MID:REQUIRED:2',
          phase: 'MID',
          type: 'REQUIRED',
          minSelect: 1,
          maxSelect: 1,
          candidates: [candidate(2, 720, 0.99)],
          confidence: 0.99,
          inferred: true,
        },
      ],
    }),
    WPA_FILTERED_ITEMS: {
      dataset: 'WPA_FILTERED_ITEMS',
      scopeKey: 'hero:10',
      freshness: 'UNAVAILABLE',
      confidence: 0,
    },
  } as any;
  const snapshotIds = Object.values(byDataset)
    .map((entry: any) => entry.snapshotId)
    .filter((value): value is string => typeof value === 'string')
    .sort();
  const evidence = {
    heroId: 10,
    rulesetVersion: 'ruleset-a',
    catalogSha256,
    statlockerPatchId: '15-1',
    usable: true,
    snapshotIds,
    degradedReasons: [],
    families: Object.values(byDataset),
    byDataset,
  } as any;

  return {
    decision: {
      state: {
        decisionId: 'adaptive-replay-structured',
        matchId: 'match-structured',
        playerSlot: 0,
        gameTimeSec: 120,
        rulesetId: 'ruleset-a',
        heroId: 10,
        ownedItemIds: [],
        spendableSouls: { value: 1000, evidence: 'OBSERVED', source: 'test' },
        shopOpportunity: { value: 'AVAILABLE', evidence: 'OBSERVED', source: 'test' },
      },
      itemDefinitions: [directItem(1), directItem(2)],
      catalogVersionId: 'catalog-a',
      catalogSha256,
      rulesetId: 'ruleset-a',
      localSteamId: 'steam-a',
      enemyHeroIds: [20],
      enemyLiveStates: [],
      ourTeamSouls: 100000,
      enemyTeamSouls: 100000,
      slots: exactSlotState(0, 0),
      stateRevision: 'revision-structured',
    },
    evidence,
    recentPurchasedItemIds: [],
    recentSoldItemIds: [],
    configVersion: ADAPTIVE_POLICY_V1_CONFIG.version,
    scorerVersion: 'adaptive-evidence-scorer-v1',
    plannerVersion: 'adaptive-build-planner-v1',
    snapshotIds,
  };
}

function choiceReplayInput(): AdaptiveReplayInputV1 {
  const input = clone(replayInput());
  input.decision.state.decisionId = 'adaptive-replay-choice';
  input.decision.state.matchId = 'match-choice';
  input.decision.stateRevision = 'revision-choice';
  const skeleton = input.evidence.byDataset.CONSENSUS_SKELETON.payload as any;
  skeleton.groups = [{
    groupId: 'hero:10:EARLY:CHOICE:1,2',
    phase: 'EARLY',
    type: 'CHOICE',
    minSelect: 1,
    maxSelect: 1,
    candidates: [candidate(1, 180, 0.8), candidate(2, 180, 0.8)],
    confidence: 0.9,
    inferred: false,
  }];
  return input;
}

function committedChoiceReplayInput(): AdaptiveReplayInputV1 {
  const input = clone(replayInput());
  input.decision.state.decisionId = 'adaptive-replay-committed-choice';
  input.decision.state.matchId = 'match-committed-choice';
  input.decision.state.ownedItemIds = [1];
  input.decision.state.gameTimeSec = 300;
  input.decision.stateRevision = 'revision-committed-choice';
  input.decision.itemDefinitions = [
    directItem(1),
    directItem(2),
    upgradeItem(11, 1),
    upgradeItem(12, 2),
  ];
  const patch = input.evidence.byDataset.WPA_PATCH_DATA.payload as any;
  patch.items = [
    {
      heroId: 10,
      itemId: 11,
      meanWpa: 0.02,
      sampleSize: 1000,
      wpaConfidence: 1,
      gameState: { even: 0.02 },
      purchaseTiming: { medianPurchaseSec: 300 },
    },
    {
      heroId: 10,
      itemId: 12,
      meanWpa: 0.95,
      sampleSize: 5000,
      wpaConfidence: 1,
      gameState: { even: 0.95 },
      purchaseTiming: { medianPurchaseSec: 300 },
    },
  ];
  const vsHero = input.evidence.byDataset.VS_HERO_WPA.payload as any;
  vsHero.slices = [{
    heroId: 10,
    enemyHeroId: 20,
    items: [
      { itemId: 11, deltaWpa: 0, count: 1000 },
      { itemId: 12, deltaWpa: 0.95, count: 5000 },
    ],
  }];
  const skeleton = input.evidence.byDataset.CONSENSUS_SKELETON.payload as any;
  skeleton.groups = [{
    groupId: 'hero:10:EARLY:CHOICE:11,12',
    phase: 'EARLY',
    type: 'CHOICE',
    minSelect: 1,
    maxSelect: 1,
    candidates: [candidate(11, 300, 0.8), candidate(12, 300, 0.8)],
    confidence: 0.9,
    inferred: false,
  }];
  input.decision.slots = exactSlotState(1, 0);
  return input;
}

function pickTwoCommittedReplayInput(): AdaptiveReplayInputV1 {
  const input = clone(replayInput());
  input.decision.state.decisionId = 'adaptive-replay-pick-two';
  input.decision.state.matchId = 'match-pick-two';
  input.decision.state.ownedItemIds = [1, 2];
  input.decision.state.gameTimeSec = 300;
  input.decision.stateRevision = 'revision-pick-two';
  input.decision.itemDefinitions = [directItem(1), directItem(2), directItem(3)];
  input.decision.slots = exactSlotState(2, 0);
  const patch = input.evidence.byDataset.WPA_PATCH_DATA.payload as any;
  patch.items = [1, 2, 3].map((itemId) => ({
    heroId: 10,
    itemId,
    meanWpa: itemId === 3 ? 0 : 0.05,
    sampleSize: 1000,
    wpaConfidence: 1,
    gameState: { even: itemId === 3 ? 0 : 0.05 },
    purchaseTiming: { medianPurchaseSec: 300 },
  }));
  const vsHero = input.evidence.byDataset.VS_HERO_WPA.payload as any;
  vsHero.slices = [{
    heroId: 10,
    enemyHeroId: 20,
    items: [1, 2, 3].map((itemId) => ({
      itemId,
      deltaWpa: itemId === 3 ? 0 : 0.05,
      count: 1000,
    })),
  }];
  const skeleton = input.evidence.byDataset.CONSENSUS_SKELETON.payload as any;
  skeleton.groups = [{
    groupId: 'hero:10:EARLY:CHOICE:1,2,3:pick2',
    phase: 'EARLY',
    type: 'CHOICE',
    minSelect: 2,
    maxSelect: 2,
    candidates: [
      candidate(1, 300, 0.8),
      candidate(2, 300, 0.8),
      candidate(3, 300, 0.8),
    ],
    confidence: 0.9,
    inferred: false,
  }];
  return input;
}

function fullInventoryReplayInput(): AdaptiveReplayInputV1 {
  const input = clone(replayInput());
  input.decision.state.decisionId = 'adaptive-replay-full-inventory';
  input.decision.state.matchId = 'match-full-inventory';
  input.decision.state.ownedItemIds = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  input.decision.state.gameTimeSec = 300;
  input.decision.stateRevision = 'revision-full-inventory';
  input.decision.itemDefinitions = Array.from({ length: 10 }, (_, index) => directItem(index + 1));
  input.decision.slots = exactSlotState(9, 0);
  const patch = input.evidence.byDataset.WPA_PATCH_DATA.payload as any;
  patch.items = [{
    heroId: 10,
    itemId: 10,
    meanWpa: 0.2,
    sampleSize: 1000,
    wpaConfidence: 1,
    gameState: { even: 0.2 },
    purchaseTiming: { medianPurchaseSec: 300 },
  }];
  const vsHero = input.evidence.byDataset.VS_HERO_WPA.payload as any;
  vsHero.slices = [{
    heroId: 10,
    enemyHeroId: 20,
    items: [{ itemId: 10, deltaWpa: 0.2, count: 1000 }],
  }];
  const skeleton = input.evidence.byDataset.CONSENSUS_SKELETON.payload as any;
  skeleton.groups = [{
    groupId: 'hero:10:EARLY:REQUIRED:10',
    phase: 'EARLY',
    type: 'REQUIRED',
    minSelect: 1,
    maxSelect: 1,
    candidates: [candidate(10, 300, 0.9)],
    confidence: 0.9,
    inferred: false,
  }];
  return input;
}

function preparatorySellReplayInput(): AdaptiveReplayInputV1 {
  const input = clone(replayInput());
  input.decision.state.decisionId = 'adaptive-replay-preparatory-sell';
  input.decision.state.matchId = 'match-preparatory-sell';
  input.decision.state.ownedItemIds = [20, 21];
  input.decision.state.spendableSouls = { value: 0, evidence: 'OBSERVED', source: 'test' };
  input.decision.state.gameTimeSec = 300;
  input.decision.stateRevision = 'revision-preparatory-sell';
  input.decision.itemDefinitions = [
    directItem(1, 800, 400),
    directItem(20, 800, 400),
    directItem(21, 800, 400),
  ];
  input.decision.slots = exactSlotState(2, 0);
  const patch = input.evidence.byDataset.WPA_PATCH_DATA.payload as any;
  patch.items = [{
    heroId: 10,
    itemId: 1,
    meanWpa: 0.2,
    sampleSize: 1000,
    wpaConfidence: 1,
    gameState: { even: 0.2 },
    purchaseTiming: { medianPurchaseSec: 300 },
  }];
  const vsHero = input.evidence.byDataset.VS_HERO_WPA.payload as any;
  vsHero.slices = [{
    heroId: 10,
    enemyHeroId: 20,
    items: [{ itemId: 1, deltaWpa: 0.2, count: 1000 }],
  }];
  const skeleton = input.evidence.byDataset.CONSENSUS_SKELETON.payload as any;
  skeleton.groups = [{
    groupId: 'hero:10:EARLY:REQUIRED:1',
    phase: 'EARLY',
    type: 'REQUIRED',
    minSelect: 1,
    maxSelect: 1,
    candidates: [candidate(1, 300, 0.9)],
    confidence: 0.9,
    inferred: false,
  }];
  return input;
}

function exactSlotState(usedSlots: number, unlockedFlexSlots: number): any {
  const baseSlots = 9;
  const maxFlexSlots = 3;
  const usedFlexSlots = Math.max(0, usedSlots - baseSlots);
  return {
    baseSlots,
    baseSlotsByType: { weapon: 3, vitality: 3, spirit: 3 },
    maxActiveItems: 4,
    maxFlexSlots,
    unlockedFlexSlots,
    usedSlots,
    usedFlexSlots,
    usedSlotsByType: { weapon: Math.min(3, usedSlots), vitality: Math.max(0, Math.min(3, usedSlots - 3)), spirit: Math.max(0, Math.min(3, usedSlots - 6)) },
    overflowByType: { weapon: Math.max(0, usedSlots - 3), vitality: 0, spirit: 0 },
    provedFlexLowerBound: usedFlexSlots,
    freeBaseSlots: Math.max(0, baseSlots - usedSlots),
    freeFlexSlots: Math.max(0, unlockedFlexSlots - usedFlexSlots),
    totalCapacity: baseSlots + unlockedFlexSlots,
    flexCapacityEvidence: 'OBSERVED',
    evidence: 'OBSERVED' as const,
  };
}

function replayService(): AdaptiveReplayV1Service {
  const planner = new AdaptiveBuildPlannerV1Service(new AdaptiveEvidenceScorerV1Service());
  return new AdaptiveReplayV1Service({} as any, planner);
}

function replayCorpus(): AdaptiveReplayInputV1[] {
  return [
    replayInput(),
    choiceReplayInput(),
    committedChoiceReplayInput(),
    pickTwoCommittedReplayInput(),
    fullInventoryReplayInput(),
    preparatorySellReplayInput(),
  ];
}

interface StructuralGateMetricsV1 {
  illegalActionRate: number;
  slotViolationRate: number;
  hardPhaseViolationRate: number;
  doubleChoiceRate: number;
  unreachablePlanRate: number;
  nextActionBuildMismatchRate: number;
  postCommitBranchChurnRate: number;
}

function structuralGateMetrics(
  cases: readonly { input: AdaptiveReplayInputV1; output: AdaptiveReplayOutputV1 }[],
): StructuralGateMetricsV1 {
  const violations = {
    illegalActionRate: 0,
    slotViolationRate: 0,
    hardPhaseViolationRate: 0,
    doubleChoiceRate: 0,
    unreachablePlanRate: 0,
    nextActionBuildMismatchRate: 0,
    postCommitBranchChurnRate: 0,
  };

  for (const { input, output } of cases) {
    if (hasIllegalAction(output)) violations.illegalActionRate += 1;
    if (hasSlotViolation(input, output)) violations.slotViolationRate += 1;
    if (hasHardPhaseViolation(input, output)) violations.hardPhaseViolationRate += 1;
    if (hasDoubleChoice(input, output)) violations.doubleChoiceRate += 1;
    if (hasUnreachablePlan(input, output)) violations.unreachablePlanRate += 1;
    if (hasNextActionBuildMismatch(output)) violations.nextActionBuildMismatchRate += 1;
    if (hasPostCommitBranchChurn(input, output)) violations.postCommitBranchChurnRate += 1;
  }

  const denominator = Math.max(1, cases.length);
  return Object.fromEntries(
    Object.entries(violations).map(([key, count]) => [key, count / denominator]),
  ) as unknown as StructuralGateMetricsV1;
}

function hasIllegalAction(output: AdaptiveReplayOutputV1): boolean {
  if (!['BUY', 'UPGRADE', 'SELL', 'REPLACE'].includes(output.nextAction.type)) return false;
  return !output.rankedImmediateCandidates.some(
    (entry) => entry.action.actionKey === output.nextAction.actionKey,
  );
}

function hasSlotViolation(input: AdaptiveReplayInputV1, output: AdaptiveReplayOutputV1): boolean {
  const capacity = input.decision.slots?.totalCapacity ?? 9;
  const owned = new Set(input.decision.state.ownedItemIds);
  let after = new Set(owned);
  if (output.nextAction.type === 'BUY' && output.nextAction.targetItemId !== undefined) {
    after.add(output.nextAction.targetItemId);
  } else if (output.nextAction.type === 'SELL' && output.nextAction.sellItemId !== undefined) {
    after.delete(output.nextAction.sellItemId);
    const sold = definition(input, output.nextAction.sellItemId);
    for (const returned of sold?.sellTransition?.returnedItemIds ?? []) after.add(returned);
  } else if (output.nextAction.type === 'REPLACE') {
    if (output.nextAction.sellItemId !== undefined) {
      after.delete(output.nextAction.sellItemId);
      const sold = definition(input, output.nextAction.sellItemId);
      for (const returned of sold?.sellTransition?.returnedItemIds ?? []) after.add(returned);
    }
    if (output.nextAction.buyItemId !== undefined) after.add(output.nextAction.buyItemId);
  } else if (output.nextAction.type === 'UPGRADE' && output.nextAction.targetItemId !== undefined) {
    const target = definition(input, output.nextAction.targetItemId);
    const recipe = target?.upgradeRecipes.find((entry) =>
      entry.consumedItemIds.every((itemId) => owned.has(itemId)),
    );
    if (!recipe) return true;
    for (const componentId of recipe.consumedItemIds) after.delete(componentId);
    after.add(output.nextAction.targetItemId);
  }
  return after.size > capacity;
}

function hasHardPhaseViolation(input: AdaptiveReplayInputV1, output: AdaptiveReplayOutputV1): boolean {
  const nextItemId = output.recommendedBuild.find((item) => item.status === 'NEXT')?.itemId;
  if (nextItemId === undefined) return false;
  const groups = skeletonGroups(input);
  const group = groups.find((entry: any) =>
    entry.candidates.some((entryCandidate: any) => entryCandidate.itemId === nextItemId),
  );
  if (!group) return false;
  const candidateEntry = group.candidates.find((entry: any) => entry.itemId === nextItemId);
  if (candidateEntry?.rushEvidence) return false;
  const gameTimeSec = input.decision.state.gameTimeSec;
  if (group.phase === 'MID' && gameTimeSec < ADAPTIVE_POLICY_V1_CONFIG.phase.midMinTimeSec) return true;
  if (group.phase === 'LATE' && gameTimeSec < ADAPTIVE_POLICY_V1_CONFIG.phase.lateMinTimeSec) return true;

  const owned = new Set(input.decision.state.ownedItemIds);
  const targetOrder = phaseOrder(group.phase);
  return groups
    .filter((entry: any) => entry.type === 'REQUIRED' && phaseOrder(entry.phase) < targetOrder)
    .some((entry: any) => {
      const count = entry.candidates.filter((entryCandidate: any) => owned.has(entryCandidate.itemId)).length;
      return count < Math.max(1, entry.minSelect);
    });
}

function hasDoubleChoice(input: AdaptiveReplayInputV1, output: AdaptiveReplayOutputV1): boolean {
  const buildIds = new Set(output.recommendedBuild.map((item) => item.itemId));
  return skeletonGroups(input)
    .filter((group: any) => group.type === 'CHOICE')
    .some((group: any) => {
      const replacedBranches = explicitlyReplacedChoiceBranches(input, output, group);
      const selectedCount = group.candidates.filter((entry: any) =>
        buildIds.has(entry.itemId) && !replacedBranches.has(entry.itemId),
      ).length;
      return selectedCount > Math.max(1, group.maxSelect);
    });
}

function hasUnreachablePlan(input: AdaptiveReplayInputV1, output: AdaptiveReplayOutputV1): boolean {
  const inventory = new Set(input.decision.state.ownedItemIds);
  const ordered = [...output.recommendedBuild].sort((a, b) => a.position - b.position || a.itemId - b.itemId);
  for (const planned of ordered) {
    if (inventory.has(planned.itemId)) continue;
    const item = definition(input, planned.itemId);
    if (!item) return true;
    if (item.directPurchaseCost !== undefined) {
      inventory.add(planned.itemId);
      continue;
    }
    const recipe = item.upgradeRecipes.find((entry) =>
      entry.consumedItemIds.every((componentId) => inventory.has(componentId)),
    );
    if (!recipe) return true;
    for (const componentId of recipe.consumedItemIds) inventory.delete(componentId);
    inventory.add(planned.itemId);
  }
  return false;
}

function hasNextActionBuildMismatch(output: AdaptiveReplayOutputV1): boolean {
  if (output.nextAction.targetItemId === undefined) return false;
  const nextItemId = output.recommendedBuild.find((item) => item.status === 'NEXT')?.itemId;
  return nextItemId !== output.nextAction.targetItemId;
}

function hasPostCommitBranchChurn(input: AdaptiveReplayInputV1, output: AdaptiveReplayOutputV1): boolean {
  const owned = new Set(input.decision.state.ownedItemIds);
  const buildIds = new Set(output.recommendedBuild.map((item) => item.itemId));
  for (const group of skeletonGroups(input).filter((entry: any) => entry.type === 'CHOICE')) {
    const branchClosures = choiceBranchClosures(input, group);
    const committed = committedChoiceBranches(owned, branchClosures);
    if (committed.length > Math.max(1, group.maxSelect)) return true;

    const replacedBranches = explicitlyReplacedChoiceBranches(input, output, group, branchClosures);
    const effectiveCommitted = committed.filter((itemId) => !replacedBranches.has(itemId));
    const newlyPlanned = group.candidates
      .map((entry: any) => entry.itemId as number)
      .filter((itemId: number) =>
        buildIds.has(itemId) &&
        !effectiveCommitted.includes(itemId) &&
        !replacedBranches.has(itemId),
      );
    if (effectiveCommitted.length + newlyPlanned.length > Math.max(1, group.maxSelect)) return true;
  }
  return false;
}

function explicitlyReplacedChoiceBranches(
  input: AdaptiveReplayInputV1,
  output: AdaptiveReplayOutputV1,
  group: any,
  branchClosures = choiceBranchClosures(input, group),
): Set<number> {
  const sellItemId = output.nextAction.sellItemId;
  if (sellItemId === undefined || (output.nextAction.type !== 'SELL' && output.nextAction.type !== 'REPLACE')) {
    return new Set<number>();
  }
  const result = new Set<number>();
  for (const [itemId, closure] of branchClosures) {
    const siblingItems = new Set<number>();
    for (const [siblingId, siblingClosure] of branchClosures) {
      if (siblingId === itemId) continue;
      for (const siblingItemId of siblingClosure) siblingItems.add(siblingItemId);
    }
    const uniqueItems = [...closure].filter((candidateItemId) => !siblingItems.has(candidateItemId));
    if (uniqueItems.includes(sellItemId)) result.add(itemId);
  }
  return result;
}

function choiceBranchClosures(input: AdaptiveReplayInputV1, group: any): Map<number, Set<number>> {
  return new Map<number, Set<number>>(
    group.candidates.map((entry: any) => [entry.itemId, itemClosure(input, entry.itemId)]),
  );
}

function committedChoiceBranches(
  owned: ReadonlySet<number>,
  branchClosures: ReadonlyMap<number, Set<number>>,
): number[] {
  const committed: number[] = [];
  for (const [itemId, closure] of branchClosures) {
    const siblingItems = new Set<number>();
    for (const [siblingId, siblingClosure] of branchClosures) {
      if (siblingId === itemId) continue;
      for (const siblingItemId of siblingClosure) siblingItems.add(siblingItemId);
    }
    const uniqueItems = [...closure].filter((candidateItemId) => !siblingItems.has(candidateItemId));
    if (uniqueItems.some((candidateItemId) => owned.has(candidateItemId))) committed.push(itemId);
  }
  return committed.sort((a, b) => a - b);
}

function itemClosure(input: AdaptiveReplayInputV1, itemId: number, visiting = new Set<number>()): Set<number> {
  if (visiting.has(itemId)) return new Set<number>();
  const nextVisiting = new Set(visiting).add(itemId);
  const result = new Set<number>([itemId]);
  const item = definition(input, itemId);
  for (const recipe of item?.upgradeRecipes ?? []) {
    for (const componentId of recipe.consumedItemIds) {
      for (const nested of itemClosure(input, componentId, nextVisiting)) result.add(nested);
    }
  }
  return result;
}

function definition(input: AdaptiveReplayInputV1, itemId: number) {
  return input.decision.itemDefinitions.find((entry) => entry.itemId === itemId);
}

function skeletonGroups(input: AdaptiveReplayInputV1): any[] {
  const skeleton = input.evidence.byDataset.CONSENSUS_SKELETON.payload as any;
  return Array.isArray(skeleton?.groups) ? skeleton.groups : [];
}

function phaseOrder(phase: string): number {
  if (phase === 'EARLY') return 0;
  if (phase === 'MID') return 1;
  return 2;
}

function percentile(sorted: readonly number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('AdaptiveReplayV1Service structured replay invariants', () => {
  it('keeps a high-WPA MID item behind an unresolved EARLY required target', () => {
    const replay = replayService();
    const result = replay.run(replayInput());
    const next = result.recommendedBuild.find((item) => item.status === 'NEXT');

    expect(next?.itemId).toBe(1);
    expect(result.nextAction.targetItemId).toBe(1);
    expect(result.recommendedBuild.some((item) => item.itemId === 2 && item.status === 'NEXT')).toBe(false);
  });

  it('replays persisted reconstructed investment into accelerated MID eligibility', () => {
    const replay = replayService();
    const input = clone(replayInput());
    input.decision.state.gameTimeSec = 480;
    input.decision.state.ownedItemIds = [1];
    input.decision.investment = {
      evidence: 'RECONSTRUCTED',
      tracks: {
        weapon: { type: 'weapon', currentValue: 1600, achievedBreakpoint: 1600 },
        vitality: { type: 'vitality', currentValue: 1600, achievedBreakpoint: 1600 },
        spirit: { type: 'spirit', currentValue: 0 },
      },
    };

    const result = replay.run(input);

    expect(result.recommendedBuild.find((item) => item.status === 'NEXT')?.itemId).toBe(2);
  });

  it('reconstructs malformed persisted investment from matching exact economy rules', () => {
    const replay = replayService();
    const input = clone(replayInput());
    input.decision.state.gameTimeSec = 480;
    input.decision.state.ownedItemIds = [1, 3];
    input.decision.itemDefinitions = [
      { ...directItem(1, 1600), slotType: 'weapon' },
      directItem(2),
      { ...directItem(3, 1600), slotType: 'vitality' },
    ];
    input.decision.economyRules = {
      rulesetId: 'ruleset-a',
      catalogSha256,
      baseSlots: 9,
      baseSlotsByType: { weapon: 3, vitality: 3, spirit: 3 },
      maxActiveItems: 4,
      maxFlexSlots: 3,
      investmentBreakpoints: {
        weapon: [1600],
        vitality: [1600],
        spirit: [1600],
      },
    };
    input.decision.investment = {
      evidence: 'RECONSTRUCTED',
      tracks: null,
    } as any;

    const result = replay.run(input);

    expect(result.recommendedBuild.find((item) => item.status === 'NEXT')?.itemId).toBe(2);
  });

  it('fails closed for malformed persisted investment without exact economy rules', () => {
    const replay = replayService();
    const input = clone(replayInput());
    input.decision.state.gameTimeSec = 480;
    input.decision.investment = {
      evidence: 'RECONSTRUCTED',
      tracks: null,
    } as any;

    const result = replay.run(input);

    expect(result.recommendedBuild.find((item) => item.status === 'NEXT')?.itemId).toBe(1);
  });

  it('does not flag a valid fully committed pick-two group as branch churn', () => {
    const replay = replayService();
    const input = pickTwoCommittedReplayInput();
    const output = replay.run(input);

    expect(hasDoubleChoice(input, output)).toBe(false);
    expect(hasPostCommitBranchChurn(input, output)).toBe(false);
    expect(output.recommendedBuild.filter((item) => [1, 2, 3].includes(item.itemId))).toHaveLength(2);
  });

  it('accepts an explicit committed-branch replacement without treating it as silent churn', () => {
    const replay = replayService();
    const input = committedChoiceReplayInput();
    const output = replay.run(input);

    expect(['SELL', 'REPLACE']).toContain(output.nextAction.type);
    expect(output.nextAction.sellItemId).toBe(1);
    expect(hasDoubleChoice(input, output)).toBe(false);
    expect(hasPostCommitBranchChurn(input, output)).toBe(false);
  });

  it('counts an ordinary BUY into a committed choice sibling before divest as churn', () => {
    const replay = replayService();
    const input = committedChoiceReplayInput();
    const output = replay.run(input);
    const siblingBuy = {
      ...output,
      nextAction: {
        actionKey: 'BUY_ITEM:12',
        type: 'BUY' as const,
        itemId: 12,
        targetItemId: 12,
        reasonCodes: ['FEASIBLE'],
      },
      recommendedBuild: [{
        itemId: 12,
        position: 1,
        status: 'NEXT' as const,
        score: 1,
        confidence: 1,
        skeletonStrength: 1,
        contextualSupport: 1,
        reasonCodes: ['TEST_SIBLING'],
      }],
    };

    expect(hasPostCommitBranchChurn(input, siblingBuy)).toBe(true);
  });

  it('replays identical structured input deterministically', () => {
    const replay = replayService();
    const input = replayInput();
    const first = replay.run(input);
    const second = replay.run(input);

    expect(second.nextAction).toEqual(first.nextAction);
    expect(second.recommendedBuild).toEqual(first.recommendedBuild);
    expect(second.changes).toEqual(first.changes);
    expect(second.totalScore).toBe(first.totalScore);
    expect(second.confidence).toBe(first.confidence);
  });

  it('reports zero structural violations across the merge-gate replay corpus', () => {
    const replay = replayService();
    const cases = replayCorpus().map((input) => ({ input, output: replay.run(input) }));
    const metrics = structuralGateMetrics(cases);

    expect(metrics).toEqual({
      illegalActionRate: 0,
      slotViolationRate: 0,
      hardPhaseViolationRate: 0,
      doubleChoiceRate: 0,
      unreachablePlanRate: 0,
      nextActionBuildMismatchRate: 0,
      postCommitBranchChurnRate: 0,
    });
  });

  it('keeps structured planner p95 below the merge-gate latency budget', () => {
    const replay = replayService();
    const corpus = replayCorpus();
    for (let index = 0; index < 5; index += 1) {
      for (const input of corpus) replay.run(input);
    }

    const durations: number[] = [];
    for (let index = 0; index < 40; index += 1) {
      const started = performance.now();
      for (const input of corpus) replay.run(input);
      durations.push((performance.now() - started) / corpus.length);
    }
    durations.sort((a, b) => a - b);
    const p50 = percentile(durations, 0.5);
    const p95 = percentile(durations, 0.95);

    console.info(`Adaptive structured planner benchmark: p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms`);
    expect(Number.isFinite(p50)).toBe(true);
    expect(p95).toBeLessThan(PLANNER_P95_GATE_MS);
  });
});
