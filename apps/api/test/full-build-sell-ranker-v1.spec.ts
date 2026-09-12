import {
  FullBuildSellCandidateV1,
  FullBuildSellRankerV1Service,
} from '../src/statlocker-adaptive/full-build-sell-ranker-v1.service';
import { StatlockerHeroItemLifecycleV1 } from '../src/statlocker-adaptive/statlocker-adaptive.types';

function candidate(
  itemId: number,
  generalWpa: number,
  averagePurchaseTimeS: number,
): FullBuildSellCandidateV1 {
  return { itemId, generalWpa, averagePurchaseTimeS };
}

function distributionRow(
  itemId: number,
  generalWpa: number,
  averagePurchaseTimeS: number,
): StatlockerHeroItemLifecycleV1 {
  return { heroId: 10, itemId, generalWpa, averagePurchaseTimeS };
}

describe('FullBuildSellRankerV1Service', () => {
  const service = new FullBuildSellRankerV1Service();

  it('ranks a dominating earlier/lower-WPA item ahead of a dominated later/higher-WPA item regardless of tie-break', () => {
    // Item 1 is earlier AND lower-WPA than item 2, so it dominates outright
    // and sits on front 0 while item 2 is peeled onto front 1, no matter how
    // tie-break scores would have ordered them.
    const result = service.rank(
      [candidate(2, 0.2, 200), candidate(1, 0.1, 100)],
      [
        distributionRow(101, 0.1, 100),
        distributionRow(102, 0.2, 200),
        distributionRow(103, 0.3, 300),
      ],
    );

    expect(result).toHaveLength(2);
    expect(result[0].itemId).toBe(1);
    expect(result[0].paretoFront).toBe(0);
    expect(result[1].itemId).toBe(2);
    expect(result[1].paretoFront).toBe(1);
    // With the three-row distribution the dominating item is the best on both
    // coordinates and the dominated item sits mid-distribution on both.
    expect(result[0].timeSellPercentile).toBeCloseTo(1, 12);
    expect(result[0].wpaSellPercentile).toBeCloseTo(1, 12);
    expect(result[1].timeSellPercentile).toBeCloseTo(0.5, 12);
    expect(result[1].wpaSellPercentile).toBeCloseTo(0.5, 12);
  });

  it('orders two Pareto-incomparable candidates by the 50/50 percentile blend', () => {
    // Item 1 has lower WPA but buys later; item 2 buys earlier but has higher
    // WPA: neither dominates, so both share front 0 and the 50/50 blend of
    // the two sell percentiles decides. The distribution is asymmetric so the
    // blend is decisive rather than the raw coordinates.
    const result = service.rank(
      [candidate(1, 0.1, 200), candidate(2, 0.2, 100)],
      [
        distributionRow(201, 0.05, 50),
        distributionRow(202, 0.08, 100),
        distributionRow(203, 0.1, 150),
        distributionRow(204, 0.2, 200),
        distributionRow(205, 0.9, 800),
      ],
    );

    expect(result).toHaveLength(2);
    expect(result[0].paretoFront).toBe(0);
    expect(result[1].paretoFront).toBe(0);
    // Item 1: time 200 -> midrank 3 -> 1 - 3/4 = 0.25; WPA 0.10 -> midrank 2
    // -> 0.5; blend = 0.375. Item 2: time 100 -> 0.75; WPA 0.20 -> 0.25;
    // blend = 0.5, so the earlier buyer wins the front.
    expect(result[0].itemId).toBe(2);
    expect(result[0].tieBreakScore).toBeCloseTo(0.5, 12);
    expect(result[1].itemId).toBe(1);
    expect(result[1].tieBreakScore).toBeCloseTo(0.375, 12);
  });

  it('gives equal raw coordinates equal percentiles and breaks the tie by item id', () => {
    // Both candidates share the exact same coordinates, so neither dominates
    // (no strict comparison), both percentiles are identical, and the item id
    // is the final deterministic tie-break inside the shared front.
    const result = service.rank(
      [candidate(7, 0.1, 100), candidate(3, 0.1, 100)],
      [
        distributionRow(101, 0.1, 100),
        distributionRow(102, 0.2, 200),
        distributionRow(103, 0.3, 300),
      ],
    );

    expect(result).toHaveLength(2);
    expect(result[0].itemId).toBe(3);
    expect(result[1].itemId).toBe(7);
    expect(result[0].paretoFront).toBe(0);
    expect(result[1].paretoFront).toBe(0);
    expect(result[0].timeSellPercentile).toBeCloseTo(result[1].timeSellPercentile, 12);
    expect(result[0].wpaSellPercentile).toBeCloseTo(result[1].wpaSellPercentile, 12);
    expect(result[0].tieBreakScore).toBeCloseTo(result[1].tieBreakScore, 12);
  });

  it('shares one tie-aware midrank percentile across duplicated distribution values', () => {
    // WPA 0.10 appears twice in the distribution, so both observations share
    // the midrank (0 + 1) / 2 = 0.5 and any candidate at 0.10 earns
    // 1 - 0.5 / 2 = 0.75, halfway between the lowest (1) and the 0.20 value (0).
    const result = service.rank(
      [candidate(1, 0.1, 100), candidate(2, 0.2, 100)],
      [
        distributionRow(301, 0.1, 100),
        distributionRow(302, 0.1, 200),
        distributionRow(303, 0.2, 300),
      ],
    );

    const first = result.find((row) => row.itemId === 1);
    const second = result.find((row) => row.itemId === 2);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first!.wpaSellPercentile).toBeCloseTo(0.75, 12);
    expect(second!.wpaSellPercentile).toBeCloseTo(0, 12);
  });

  it('computes percentiles against the full hero distribution rather than the held subset', () => {
    // Only two of the five distribution items are held as candidates. If the
    // percentiles were computed over the held subset alone, item 1 would be
    // the earliest/lowest-WPA observation (percentile 1) and item 2 the worst
    // (percentile 0); against the full five-row distribution they land
    // strictly inside the range instead.
    const result = service.rank(
      [candidate(1, 0.1, 100), candidate(2, 0.3, 300)],
      [
        distributionRow(401, 0.02, 50),
        distributionRow(402, 0.05, 100),
        distributionRow(403, 0.1, 200),
        distributionRow(404, 0.3, 300),
        distributionRow(405, 0.5, 400),
      ],
    );

    expect(result).toHaveLength(2);
    const first = result.find((row) => row.itemId === 1)!;
    const second = result.find((row) => row.itemId === 2)!;
    expect(first.timeSellPercentile).toBeCloseTo(0.75, 12);
    expect(first.wpaSellPercentile).toBeCloseTo(0.5, 12);
    expect(second.timeSellPercentile).toBeCloseTo(0.25, 12);
    expect(second.wpaSellPercentile).toBeCloseTo(0.25, 12);
  });
});
