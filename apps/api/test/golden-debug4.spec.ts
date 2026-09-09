import { generateRecommendationCandidates } from '@deadlock-live-probe/build-domain';
import { runGolden, STRONG_WILDCARD_ROWS, DEFAULT_ENEMY_LIVE, CORE_IDS, BRANCH_A_ITEM, BRANCH_B_ITEM, WEAK_FLEX_ITEM, goldenItems, goldenDecision } from './threat-weighted-wpa-golden-replay-v1.spec';
import { candidateGeneratorRulesFromSlotStateV1 } from '../src/statlocker-adaptive/adaptive-economy-v1';

describe('debug4', () => {
  it('lists REPLACE candidates at 12/12', () => {
    const graph = createGraphSafe();
    const decision = goldenDecision(graph, {
      ownedItemIds: [...CORE_IDS, BRANCH_A_ITEM, BRANCH_B_ITEM, WEAK_FLEX_ITEM],
      spendableSouls: 4000,
    });
    const rules = candidateGeneratorRulesFromSlotStateV1(decision.slots, { allowSellOnlyActions: true, generateTargetedWaitActions: true });
    const candidates = generateRecommendationCandidates({ state: decision.state, itemGraph: graph, rules });
    const replaces = candidates.filter((c: any) => c.action.type === 'REPLACE_ITEM');
    console.log('REPLACES ' + JSON.stringify(replaces.map((c: any) => ({ id: c.actionId, feas: c.feasible, elig: c.recommendationEligible, reasons: c.reasons, sup: c.recommendationSuppressionReasons }))));
    const buys121 = candidates.filter((c: any) => (c.action as any).buyItemId === 121 || (c.action as any).itemId === 121);
    console.log('C121 ' + JSON.stringify(buys121.map((c: any) => ({ id: c.actionId, type: c.action.type, feas: c.feasible, elig: c.recommendationEligible, reasons: c.reasons }))));
  });
});

function createGraphSafe(): any {
  // reuse exported graph builder indirectly via runGolden module constants
  const mod = require('./threat-weighted-wpa-golden-replay-v1.spec');
  return (mod as any).__graph ?? buildGraph();
}
function buildGraph(): any {
  const { createRecommendationItemGraph } = require('@deadlock-live-probe/build-domain');
  const itemsMod = require('./threat-weighted-wpa-golden-replay-v1.spec');
  return createRecommendationItemGraph(itemsMod.goldenItems());
}
