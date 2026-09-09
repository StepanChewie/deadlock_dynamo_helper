import { AdaptiveEnemyLiveStateV1 } from '../src/statlocker-adaptive/adaptive-decision-state-v1.service';
import { EnemyThreatV1Service } from '../src/statlocker-adaptive/enemy-threat-v1.service';

function enemy(
  heroId: number,
  overrides: Partial<AdaptiveEnemyLiveStateV1> = {},
): AdaptiveEnemyLiveStateV1 {
  return {
    steamId: `enemy-${heroId}`,
    heroId,
    ...overrides,
  };
}

describe('EnemyThreatV1Service', () => {
  const service = new EnemyThreatV1Service();

  it('ranks a fed high-economy high-damage enemy above a behind enemy', () => {
    const result = service.scoreEnemies([
      enemy(2, {
        souls: 4000,
        heroDamage: 10000,
        kills: 2,
        assists: 2,
        deaths: 6,
        level: 9,
      }),
      enemy(1, {
        souls: 12000,
        heroDamage: 40000,
        kills: 8,
        assists: 10,
        deaths: 2,
        level: 15,
      }),
    ]);

    const fed = result.find((entry) => entry.heroId === 1)!;
    const behind = result.find((entry) => entry.heroId === 2)!;

    expect(fed.threatMultiplier).toBeGreaterThan(behind.threatMultiplier);
    expect(fed.components.souls).toMatchObject({
      rawValue: 12000,
      weight: 0.35,
      observed: true,
    });
    expect(fed.components.heroDamage.weight).toBe(0.3);
    expect(fed.components.killsAssists.weight).toBe(0.2);
    expect(fed.components.level.weight).toBe(0.1);
    expect(fed.components.deaths.weight).toBe(-0.05);
    expect(fed.components.souls.relativeValue).toBeGreaterThan(1);
    expect(fed.completeness).toBe(1);
  });

  it('does not let high KDA with weak souls and damage dominate stronger economy and damage', () => {
    const result = service.scoreEnemies([
      enemy(1, {
        souls: 4000,
        heroDamage: 9000,
        kills: 20,
        assists: 10,
        deaths: 1,
        level: 10,
      }),
      enemy(2, {
        souls: 9000,
        heroDamage: 30000,
        kills: 3,
        assists: 4,
        deaths: 4,
        level: 12,
      }),
    ]);

    const kdaLeader = result.find((entry) => entry.heroId === 1)!;
    const economyLeader = result.find((entry) => entry.heroId === 2)!;

    expect(economyLeader.threatMultiplier).toBeGreaterThan(kdaLeader.threatMultiplier);
  });

  it('returns a neutral multiplier when all live threat metrics are missing', () => {
    const result = service.scoreEnemies([enemy(2), enemy(1)]);

    expect(result.map((entry) => entry.heroId)).toEqual([1, 2]);
    for (const entry of result) {
      expect(entry.rawThreatScore).toBe(1);
      expect(entry.threatMultiplier).toBe(1);
      expect(entry.completeness).toBe(0);
      expect(entry.reasonCodes).toContain('NO_LIVE_THREAT_SIGNALS');
    }
  });

  it('clamps absurd outliers to the configured threat bounds', () => {
    const result = service.scoreEnemies([
      enemy(1, {
        souls: 1_000_000_000_000,
        heroDamage: 1_000_000_000_000,
        kills: 1_000_000,
        assists: 1_000_000,
        deaths: 0,
        level: 1_000_000,
      }),
      ...[2, 3, 4, 5, 6].map((heroId) => enemy(heroId, {
        souls: 0,
        heroDamage: 0,
        kills: 0,
        assists: 0,
        deaths: 100,
        level: 0,
      })),
    ]);

    const outlier = result.find((entry) => entry.heroId === 1)!;
    expect(outlier.threatMultiplier).toBe(1.5);
    expect(outlier.reasonCodes).toContain('THREAT_CLAMPED_HIGH');
    expect(result.some((entry) => entry.threatMultiplier === 0.75)).toBe(true);
    expect(result.every((entry) => entry.threatMultiplier >= 0.75 && entry.threatMultiplier <= 1.5)).toBe(true);
  });

  it('ignores invalid numeric signals, never emits NaN/Infinity, and is deterministic', () => {
    const a = enemy(1, {
      souls: Number.NaN,
      heroDamage: Number.POSITIVE_INFINITY,
      kills: -1,
      assists: 4,
      deaths: 2,
      level: 10,
    });
    const b = enemy(2, {
      souls: 5000,
      heroDamage: 12000,
      kills: 3,
      assists: 5,
      deaths: 3,
      level: 11,
    });

    const first = service.scoreEnemies([b, a]);
    const second = service.scoreEnemies([a, b]);

    expect(first).toEqual(second);
    for (const entry of first) {
      expect(Number.isFinite(entry.rawThreatScore)).toBe(true);
      expect(Number.isFinite(entry.threatMultiplier)).toBe(true);
      expect(Number.isFinite(entry.completeness)).toBe(true);
      for (const component of Object.values(entry.components)) {
        expect(Number.isFinite(component.contribution)).toBe(true);
        if (component.rawValue !== undefined) expect(Number.isFinite(component.rawValue)).toBe(true);
        if (component.teamMean !== undefined) expect(Number.isFinite(component.teamMean)).toBe(true);
        if (component.relativeValue !== undefined) expect(Number.isFinite(component.relativeValue)).toBe(true);
      }
    }
  });
});
