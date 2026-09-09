import { buildGoldenService } from './threat-weighted-wpa-golden-replay-v1.spec';

const NEUTRAL_ROWS_D = [101,102,103,104,105,106,107,108,109,115,116].flatMap((itemId: number) => [20,30,40].map((enemyHeroId: number) => ({ heroId: 10, enemyHeroId, itemId, count: 2000, deltaWpa: 0.02 })));
const WILD_FULL = [
  { heroId: 10, enemyHeroId: 20, itemId: 121, count: 2600, deltaWpa: 0.45 },
  { heroId: 10, enemyHeroId: 30, itemId: 121, count: 2400, deltaWpa: 0.35 },
  { heroId: 10, enemyHeroId: 40, itemId: 121, count: 2200, deltaWpa: 0.20 },
];
const WILD = [
  { heroId: 10, enemyHeroId: 20, itemId: 121, count: 2600, deltaWpa: 0.45 },
  { heroId: 10, enemyHeroId: 30, itemId: 121, count: 2400, deltaWpa: 0.35 },
  { heroId: 10, enemyHeroId: 40, itemId: 121, count: 2200, deltaWpa: 0.20 },
  ...[110].flatMap((itemId: number) => [20,30,40].map((enemyHeroId: number) => ({ heroId: 10, enemyHeroId, itemId, count: 3000, deltaWpa: 0.01 }))),
  ...[111].flatMap((itemId: number) => [20,30,40].map((enemyHeroId: number) => ({ heroId: 10, enemyHeroId, itemId, count: 3000, deltaWpa: 0.12 }))),
  ...NEUTRAL_ROWS_D,
];

describe('debug', () => {
  it('dumps E (wildcard free slot)', async () => {
    const { service } = buildGoldenService({
      ownedItemIds: [101, 102, 103, 104, 105],
      spendableSouls: 4000,
      wpaRows: [...WILD_FULL, ...WILD],
    });
    const result = await service.recommend({ matchId: 'm', localSteamId: 'l' });
    console.log('E_DUMP ' + JSON.stringify({
      next: result.nextAction,
      build: result.recommendedBuild.map(r => [r.itemId, r.status]),
      planSession: result.planSession && { state: result.planSession.state, steps: (result.planSession.steps as any[]).map((s: any) => [s.kind, s.state, s.goalId, s.action?.type, s.action?.targetItemId, s.barrier?.type]) },
      situational: (result as any).strategy?.situationalDecision,
      candidates: result.decisionTrace?.candidates.map((c: any) => ({ src: c.source, sel: c.selected, action: c.action.type, target: c.action.targetItemId ?? c.action.buyItemId, rej: c.rejectionReasonCodes, matchup: c.matchup?.score, conf: c.matchup?.confidence })),
      replacements: result.decisionTrace?.replacements?.map(r => ({ sel: r.selected, acc: r.accepted, sell: r.sellItemId, buy: r.buyItemId, net: r.netImprovement, thr: r.requiredThreshold })),
      stages: result.decisionTrace?.stages,
      blockers: result.blockers,
    }));
  });

  it('dumps H (12/12 replacement)', async () => {
    const { service } = buildGoldenService({
      ownedItemIds: [101,102,103,104,105,106,107,108,109,110,111,112],
      spendableSouls: 4000,
      wpaRows: [...WILD_FULL, ...WILD],
    });
    console.log('MARKER_H_PRESENT');
    const result = await service.recommend({ matchId: 'm', localSteamId: 'l' });
    console.log('H_DUMP ' + JSON.stringify({
      next: result.nextAction,
      build: result.recommendedBuild.map(r => [r.itemId, r.status]),
      planSession: result.planSession && { state: result.planSession.state, steps: (result.planSession.steps as any[]).map((s: any) => [s.kind, s.state, s.goalId, s.action?.type, s.action?.targetItemId, s.barrier?.type]) },
      situational: (result as any).strategy?.situationalDecision,
      candidates: result.decisionTrace?.candidates.map((c: any) => ({ src: c.source, sel: c.selected, action: c.action.type, target: c.action.targetItemId ?? c.action.buyItemId, rej: c.rejectionReasonCodes, matchup: c.matchup?.score })),
      replacements: result.decisionTrace?.replacements?.map(r => ({ sel: r.selected, acc: r.accepted, sell: r.sellItemId, buy: r.buyItemId, net: r.netImprovement, thr: r.requiredThreshold, reasons: r.reasonCodes })),
      stages: result.decisionTrace?.stages,
      blockers: result.blockers,
    }));
  });
});

describe('debug3', () => {
  it('dumps H and I with current golden fixtures', async () => {
    const mod = require('./threat-weighted-wpa-golden-replay-v1.spec');
    const { runGolden } = mod as any;
    const strong = (mod as any).STRONG_WILDCARD_ROWS;
    const marginal = (mod as any).MARGINAL_WILDCARD_ROWS;
    const h = await runGolden({
      ownedItemIds: [101,102,103,104,105,106,107,108,109,110,111,112],
      spendableSouls: 4000,
      wpaRows: strong,
      enemyLiveStates: (mod as any).DEFAULT_ENEMY_LIVE,
    });
    console.log('H2 ' + JSON.stringify({
      next: h.nextAction,
      slotPlan: (h as any).strategy?.slotPlan,
      repl: h.decisionTrace?.replacements?.map((r: any) => ({ sell: r.sellItemId, buy: r.buyItemId, net: r.netImprovement, thr: r.requiredThreshold, acc: r.accepted, sel: r.selected, rc: r.reasonCodes })),
    }));
    const i = await runGolden({
      ownedItemIds: [101,102,103,104,105,106,107,108,109,110,111,112],
      spendableSouls: 4000,
      wpaRows: marginal,
    });
    console.log('I2 ' + JSON.stringify({
      next: i.nextAction,
      slotPlan: (i as any).strategy?.slotPlan,
      repl: i.decisionTrace?.replacements?.map((r: any) => ({ sell: r.sellItemId, buy: r.buyItemId, net: r.netImprovement, thr: r.requiredThreshold, acc: r.accepted, sel: r.selected, rc: r.reasonCodes })),
    }));
  });
});
