import { EnemyThreatHistoryV1Service } from '../src/statlocker-adaptive/enemy-threat-history-v1.service';
import { EnemyThreatScoreV1 } from '../src/statlocker-adaptive/enemy-threat-v1.service';

function score(
  heroId: number,
  threatMultiplier: number,
  steamId = `steam-${heroId}`,
): EnemyThreatScoreV1 {
  const component = {
    weight: 0,
    contribution: 0,
    observed: false,
  };
  return {
    steamId,
    heroId,
    rawThreatScore: threatMultiplier,
    threatMultiplier,
    completeness: 1,
    components: {
      souls: { ...component },
      heroDamage: { ...component },
      killsAssists: { ...component },
      level: { ...component },
      deaths: { ...component },
    },
    reasonCodes: [],
  };
}

describe('EnemyThreatHistoryV1Service', () => {
  it('passes through the first observation and applies configured EMA afterwards', () => {
    const service = new EnemyThreatHistoryV1Service();

    const first = service.update({
      matchId: 'match-a',
      scores: [score(1, 1.5)],
      alpha: 0.25,
    });
    const second = service.update({
      matchId: 'match-a',
      scores: [score(1, 0.75)],
      alpha: 0.25,
    });

    expect(first[0].smoothedThreatMultiplier).toBeCloseTo(1.5, 12);
    expect(first[0].previousThreatMultiplier).toBeUndefined();
    expect(second[0].previousThreatMultiplier).toBeCloseTo(1.5, 12);
    expect(second[0].smoothedThreatMultiplier).toBeCloseTo(1.3125, 12);
    expect(second[0].alpha).toBe(0.25);
  });

  it('keeps smoothing history isolated per match', () => {
    const service = new EnemyThreatHistoryV1Service();

    service.update({
      matchId: 'match-a',
      scores: [score(1, 1.5)],
      alpha: 0.5,
    });
    const otherMatch = service.update({
      matchId: 'match-b',
      scores: [score(1, 0.75)],
      alpha: 0.5,
    });

    expect(otherMatch[0].previousThreatMultiplier).toBeUndefined();
    expect(otherMatch[0].smoothedThreatMultiplier).toBeCloseTo(0.75, 12);
  });

  it('clamps current and smoothed values to the threat multiplier bounds', () => {
    const service = new EnemyThreatHistoryV1Service();

    const high = service.update({
      matchId: 'match-a',
      scores: [score(1, 100)],
      alpha: 0.5,
    });
    const low = service.update({
      matchId: 'match-a',
      scores: [score(1, -100)],
      alpha: 1,
    });

    expect(high[0].smoothedThreatMultiplier).toBe(1.5);
    expect(low[0].smoothedThreatMultiplier).toBe(0.75);
  });

  it('returns deterministic enemy ordering', () => {
    const service = new EnemyThreatHistoryV1Service();

    const result = service.update({
      matchId: 'match-a',
      scores: [
        score(2, 1.1, 'steam-b'),
        score(1, 0.9, 'steam-z'),
        score(1, 1.2, 'steam-a'),
      ],
      alpha: 0.5,
    });

    expect(result.map((entry) => `${entry.score.heroId}:${entry.score.steamId}`)).toEqual([
      '1:steam-a',
      '1:steam-z',
      '2:steam-b',
    ]);
  });

  it('clears ephemeral state for a completed match', () => {
    const service = new EnemyThreatHistoryV1Service();

    service.update({
      matchId: 'match-a',
      scores: [score(1, 1.5)],
      alpha: 0.5,
    });
    service.clearMatch('match-a');
    const afterClear = service.update({
      matchId: 'match-a',
      scores: [score(1, 0.75)],
      alpha: 0.5,
    });

    expect(afterClear[0].previousThreatMultiplier).toBeUndefined();
    expect(afterClear[0].smoothedThreatMultiplier).toBeCloseTo(0.75, 12);
  });

  it('rejects invalid smoothing alpha instead of silently guessing', () => {
    const service = new EnemyThreatHistoryV1Service();

    expect(() => service.update({
      matchId: 'match-a',
      scores: [score(1, 1)],
      alpha: 0,
    })).toThrow('Enemy threat smoothing alpha must be in (0, 1]');
  });
});
