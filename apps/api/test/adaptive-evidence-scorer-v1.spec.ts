import {
  AdaptiveEvidenceScorerV1Service,
  aggregateExactEnemyEvidenceV1,
  shrinkConfidenceV1,
} from '../src/statlocker-adaptive/adaptive-evidence-scorer-v1.service';
import { ADAPTIVE_POLICY_V1_CONFIG } from '../src/statlocker-adaptive/statlocker-adaptive.config';

function family(dataset: string, payload: any, confidence = 1) {
  return {
    dataset,
    scopeKey: dataset === 'CONSENSUS_SKELETON' ? 'hero:10:consensus' : 'global',
    snapshotId: `${dataset}-snapshot`,
    contentSha256: 'a'.repeat(64),
    freshness: confidence === 1 ? 'FRESH' : 'STALE_USABLE',
    confidence,
    payload,
  } as any;
}

function evidence(exactCount = 600, familyConfidence = 1) {
  const wpa = {
    patchId: '15-1',
    items: [{
      heroId: 10,
      itemId: 100,
      meanWpa: 0.12,
      sampleSize: 1000,
      wpaConfidence: 0.9,
      gameState: { ahead: 0.08, even: 0.12, behind: 0.18 },
      purchaseTiming: { medianPurchaseSec: 720 },
      laneWpa: 0.06,
      postLaneWpa: 0.10,
      enemyComposition: { spirit: 0.07 },
      ownBuild: { burst: 0.09 },
    }],
  };
  const slices = Array.from({ length: 6 }, (_, index) => ({
    heroId: 10,
    enemyHeroId: 20 + index,
    items: [{ itemId: 100, deltaWpa: 0.25 - index * 0.02, count: exactCount }],
  }));
  const candidate = {
    itemId: 100,
    strength: 0.95,
    coverage: 1,
    purchaseRate: 0.9,
    medianBuyTimeS: 700,
    timingSpreadS: 40,
    sourceProfileCount: 10,
    frequencyTier: 'CORE',
    rushEvidence: false,
  };
  const skeleton = {
    heroId: 10,
    profileCount: 10,
    groups: [{
      groupId: 'hero:10:MID:REQUIRED:100',
      phase: 'MID',
      type: 'REQUIRED',
      minSelect: 1,
      maxSelect: 1,
      candidates: [candidate],
      confidence: 0.95,
      inferred: true,
    }],
    items: [{
      itemId: 100,
      medianBuyTimeS: 700,
      strength: 0.95,
      tier: 'CORE',
      components: { coverage: 1, purchaseRate: 0.9, frequencyTier: 1, orderConsistency: 0.9, relationship: 0.8 },
    }],
  };
  const chains = {
    chains: [{ heroId: 10, itemIds: [50, 100], sampleSize: 500, meanWpa: 0.1 }],
  };
  return {
    heroId: 10,
    rulesetVersion: 'ruleset-a',
    catalogSha256: 'b'.repeat(64),
    statlockerPatchId: '15-1',
    usable: true,
    snapshotIds: [],
    degradedReasons: [],
    families: [],
    byDataset: {
      WPA_PATCH_DATA: family('WPA_PATCH_DATA', wpa, familyConfidence),
      VS_HERO_WPA: family('VS_HERO_WPA', { slices }, familyConfidence),
      T4_CHAINS: family('T4_CHAINS', chains, familyConfidence),
      CONSENSUS_SKELETON: family('CONSENSUS_SKELETON', skeleton, familyConfidence),
      WPA_FILTERED_ITEMS: family('WPA_FILTERED_ITEMS', { heroId: 10, items: wpa.items }, familyConfidence),
    },
  } as any;
}

const context = {
  heroId: 10,
  enemyHeroIds: [20, 21, 22, 23, 24, 25],
  gameTimeSec: 700,
  gameStateBlend: { ahead: 0, even: 1, behind: 0 },
  ownedItemIds: [50],
  plannedPrefixItemIds: [] as number[],
  enemyCompositionKey: 'spirit',
  ownBuildArchetype: 'burst',
  transactionPenalty: 0.2,
  churnPenalty: 0.1,
};

describe('AdaptiveEvidenceScorerV1Service', () => {
  it('uses n/(n+k) confidence shrinkage monotonically', () => {
    expect(shrinkConfidenceV1(0, 500)).toBe(0);
    expect(shrinkConfidenceV1(500, 500)).toBeCloseTo(0.5);
    expect(shrinkConfidenceV1(1000, 500)).toBeGreaterThan(shrinkConfidenceV1(100, 500));
  });

  it('keeps the legacy top-three helper isolated from active full-draft scoring', () => {
    const result = aggregateExactEnemyEvidenceV1(
      (evidence().byDataset.VS_HERO_WPA.payload as any).slices,
      10,
      100,
      context.enemyHeroIds,
      3,
      500,
    );
    expect(result.usedCount).toBe(3);
    expect(result.normalized).toBeLessThanOrEqual(1);
    expect(result.normalized).toBeGreaterThanOrEqual(-1);
  });

  it('clamps every score component to [-1, 1]', () => {
    const scorer = new AdaptiveEvidenceScorerV1Service();
    const result = scorer.scoreItem(100, { ...context, evidence: evidence() });
    for (const component of result.components) {
      expect(component.normalized).toBeGreaterThanOrEqual(-1);
      expect(component.normalized).toBeLessThanOrEqual(1);
    }
  });

  it('uses derived full-draft matchup evidence exactly once and ignores legacy exact slices', () => {
    const bundle = evidence(11);
    bundle.draftMatchupByItemId = {
      '100': {
        raw: 0.012,
        normalized: 0.08,
        confidence: 0.70,
        coverage: 1,
        usedCount: 6,
        contributions: [],
      },
    };

    const result = new AdaptiveEvidenceScorerV1Service().scoreItem(100, {
      ...context,
      evidence: bundle,
    });
    const draft = result.components.find((component) => component.key === 'draftMatchupFit');
    const legacy = result.components.find((component) => component.key === 'exactEnemyFit');

    expect(draft?.raw).toBeCloseTo(0.012, 12);
    expect(draft?.normalized).toBeCloseTo(0.08, 12);
    expect(draft?.confidence).toBeCloseTo(0.70, 12);
    expect(legacy).toBeUndefined();
  });

  it('does not derive a skeleton prior from legacy flat compatibility items', () => {
    const legacy = evidence();
    legacy.byDataset.CONSENSUS_SKELETON.payload = {
      heroId: 10,
      profileCount: 10,
      items: legacy.byDataset.CONSENSUS_SKELETON.payload.items,
    };

    const result = new AdaptiveEvidenceScorerV1Service().scoreItem(100, {
      ...context,
      evidence: legacy,
    });

    expect(result.components.find((component) => component.key === 'skeletonPrior')?.raw).toBe(0);
  });

  it('reduces overall confidence when otherwise identical evidence becomes stale', () => {
    const scorer = new AdaptiveEvidenceScorerV1Service();
    const fresh = scorer.scoreItem(100, { ...context, evidence: evidence(600, 1) });
    const stale = scorer.scoreItem(100, { ...context, evidence: evidence(600, 0.4) });
    expect(stale.confidence).toBeLessThan(fresh.confidence);
  });

  it('rewards a verified investment breakpoint crossing', () => {
    const scorer = new AdaptiveEvidenceScorerV1Service();
    const baseline = scorer.scoreItem(100, { ...context, evidence: evidence() });
    const crossing = scorer.scoreItem(100, {
      ...context,
      evidence: evidence(),
      investmentDelta: {
        evidence: 'RECONSTRUCTED',
        breakpointsCrossed: 1,
        distanceReducedSouls: 600,
        achievedBreakpointsLost: 0,
      },
    });

    expect(crossing.score).toBeGreaterThan(baseline.score);
    expect(crossing.components.find((component) => component.key === 'investmentUtility')?.weighted ?? 0)
      .toBeGreaterThan(0);
  });

  it('penalizes losing an achieved investment breakpoint', () => {
    const scorer = new AdaptiveEvidenceScorerV1Service();
    const result = scorer.scoreItem(100, {
      ...context,
      evidence: evidence(),
      investmentDelta: {
        evidence: 'RECONSTRUCTED',
        breakpointsCrossed: 0,
        distanceReducedSouls: 0,
        achievedBreakpointsLost: 1,
      },
    });

    expect(result.components.find((component) => component.key === 'investmentUtility')?.weighted ?? 0)
      .toBeLessThan(0);
  });

  it('makes unknown investment evidence contribute exactly zero', () => {
    const scorer = new AdaptiveEvidenceScorerV1Service();
    const result = scorer.scoreItem(100, {
      ...context,
      evidence: evidence(),
      investmentDelta: {
        evidence: 'UNKNOWN',
        breakpointsCrossed: 10,
        distanceReducedSouls: 10_000,
        achievedBreakpointsLost: 0,
      },
    });
    const investment = result.components.find((component) => component.key === 'investmentUtility');

    expect(investment?.normalized).toBe(0);
    expect(investment?.weighted).toBe(0);
  });

  it('rewards projected slot relief but never changes feasibility itself', () => {
    const scorer = new AdaptiveEvidenceScorerV1Service();
    const result = scorer.scoreItem(100, {
      ...context,
      evidence: evidence(),
      slotDelta: { flexUsedBefore: 2, flexUsedAfter: 1, slotsFreed: 1 },
    });
    expect(result.components.find((component) => component.key === 'slotEfficiency')?.weighted ?? 0)
      .toBeGreaterThan(0);
  });

  it('emits explainable base/game/timing/lane/chain/context/path and penalty components', () => {
    const scorer = new AdaptiveEvidenceScorerV1Service();
    const result = scorer.scoreItem(100, { ...context, evidence: evidence() });
    const keys = result.components.map((component) => component.key);
    expect(keys).toEqual(expect.arrayContaining([
      'skeletonPrior',
      'baseWpa',
      'gameStateFit',
      'draftMatchupFit',
      'enemyCompositionFit',
      'ownBuildFit',
      'timingFit',
      'laneFit',
      'chainFit',
      'skeletonDeviation',
      'investmentUtility',
      'slotEfficiency',
      'transaction',
      'churn',
    ]));
    expect(keys).not.toContain('exactEnemyFit');
    expect(result.version).toBe('adaptive-evidence-scorer-v1');
    expect(ADAPTIVE_POLICY_V1_CONFIG.exactEnemyMaxMatchups).toBe(3);
  });
});
