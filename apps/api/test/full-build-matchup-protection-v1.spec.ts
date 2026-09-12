import { FullBuildMatchupProtectionV1Service } from '../src/statlocker-adaptive/full-build-matchup-protection-v1.service';
import {
  SellMatchupProtectionV1Config,
  STATLOCKER_BUILD_V2_CONFIG,
} from '../src/statlocker-adaptive/statlocker-build-v2.config';
import { StatlockerVsHeroWpaAggregateSourceV1 } from '../src/statlocker-adaptive/statlocker-vs-hero-wpa-repository-v1.service';

const disabledConfig: SellMatchupProtectionV1Config = { enabled: false, shrinkK: 500 };
const enabledConfig: SellMatchupProtectionV1Config = {
  enabled: true,
  shrinkK: 500,
  minTeamWpaPct: 0.10,
  minConfidence: 0.30,
};

function row(
  heroId: number,
  enemyHeroId: number,
  itemId: number,
  count: number,
  deltaWpa: number,
): StatlockerVsHeroWpaAggregateSourceV1 {
  return { heroId, enemyHeroId, itemId, count, deltaWpa };
}

function input(
  enemyHeroIds: number[],
  rows: StatlockerVsHeroWpaAggregateSourceV1[],
) {
  return { ourHeroId: 10, itemId: 100, enemyHeroIds, rows };
}

describe('FullBuildMatchupProtectionV1Service', () => {
  const service = new FullBuildMatchupProtectionV1Service();

  it('weights every available enemy row with no three-matchup cap', () => {
    // All five rows use count 500 with shrinkK 500, so each rowWeight is 0.5
    // and the weighted team mean equals the plain mean of all five wpa values.
    const result = service.evaluate(
      input(
        [20, 21, 22, 23, 24],
        [
          row(10, 20, 100, 500, 0.10),
          row(10, 21, 100, 500, 0.08),
          row(10, 22, 100, 500, 0.06),
          row(10, 23, 100, 500, 0.04),
          row(10, 24, 100, 500, 0.02),
        ],
      ),
      enabledConfig,
    );

    expect(result.coveredEnemyHeroIds).toEqual([20, 21, 22, 23, 24]);
    expect(result.coveredEnemyHeroIds).toHaveLength(5);
    // A top-three cap would average 0.10/0.08/0.06 into 0.08; the full team
    // mean of 0.06 proves all five rows participate.
    expect(result.teamWpaPct).toBeCloseTo(0.06, 12);
    expect(result.confidence).toBeCloseTo(0.5, 12);
  });

  it('does not protect when one huge positive matchup is diluted below the team threshold', () => {
    // Enemy 20: wpa 0.60 with count 100 (weight 100/600 = 1/6). Enemies 21-24:
    // wpa 0.02 with count 500 (weight 0.5 each). The weighted team aggregate
    // is (0.60*(1/6) + 0.02*2.0) / (1/6 + 2.0) = 0.84/13 ~= 0.0646 < 0.10.
    const result = service.evaluate(
      input(
        [20, 21, 22, 23, 24],
        [
          row(10, 20, 100, 100, 0.60),
          row(10, 21, 100, 500, 0.02),
          row(10, 22, 100, 500, 0.02),
          row(10, 23, 100, 500, 0.02),
          row(10, 24, 100, 500, 0.02),
        ],
      ),
      enabledConfig,
    );

    expect(result.teamWpaPct).toBeCloseTo(0.84 / 13, 12);
    expect(result.confidence).toBeCloseTo(13 / 30, 12);
    expect(result.protected).toBe(false);
    expect(result.reasonCodes).not.toContain('MATCHUP_PROTECTED');
    // Confidence 13/30 >= minConfidence, so the failure is the team WPA
    // threshold, not missing evidence.
    expect(result.reasonCodes).not.toContain('INSUFFICIENT_MATCHUP_EVIDENCE');
  });

  it('keeps raw sample counts from scaling row weights, bounded at 1', () => {
    const modest = service.evaluate(
      input([20], [row(10, 20, 100, 10_000, 0.40)]),
      enabledConfig,
    );
    const huge = service.evaluate(
      input([20], [row(10, 20, 100, 1_000_000, 0.40)]),
      enabledConfig,
    );

    // confidence == rowWeight here: coverage is 1 and a single covered enemy
    // makes meanEvidenceStrength equal to that row's weight.
    expect(modest.confidence).toBeCloseTo(10_000 / 10_500, 12);
    expect(huge.confidence).toBeCloseTo(1_000_000 / 1_000_500, 12);
    expect(modest.confidence).toBeLessThan(1);
    expect(huge.confidence).toBeLessThan(1);
    // 100x the raw count must not buy 100x the weight: 0.9995/0.9524 ~= 1.05.
    expect(huge.confidence / modest.confidence).toBeLessThan(1.1);
    expect(huge.confidence).toBeGreaterThan(modest.confidence);
  });

  it('computes confidence as coverage times mean evidence strength with missing enemies', () => {
    // Five enemies requested, only two covered. Each covered row has count
    // 500, so rowWeight = 500/1000 = 0.5: coverage 2/5, meanEvidenceStrength
    // 0.5, confidence 0.2.
    const result = service.evaluate(
      input(
        [20, 21, 22, 23, 24],
        [
          row(10, 20, 100, 500, 0.10),
          row(10, 21, 100, 500, 0.20),
        ],
      ),
      enabledConfig,
    );

    expect(result.coveredEnemyHeroIds).toEqual([20, 21]);
    expect(result.teamWpaPct).toBeCloseTo(0.15, 12);
    expect(result.confidence).toBeCloseTo(0.2, 12);
    expect(result.protected).toBe(false);
    expect(result.reasonCodes).toContain('INSUFFICIENT_MATCHUP_EVIDENCE');
  });

  it('returns diagnostics without protection while the config is uncalibrated', () => {
    const rows = [
      row(10, 20, 100, 1000, 0.50),
      row(10, 21, 100, 1000, 0.50),
    ];

    const disabled = service.evaluate(input([20, 21], rows), disabledConfig);
    expect(disabled.teamWpaPct).toBeCloseTo(0.50, 12);
    expect(disabled.confidence).toBeCloseTo(2 / 3, 12);
    expect(disabled.coveredEnemyHeroIds).toEqual([20, 21]);
    expect(disabled.protected).toBe(false);
    expect(disabled.reasonCodes).toEqual(['MATCHUP_PROTECTION_UNCALIBRATED']);

    // The same evidence would protect once calibrated, isolating the flag as
    // the only difference.
    const enabled = service.evaluate(input([20, 21], rows), enabledConfig);
    expect(enabled.protected).toBe(true);
    expect(enabled.reasonCodes).toContain('MATCHUP_PROTECTED');
  });

  it('de-duplicates requested enemies, caps the team at five, and ignores out-of-set rows', () => {
    const result = service.evaluate(
      input(
        [30, 31, 30, 32, 33, 34, 35],
        [
          row(10, 30, 100, 500, 0.02),
          row(10, 31, 100, 500, 0.02),
          row(10, 32, 100, 500, 0.02),
          row(10, 33, 100, 500, 0.02),
          row(10, 34, 100, 500, 0.02),
          // Enemy 35 falls outside the first-five requested set, and the
          // remaining rows belong to another hero or another item entirely.
          row(10, 35, 100, 100_000, 0.90),
          row(10, 30, 999, 50_000, 0.90),
          row(11, 30, 100, 50_000, 0.90),
        ],
      ),
      enabledConfig,
    );

    expect(result.coveredEnemyHeroIds).toEqual([30, 31, 32, 33, 34]);
    expect(result.teamWpaPct).toBeCloseTo(0.02, 12);
    expect(result.confidence).toBeCloseTo(0.5, 12);
  });

  it('treats an empty enemy team as zero confidence without an insufficiency code', () => {
    const result = service.evaluate(
      input([], [row(10, 20, 100, 500, 0.10)]),
      enabledConfig,
    );

    expect(result.teamWpaPct).toBe(0);
    expect(result.confidence).toBe(0);
    expect(result.coveredEnemyHeroIds).toEqual([]);
    expect(result.protected).toBe(false);
    expect(result.reasonCodes).toEqual([]);
  });

  it('reports insufficient evidence when enemies are requested but no rows cover them', () => {
    const result = service.evaluate(input([20, 21], []), enabledConfig);

    expect(result.teamWpaPct).toBe(0);
    expect(result.confidence).toBe(0);
    expect(result.coveredEnemyHeroIds).toEqual([]);
    expect(result.protected).toBe(false);
    expect(result.reasonCodes).toEqual(['INSUFFICIENT_MATCHUP_EVIDENCE']);
  });

  it('takes its thresholds only from the injected config union', () => {
    // The checked-in state ships disabled with the exact-enemy prior reused.
    expect(STATLOCKER_BUILD_V2_CONFIG.sellMatchupProtection).toEqual({
      enabled: false,
      shrinkK: 500,
    });
  });
});
