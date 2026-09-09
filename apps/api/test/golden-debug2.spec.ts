import { createRecommendationItemGraph } from '@deadlock-live-probe/build-domain';
import { goldenItems, goldenStrategy, goldenDecision } from './threat-weighted-wpa-golden-replay-v1.spec';
import { AdaptiveEvidenceScorerV1Service } from '../src/statlocker-adaptive/adaptive-evidence-scorer-v1.service';
import { MatchupCandidateDiscoveryV1Service } from '../src/statlocker-adaptive/matchup-candidate-discovery-v1.service';
import { ThreatWeightedMatchupV1Service } from '../src/statlocker-adaptive/threat-weighted-matchup-v1.service';
import { EnemyThreatV1Service } from '../src/statlocker-adaptive/enemy-threat-v1.service';
import { EnemyThreatHistoryV1Service } from '../src/statlocker-adaptive/enemy-threat-history-v1.service';
import { generateRecommendationCandidates } from '@deadlock-live-probe/build-domain';
import { candidateGeneratorRulesFromSlotStateV1 } from '../src/statlocker-adaptive/adaptive-economy-v1';

function goldenEvidenceFix(): any {
  const family = (dataset: string, payload?: unknown, confidence = 0.9) => ({
    dataset, scopeKey: 'golden', freshness: payload === undefined ? 'UNAVAILABLE' : 'FRESH', confidence: payload === undefined ? 0 : confidence,
    ...(payload === undefined ? {} : { payload }),
  });
  const skeleton = { heroId: 10, profileCount: 24, groups: [101,102,103,104,105,106,107,108,109,115,116].map((itemId: number, index: number) => ({ groupId: `s${index}`, phase: index < 3 ? 'EARLY' : 'MID', type: 'REQUIRED', minSelect: 1, maxSelect: 1, confidence: 0.9, inferred: false, candidates: [{ itemId, strength: 0.9 - index * 0.02, coverage: 0.8, purchaseRate: 0.7, medianBuyTimeS: 200 + index * 150, timingSpreadS: 60, sourceProfileCount: 20, frequencyTier: 'CORE', rushEvidence: false }] })) };
  const wpa = { patchId: 'patch-golden', items: [101,102,103,104,105,106,107,108,109,115,116,110,111,112,121,122,130].map((itemId: number, index: number) => ({ heroId: 10, itemId, sampleSize: 4000, meanWpa: 0.05, wpaConfidence: 0.9, gameState: { ahead: 0.05, even: 0.05, behind: 0.05 }, purchaseTiming: { medianPurchaseSec: 200 + (index % 11) * 150 }, laneWpa: 0.05, postLaneWpa: 0.05 })) };
  return { heroId: 10, rulesetVersion: 'ruleset-golden', catalogSha256: 'a'.repeat(64), statlockerPatchId: 'patch-golden', usable: true, snapshotIds: [], degradedReasons: [], families: [], byDataset: {
    WPA_PATCH_DATA: family('WPA_PATCH_DATA', wpa), VS_HERO_WPA: family('VS_HERO_WPA'), T4_CHAINS: family('T4_CHAINS'), CONSENSUS_SKELETON: family('CONSENSUS_SKELETON', skeleton), WPA_FILTERED_ITEMS: family('WPA_FILTERED_ITEMS'),
  } };
}

describe('debug2', () => {
  it('probes scorer + discovery for 108 vs 121', () => {
    const graph = createRecommendationItemGraph(goldenItems());
    const decision = goldenDecision(graph, { ownedItemIds: [101, 102, 103, 104, 105], spendableSouls: 4000 });
    const rows = [
      { heroId: 10, enemyHeroId: 20, itemId: 121, count: 2600, deltaWpa: 0.45 },
      { heroId: 10, enemyHeroId: 30, itemId: 121, count: 2400, deltaWpa: 0.35 },
      { heroId: 10, enemyHeroId: 40, itemId: 121, count: 2200, deltaWpa: 0.20 },
      ...[101,102,103,104,105,106,107,108,109,115,116,110,111,112].flatMap((itemId: number) => [20,30,40].map((enemyHeroId: number) => ({ heroId: 10, enemyHeroId, itemId, count: 2000, deltaWpa: 0.02 }))),
    ];
    const matchup = new ThreatWeightedMatchupV1Service();
    const threats = new EnemyThreatV1Service().scoreEnemies(decision.enemyLiveStates).map(s => ({ heroId: s.heroId, threatMultiplier: s.threatMultiplier }));
    const matchupByItemId: Record<string, any> = {};
    for (const itemId of [108, 121, 115]) {
      matchupByItemId[String(itemId)] = matchup.scoreItem({ ourHeroId: 10, itemId, enemyHeroIds: [20,30,40], rows, enemyThreats: threats });
    }
    console.log('MATCHUP ' + JSON.stringify(Object.fromEntries(Object.entries(matchupByItemId).map(([k, v]: any) => [k, { raw: v.raw, conf: v.confidence, cov: v.coverage }]))));

    const scorer = new AdaptiveEvidenceScorerV1Service();
    const evidence: any = { ...goldenEvidenceFix(), draftMatchupByItemId: matchupByItemId, draftEnemyThreats: threats };
    const score = (itemId: number) => scorer.scoreItem(itemId, {
      heroId: 10, enemyHeroIds: [20,30,40], gameTimeSec: 1200, gameStateBlend: { ahead: 0, even: 0, behind: 0 },
      ownedItemIds: [101,102,103,104,105], plannedPrefixItemIds: [], evidence, ownBuildArchetype: 's', transactionPenalty: 0, churnPenalty: 0,
    });
    for (const itemId of [108, 121, 115]) {
      const s: any = score(itemId);
      console.log(`SCORE ${itemId}: conf=${s.confidence.toFixed(3)} score=${s.score.toFixed(3)} completeness=${s.completeness.toFixed(2)} comps=${JSON.stringify(s.components.filter((c: any) => c.confidence > 0).map((c: any) => [c.key, c.normalized.toFixed(2), c.confidence.toFixed(2), c.weighted.toFixed(3)]))}`);
    }

    const rules = candidateGeneratorRulesFromSlotStateV1(decision.slots, { allowSellOnlyActions: true, generateTargetedWaitActions: false });
    const legalByTarget = new Map();
    for (const candidate of generateRecommendationCandidates({ state: decision.state, itemGraph: graph, rules }).filter((c: any) => c.feasible && c.recommendationEligible)) {
      const target = (candidate.action as any).targetItemId ?? (candidate.action as any).buyItemId ?? (candidate.action as any).itemId;
      if (target === undefined) continue;
      if (!legalByTarget.has(target)) legalByTarget.set(target, candidate);
    }
    console.log('LEGAL_TARGETS ' + JSON.stringify([...legalByTarget.keys()]));
    const discovery = new MatchupCandidateDiscoveryV1Service();
    const ev = discovery.discover({
      strategy: goldenStrategy(),
      openWindows: [{
        windowId: 'counter-window', afterGoalIds: ['early-core'], beforeGoalIds: [], maxSlots: 1, maxSouls: 4000, maxCoreDelaySouls: 3200, allowedPurposes: ['COUNTER_ENEMY_HEROES'],
      }],
      legalByTarget,
      itemGraph: graph,
      maxTotalItems: 12,
      currentItemCount: 5,
      enemyHeroIds: [20, 30, 40],
      enemyItemIds: [],
      matchupByItemId,
      scoreItem: (itemId: number) => score(itemId),
    } as any);
    console.log('DISCOVERY ' + JSON.stringify(ev.map((e: any) => ({ t: e.targetItemId, sup: e.statisticalSupport, conf: e.confidence, score: e.contextualScore }))));
  });
});
