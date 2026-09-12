import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FullBuildMatchupProtectionV1Service } from '../src/statlocker-adaptive/full-build-matchup-protection-v1.service';
import {
  SellMatchupProtectionV1Config,
  STATLOCKER_BUILD_V2_CONFIG,
} from '../src/statlocker-adaptive/statlocker-build-v2.config';
import {
  aggregateStatlockerVsHeroWpaRowsV1,
  StatlockerVsHeroWpaAggregateSourceV1,
} from '../src/statlocker-adaptive/statlocker-vs-hero-wpa-repository-v1.service';
import { StatlockerVsHeroWpaRowNormalizerV1Service } from '../src/statlocker-adaptive/statlocker-vs-hero-wpa-row-normalizer-v1.service';

/**
 * Calibration for FullBuildMatchupProtectionV1Service from real captured
 * Statlocker VS_HERO_WPA aggregates. The captured sources carry aggregate
 * sample counts, mean WPA and delta WPA only - no account, player, or match
 * identifiers - and this spec re-derives every aggregate row through the
 * production normalization/aggregation path before reading any threshold off
 * the distribution. The thresholds encoded in statlocker-build-v2.config.ts
 * must be justified by the distribution computed here, never invented.
 */

interface CalibrationFixture {
  metadata: { sources: readonly string[]; statlockerPatchId: string };
  rows: StatlockerVsHeroWpaAggregateSourceV1[];
}

const CALIBRATION_PATH = 'fixtures/statlocker-vs-hero-wpa/sell-protection-calibration.json';
const RAW_VS_HERO_WPA_PATH = 'fixtures/statlocker-vs-hero-wpa-v1.json';
const BILLY_FIXTURE_PATH = 'fixtures/statlocker-build-v2/billy-real.fixture.json';
const BILLY_EXPECTED_PATH = 'fixtures/statlocker-build-v2/billy-real.expected.json';

// Hero 6 (Abrams) is the only hero in the raw VS_HERO_WPA capture; hero 72
// (Billy) is the captured e2e hero. These are the reference-data IDs the row
// normalizer resolves the captured names to.
const ABRAMS_HERO_ID = 6;
const BILLY_HERO_ID = 72;
const APOLLO_HERO_ID = 77;
const DYNAMO_HERO_ID = 11;
const BILLY_ENEMY_HERO_ID = 72;

// Billy's captured enemy roster for match 676255623445218601. The service caps
// requested enemies at five, so the production call evaluates [6,10,13,27,31].
const BILLY_ENEMY_ROSTER = [6, 10, 13, 27, 31, 35];
const BILLY_CAPPED_ROSTER = [6, 10, 13, 27, 31];

// The ten desired-state terminals the real Billy golden selects; each is a
// representative item the planner actually wants for this hero.
const BILLY_GOLDEN_TERMINAL_ITEM_IDS = [
  112198670, 1342610602, 98582110, 3791587546, 3190916303,
  1235347618, 3731635960, 1193964439, 2417568017, 1009965641,
] as const;

// Scourge (2417568017) has the single strongest one-enemy matchup in the
// captured Billy data (delta WPA 0.026 vs Yamato) and the weakest per-row
// sample counts, so it is the distribution's dilution/insufficiency probe.
const SCOURGE_ITEM_ID = 2417568017;
const YAMATO_HERO_ID = 27;

const ABRAMS_ARCANE_SURGE_ITEM_ID = 1150006784;

function loadJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, relativePath), 'utf8'));
}

function loadCalibrationFixture(): CalibrationFixture {
  return loadJson(CALIBRATION_PATH) as CalibrationFixture;
}

const HERO_ID_BY_CAPTURED_NAME: Record<string, number> = {
  Abrams: ABRAMS_HERO_ID,
  Apollo: APOLLO_HERO_ID,
  Dynamo: DYNAMO_HERO_ID,
  Billy: BILLY_ENEMY_HERO_ID,
};

const ITEM_ID_BY_CAPTURED_NAME: Record<string, number> = {
  'Arcane Surge': 1150006784,
  'Mystic Expansion': 754480263,
  'Close Quarters': 1342610602,
};

interface RawCapturedMatchupV1 {
  count: number;
  delta_wpa: number;
  mean_wpa?: number;
}

/** Raw captured by_patch/by_rank rows flattened into per-rank aggregate rows. */
function flattenRawVsHeroWpaRows(): StatlockerVsHeroWpaAggregateSourceV1[] {
  const raw = loadJson(RAW_VS_HERO_WPA_PATH) as {
    by_patch: Record<
      string,
      { by_rank: Record<string, { by_hero: Record<string, Record<string, Record<string, RawCapturedMatchupV1>>> }> }
    >;
  };
  const rows: StatlockerVsHeroWpaAggregateSourceV1[] = [];
  for (const patch of Object.keys(raw.by_patch)) {
    const byRank = raw.by_patch[patch].by_rank;
    for (const rank of Object.keys(byRank)) {
      const byHero = byRank[rank].by_hero;
      for (const heroName of Object.keys(byHero)) {
        const byItem = byHero[heroName];
        for (const itemName of Object.keys(byItem)) {
          const matchups = byItem[itemName];
          for (const enemyName of Object.keys(matchups)) {
            if (enemyName === '_baseline') continue;
            const matchup = matchups[enemyName];
            rows.push({
              heroId: HERO_ID_BY_CAPTURED_NAME[heroName],
              enemyHeroId: HERO_ID_BY_CAPTURED_NAME[enemyName],
              itemId: ITEM_ID_BY_CAPTURED_NAME[itemName],
              count: matchup.count,
              deltaWpa: matchup.delta_wpa,
              ...(matchup.mean_wpa === undefined ? {} : { meanWpa: matchup.mean_wpa }),
            });
          }
        }
      }
    }
  }
  return rows;
}

function billyCapturedRows(): StatlockerVsHeroWpaAggregateSourceV1[] {
  const fixture = loadJson(BILLY_FIXTURE_PATH) as {
    vsHeroWpaRows: StatlockerVsHeroWpaAggregateSourceV1[];
  };
  return fixture.vsHeroWpaRows.map((row) => ({ ...row }));
}

interface DistributionPoint {
  heroId: number;
  itemId: number;
  enemyHeroIds: readonly number[];
  teamWpaPct: number;
  confidence: number;
}

function lineupSubsets(enemyHeroIds: readonly number[]): number[][] {
  const subsets: number[][] = [];
  for (let mask = 1; mask < 2 ** enemyHeroIds.length; mask += 1) {
    subsets.push(enemyHeroIds.filter((_, index) => mask & (1 << index)));
  }
  return subsets;
}

describe('Full-build sell matchup protection calibration', () => {
  const service = new FullBuildMatchupProtectionV1Service();

  function evaluateDiagnostics(
    heroId: number,
    itemId: number,
    enemyHeroIds: readonly number[],
    rows: readonly StatlockerVsHeroWpaAggregateSourceV1[],
  ): { teamWpaPct: number; confidence: number } {
    const result = service.evaluate(
      { ourHeroId: heroId, itemId, enemyHeroIds, rows },
      { enabled: false, shrinkK: 500 },
    );
    return { teamWpaPct: result.teamWpaPct, confidence: result.confidence };
  }

  it('stores aggregates only, with no user-specific fields', () => {
    const fixture = loadCalibrationFixture();
    expect(fixture.metadata.statlockerPatchId).toBe('676255623445218601');
    expect(fixture.rows.length).toBeGreaterThan(0);
    const allowedKeys = new Set(['heroId', 'enemyHeroId', 'itemId', 'count', 'deltaWpa', 'meanWpa']);
    for (const row of fixture.rows) {
      for (const key of Object.keys(row)) {
        expect(allowedKeys.has(key)).toBe(true);
      }
      expect(Number.isInteger(row.count)).toBe(true);
      expect(row.count).toBeGreaterThan(0);
      expect(Number.isFinite(row.deltaWpa)).toBe(true);
    }
  });

  it('re-derives every calibration row from the captured raw sources through the production aggregation', () => {
    const fixture = loadCalibrationFixture();
    const flattenedRaw = flattenRawVsHeroWpaRows();
    const normalized = new StatlockerVsHeroWpaRowNormalizerV1Service().normalize(
      loadJson(RAW_VS_HERO_WPA_PATH),
      {
        snapshotId: 'calibration-derivation',
        statlockerPatchId: '676255623445218601',
        rulesetVersion: 'client-6686',
        catalogSha256: 'a'.repeat(64),
      },
    );
    // The production normalizer must resolve every captured raw matchup the
    // flatten above found, so both derivations describe the same source rows.
    expect(normalized).toHaveLength(flattenedRaw.length);

    const derived = aggregateStatlockerVsHeroWpaRowsV1([
      ...normalized.map((row) => ({
        heroId: row.heroId,
        enemyHeroId: row.enemyHeroId,
        itemId: row.itemId,
        count: row.count,
        deltaWpa: row.deltaWpa,
        ...(row.meanWpa === undefined ? {} : { meanWpa: row.meanWpa }),
      })),
      ...billyCapturedRows(),
    ]);

    expect(derived).toHaveLength(fixture.rows.length);
    const derivedByKey = new Map(
      derived.map((row) => [`${row.heroId}:${row.enemyHeroId}:${row.itemId}`, row]),
    );
    for (const row of fixture.rows) {
      const match = derivedByKey.get(`${row.heroId}:${row.enemyHeroId}:${row.itemId}`);
      expect(match).toBeDefined();
      expect(match?.count).toBe(row.count);
      expect(match?.deltaWpa).toBeCloseTo(row.deltaWpa, 12);
      expect(match?.meanWpa).toBeCloseTo(row.meanWpa ?? 0, 12);
    }
  });

  describe('captured team WPA and confidence distribution', () => {
    const rows = loadCalibrationFixture().rows;
    const hero6Rows = rows.filter((row) => row.heroId === ABRAMS_HERO_ID);
    const hero72Rows = rows.filter((row) => row.heroId === BILLY_HERO_ID);

    function collect(
      heroId: number,
      itemIds: readonly number[],
      lineups: readonly (readonly number[])[],
    ): DistributionPoint[] {
      const points: DistributionPoint[] = [];
      for (const itemId of itemIds) {
        for (const enemyHeroIds of lineups) {
          const { teamWpaPct, confidence } = evaluateDiagnostics(heroId, itemId, enemyHeroIds, rows);
          points.push({ heroId, itemId, enemyHeroIds, teamWpaPct, confidence });
        }
      }
      return points;
    }

    it('places every full-roster Billy evaluation in a bounded confidence band', () => {
      const points = collect(
        BILLY_HERO_ID,
        BILLY_GOLDEN_TERMINAL_ITEM_IDS,
        [BILLY_ENEMY_ROSTER, ...lineupSubsets(BILLY_CAPPED_ROSTER)],
      );
      const fullRoster = points.filter(
        (point) => point.enemyHeroIds.length === BILLY_ENEMY_ROSTER.length,
      );
      expect(fullRoster).toHaveLength(BILLY_GOLDEN_TERMINAL_ITEM_IDS.length);

      // Captured full-roster confidence, ascending: Scourge 0.396 (smallest
      // counts), Weighted Shots 0.417, Dispel Magic 0.509 ... Stalker-side
      // items up to Spirit Snatch 0.759.
      const confidences = fullRoster.map((point) => point.confidence).sort((a, b) => a - b);
      expect(confidences[0]).toBeCloseTo(0.396332, 5);
      expect(confidences[1]).toBeCloseTo(0.417490, 5);
      expect(confidences[2]).toBeCloseTo(0.509461, 5);
      expect(confidences[confidences.length - 1]).toBeCloseTo(0.759296, 5);
    });

    it('splits full-roster team WPA into a noise cluster and a positive cluster with a reviewable gap', () => {
      const points = collect(
        BILLY_HERO_ID,
        BILLY_GOLDEN_TERMINAL_ITEM_IDS,
        [BILLY_ENEMY_ROSTER],
      );
      const teamWpa = points.map((point) => point.teamWpaPct).sort((a, b) => a - b);
      expect(teamWpa).toHaveLength(BILLY_GOLDEN_TERMINAL_ITEM_IDS.length);

      // Captured spread, ascending: Weighted Shots -0.0029, Battle Vest
      // -0.0002, Dispel Magic -0.000003, Spirit Snatch 0.0006, Scourge 0.0008,
      // Spirit Shielding 0.0010, Monster Rounds 0.0011 | Greater Expansion
      // 0.0018, Close Quarters 0.0022, Stalker 0.0027.
      expect(teamWpa[0]).toBeCloseTo(-0.002858, 5);
      expect(teamWpa[6]).toBeCloseTo(0.001105, 5);
      expect(teamWpa[7]).toBeCloseTo(0.001847, 5);
      expect(teamWpa[9]).toBeCloseTo(0.002663, 5);

      // The positive cluster starts at Greater Expansion; everything up to
      // Monster Rounds has mixed-sign per-enemy evidence. The calibrated
      // threshold must sit inside that gap.
      expect(teamWpa[6]).toBeLessThan(teamWpa[7]);
      for (let index = 0; index <= 6; index += 1) expect(teamWpa[index]).toBeLessThanOrEqual(teamWpa[6] + 1e-12);
      for (let index = 7; index < teamWpa.length; index += 1) expect(teamWpa[index]).toBeGreaterThanOrEqual(teamWpa[7] - 1e-12);
    });

    it('shows a single strong enemy matchup does not survive the team aggregate', () => {
      const alone = evaluateDiagnostics(BILLY_HERO_ID, SCOURGE_ITEM_ID, [YAMATO_HERO_ID], rows);
      const fullRoster = evaluateDiagnostics(BILLY_HERO_ID, SCOURGE_ITEM_ID, BILLY_ENEMY_ROSTER, rows);

      // Scourge vs Yamato alone is by far the strongest captured matchup.
      expect(alone.teamWpaPct).toBeGreaterThan(0.02);
      // Across the whole captured roster the same item aggregates to noise.
      expect(fullRoster.teamWpaPct).toBeLessThan(0.001);
      expect(fullRoster.teamWpaPct).toBeCloseTo(0.000773, 5);
    });

    it('keeps thinly sampled single-enemy evidence far below the full-roster confidence band', () => {
      // Apollo has only 100 captured samples for Arcane Surge: row weight
      // 100/600 with shrinkK 500, so confidence 0.1667 - the captured floor.
      const thin = evaluateDiagnostics(
        ABRAMS_HERO_ID,
        ABRAMS_ARCANE_SURGE_ITEM_ID,
        [APOLLO_HERO_ID],
        hero6Rows,
      );
      expect(thin.confidence).toBeCloseTo(100 / 600, 12);

      const billyBand = collect(
        BILLY_HERO_ID,
        BILLY_GOLDEN_TERMINAL_ITEM_IDS,
        [BILLY_ENEMY_ROSTER],
      ).map((point) => point.confidence);
      expect(Math.min(...billyBand)).toBeGreaterThan(thin.confidence + 0.2);
    });

    it('protects every Abrams full-team item whose captured evidence is consistently positive', () => {
      const points = collect(ABRAMS_HERO_ID, [754480263, 1150006784, 1342610602], [
        [APOLLO_HERO_ID, DYNAMO_HERO_ID, BILLY_ENEMY_HERO_ID],
      ]);
      const teamWpa = points.map((point) => point.teamWpaPct).sort((a, b) => a - b);
      // Captured Abrams full-team aggregates: 0.003079 / 0.003138 / 0.003643 -
      // all above the Billy positive cluster, all consistently positive.
      expect(teamWpa[0]).toBeCloseTo(0.003079, 5);
      expect(teamWpa[2]).toBeCloseTo(0.003643, 5);
      for (const point of points) {
        expect(point.confidence).toBeGreaterThan(0.5);
      }
    });
  });

  describe('calibrated production thresholds', () => {
    const rows = loadCalibrationFixture().rows;

    it('selects minTeamWpaPct and minConfidence inside the captured distribution gaps', () => {
      const config = STATLOCKER_BUILD_V2_CONFIG.sellMatchupProtection;
      expect(config.enabled).toBe(true);
      if (!config.enabled) return;

      // Team WPA gap between the mixed-sign noise cluster (max: Monster Rounds
      // 0.001105) and the consistently positive cluster (min: Greater
      // Expansion 0.001847).
      const monsterRoundsTeamWpa = evaluateDiagnostics(BILLY_HERO_ID, 1009965641, BILLY_ENEMY_ROSTER, rows).teamWpaPct;
      const greaterExpansionTeamWpa = evaluateDiagnostics(BILLY_HERO_ID, 1193964439, BILLY_ENEMY_ROSTER, rows).teamWpaPct;
      expect(config.minTeamWpaPct).toBeGreaterThan(monsterRoundsTeamWpa);
      expect(config.minTeamWpaPct).toBeLessThan(greaterExpansionTeamWpa);
      // Confidence gap between the two weakest full-roster evidence rows
      // (Scourge 0.396, Weighted Shots 0.417) and the next weakest (Dispel
      // Magic 0.509); the thin 100-sample row sits at 0.1667, far below all.
      const scourgeConfidence = evaluateDiagnostics(BILLY_HERO_ID, 2417568017, BILLY_ENEMY_ROSTER, rows).confidence;
      const weightedShotsConfidence = evaluateDiagnostics(BILLY_HERO_ID, 3791587546, BILLY_ENEMY_ROSTER, rows).confidence;
      const dispelMagicConfidence = evaluateDiagnostics(BILLY_HERO_ID, 3731635960, BILLY_ENEMY_ROSTER, rows).confidence;
      expect(config.minConfidence).toBeGreaterThan(weightedShotsConfidence);
      expect(config.minConfidence).toBeLessThan(dispelMagicConfidence);
      expect(scourgeConfidence).toBeLessThan(weightedShotsConfidence);
      expect(config.shrinkK).toBe(500);
    });

    it('protects exactly the captured full-roster items the distribution supports for Billy', () => {
      const config: SellMatchupProtectionV1Config = STATLOCKER_BUILD_V2_CONFIG.sellMatchupProtection;
      const protectedItemIds: number[] = [];
      const insufficientItemIds: number[] = [];
      const belowThresholdItemIds: number[] = [];
      for (const itemId of BILLY_GOLDEN_TERMINAL_ITEM_IDS) {
        const result = service.evaluate(
          { ourHeroId: BILLY_HERO_ID, itemId, enemyHeroIds: BILLY_ENEMY_ROSTER, rows },
          config,
        );
        if (result.protected) {
          protectedItemIds.push(itemId);
          expect(result.reasonCodes).toContain('MATCHUP_PROTECTED');
        } else if (result.reasonCodes.includes('INSUFFICIENT_MATCHUP_EVIDENCE')) {
          insufficientItemIds.push(itemId);
        } else {
          belowThresholdItemIds.push(itemId);
        }
      }

      // Stalker (0.002663), Close Quarters (0.002245) and Greater Expansion
      // (0.001847) clear both calibrated gates; the remaining seven do not.
      expect(protectedItemIds.sort((a, b) => a - b)).toEqual([98582110, 1193964439, 1342610602]);
      // Scourge (confidence 0.396) and Weighted Shots (confidence 0.417) lack
      // the evidence strength the calibration requires.
      expect(insufficientItemIds.sort((a, b) => a - b)).toEqual([2417568017, 3791587546]);
      // Monster Rounds, Spirit Snatch, Battle Vest, Dispel Magic and Spirit
      // Shielding have strong-enough evidence but noise-level team WPA.
      expect(belowThresholdItemIds.sort((a, b) => a - b)).toEqual([
        112198670, 1009965641, 1235347618, 3190916303, 3731635960,
      ]);
    });

    it('protects the consistently positive Abrams full-team evidence once calibrated', () => {
      for (const itemId of [754480263, 1150006784, 1342610602]) {
        const result = service.evaluate(
          {
            ourHeroId: ABRAMS_HERO_ID,
            itemId,
            enemyHeroIds: [APOLLO_HERO_ID, DYNAMO_HERO_ID, BILLY_ENEMY_HERO_ID],
            rows,
          },
          STATLOCKER_BUILD_V2_CONFIG.sellMatchupProtection,
        );
        expect(result.protected).toBe(true);
        expect(result.reasonCodes).toContain('MATCHUP_PROTECTED');
      }
    });

    it('leaves the thinly sampled single-enemy row unprotected with an insufficiency code', () => {
      const result = service.evaluate(
        {
          ourHeroId: ABRAMS_HERO_ID,
          itemId: ABRAMS_ARCANE_SURGE_ITEM_ID,
          enemyHeroIds: [APOLLO_HERO_ID],
          rows,
        },
        STATLOCKER_BUILD_V2_CONFIG.sellMatchupProtection,
      );
      expect(result.protected).toBe(false);
      expect(result.reasonCodes).toEqual(['INSUFFICIENT_MATCHUP_EVIDENCE']);
    });
  });
});
