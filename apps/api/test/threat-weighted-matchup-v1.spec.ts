import { StatlockerVsHeroWpaAggregateSourceV1 } from '../src/statlocker-adaptive/statlocker-vs-hero-wpa-repository-v1.service';
import { ThreatWeightedMatchupV1Service } from '../src/statlocker-adaptive/threat-weighted-matchup-v1.service';

const OUR_HERO_ID = 6;
const ENEMY_HERO_IDS = [11, 22, 33, 44, 55, 66] as const;

function row(
  itemId: number,
  enemyHeroId: number,
  deltaWpa: number,
  count: number,
): StatlockerVsHeroWpaAggregateSourceV1 {
  return {
    heroId: OUR_HERO_ID,
    enemyHeroId,
    itemId,
    count,
    deltaWpa,
  };
}

function scoreItem(
  service: ThreatWeightedMatchupV1Service,
  itemId: number,
  rows: readonly StatlockerVsHeroWpaAggregateSourceV1[],
  enemyThreats: readonly { heroId: number; threatMultiplier: number }[] = [],
) {
  return service.scoreItem({
    ourHeroId: OUR_HERO_ID,
    itemId,
    enemyHeroIds: ENEMY_HERO_IDS,
    rows,
    enemyThreats,
  });
}

describe('ThreatWeightedMatchupV1Service', () => {
  it('lets broad moderate evidence beat one tiny-sample matchup spike', () => {
    const service = new ThreatWeightedMatchupV1Service();
    const rows = [
      ...ENEMY_HERO_IDS.map((enemyHeroId) => row(100, enemyHeroId, 0.018, 1000)),
      row(200, 11, 0.060, 20),
    ];

    const broad = scoreItem(service, 100, rows);
    const spike = scoreItem(service, 200, rows);

    expect(broad.usedCount).toBe(6);
    expect(broad.normalized).toBeGreaterThan(spike.normalized);
  });

  it('allows a strong matchup into the highest live threat to beat broad weak coverage', () => {
    const service = new ThreatWeightedMatchupV1Service();
    const rows = [
      ...ENEMY_HERO_IDS.map((enemyHeroId) => row(300, enemyHeroId, 0.006, 2000)),
      row(400, 11, 0.040, 2000),
    ];
    const enemyThreats = ENEMY_HERO_IDS.map((heroId) => ({
      heroId,
      threatMultiplier: heroId === 11 ? 1.5 : 0.75,
    }));

    const broad = scoreItem(service, 300, rows, enemyThreats);
    const focused = scoreItem(service, 400, rows, enemyThreats);

    expect(focused.normalized).toBeGreaterThan(broad.normalized);
    expect(focused.contributions[0].threatMultiplier).toBe(1.5);
  });

  it('materially penalizes a negative matchup into the main live threat', () => {
    const service = new ThreatWeightedMatchupV1Service();
    const rows = [
      row(500, 11, -0.050, 2000),
      ...ENEMY_HERO_IDS.slice(1).map((enemyHeroId) => row(500, enemyHeroId, 0.008, 2000)),
    ];
    const enemyThreats = ENEMY_HERO_IDS.map((heroId) => ({
      heroId,
      threatMultiplier: heroId === 11 ? 1.5 : 0.75,
    }));

    const result = scoreItem(service, 500, rows, enemyThreats);

    expect(result.normalized).toBeLessThan(0);
    expect(result.contributions.find((entry: { enemyHeroId: number }) => entry.enemyHeroId === 11)?.weightedContribution)
      .toBeLessThan(0);
  });

  it('shrink-adjusts low-sample spikes with K=500 before normalization', () => {
    const service = new ThreatWeightedMatchupV1Service();

    const result = scoreItem(service, 600, [row(600, 11, 0.100, 10)]);
    const contribution = result.contributions[0];
    const expectedConfidence = 10 / 510;
    const expectedEffectiveDelta = 0.100 * expectedConfidence;

    expect(contribution.sampleConfidence).toBeCloseTo(expectedConfidence, 12);
    expect(contribution.effectiveDeltaWpa).toBeCloseTo(expectedEffectiveDelta, 12);
    expect(contribution.normalizedEffectiveDelta).toBeCloseTo(Math.tanh(expectedEffectiveDelta / 0.15), 12);
    expect(result.confidence).toBeLessThan(0.01);
  });

  it('uses neutral threat multipliers when live threat data is unavailable', () => {
    const service = new ThreatWeightedMatchupV1Service();
    const rows = ENEMY_HERO_IDS.map((enemyHeroId) => row(700, enemyHeroId, 0.010, 1000));

    const result = scoreItem(service, 700, rows, []);

    expect(result.contributions).toHaveLength(6);
    expect(result.contributions.every((entry: { threatMultiplier: number }) => entry.threatMultiplier === 1)).toBe(true);
    expect(result.coverage).toBeCloseTo(1, 12);
  });

  it('keeps all six enemy contributions in the auditable trace', () => {
    const service = new ThreatWeightedMatchupV1Service();
    const rows = ENEMY_HERO_IDS.map((enemyHeroId, index) =>
      row(800, enemyHeroId, 0.005 + index * 0.001, 1000 + index * 100),
    );

    const result = scoreItem(service, 800, rows);

    expect(result.usedCount).toBe(6);
    expect(result.contributions.map((entry: { enemyHeroId: number }) => entry.enemyHeroId)).toEqual(ENEMY_HERO_IDS);
  });
});
