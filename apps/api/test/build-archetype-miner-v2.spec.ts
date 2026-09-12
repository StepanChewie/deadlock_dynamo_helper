import { BuildDecisionTraceCollectorV2 } from '../src/statlocker-adaptive/build-decision-trace-v2';
import { BuildArchetypeMinerV2Service } from '../src/statlocker-adaptive/build-archetype-miner-v2.service';
import { StatlockerBuildProfileItemV2, StatlockerBuildProfileV2 } from '../src/statlocker-adaptive/build-archetype-v2';

const A = 101;
const B = 102;
const C = 103;
const D = 104;
const E = 105;
const F = 106;
const X = 201;
const Y = 202;
const Z = 203;

function profile(
  accountId: string,
  orderedItemIds: readonly number[],
  options: { flexItemIds?: readonly number[] } = {},
): StatlockerBuildProfileV2 {
  const flex = new Set(options.flexItemIds ?? []);
  const items: StatlockerBuildProfileItemV2[] = orderedItemIds.map((itemId, index) => ({
    itemId,
    familyId: itemId,
    purchaseRate: flex.has(itemId) ? 0.35 : 0.9,
    medianBuyTimeS: 300 + index * 240,
    frequencyTier: flex.has(itemId) ? 'FLEX' : 'CORE',
    phase: index < 2 ? 'EARLY' : index < 4 ? 'MID' : 'LATE',
    relationships: [],
  }));
  return { accountId, heroId: 72, items };
}

function coherentProfiles(count: number): StatlockerBuildProfileV2[] {
  return Array.from({ length: count }, (_, index) => profile(`core-${index + 1}`, [A, B, C, D]));
}

describe('BuildArchetypeMinerV2Service', () => {
  const miner = new BuildArchetypeMinerV2Service();

  it('keeps order-only variation in one archetype', () => {
    const result = miner.mine([
      profile('p1', [A, B, C, D]),
      profile('p2', [A, C, B, D]),
      profile('p3', [A, B, D, C]),
    ]);

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].profileAccountIds).toEqual(['p1', 'p2', 'p3']);
  });

  it('keeps a situational alternative inside one archetype', () => {
    const result = miner.mine([
      profile('p1', [A, B, C, D, E], { flexItemIds: [E] }),
      profile('p2', [A, B, C, D, F], { flexItemIds: [F] }),
      profile('p3', [A, B, C, D, E], { flexItemIds: [E] }),
      profile('p4', [A, B, C, D, F], { flexItemIds: [F] }),
    ]);

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].profileAccountIds).toEqual(['p1', 'p2', 'p3', 'p4']);
  });

  it('separates two structurally distinct coherent build families', () => {
    const result = miner.mine([
      profile('a1', [A, B, C, D]),
      profile('a2', [A, B, C, D]),
      profile('a3', [A, B, C, D]),
      profile('b1', [A, X, Y, Z]),
      profile('b2', [A, X, Y, Z]),
      profile('b3', [A, X, Y, Z]),
    ]);

    expect(result.accepted).toHaveLength(2);
    expect(result.accepted.map((entry) => entry.profileAccountIds)).toEqual([
      ['a1', 'a2', 'a3'],
      ['b1', 'b2', 'b3'],
    ]);
    expect(result.accepted.every((entry) => entry.internalSimilarity >= 0.8)).toBe(true);
    expect(result.accepted.every((entry) => entry.separation >= 0.2)).toBe(true);
  });

  it('does not publish a one-profile outlier archetype and traces accepted/rejected mining candidates', () => {
    const trace = new BuildDecisionTraceCollectorV2();
    const result = miner.mine([
      ...coherentProfiles(9),
      profile('outlier', [X, Y, Z]),
    ], {}, trace);

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].profileAccountIds).toHaveLength(10);
    expect(result.accepted.some((entry) => entry.profileAccountIds.length === 1)).toBe(false);
    expect(result.rejected.some((entry) => entry.reasonCodes.includes('CLUSTER_TOO_SMALL'))).toBe(true);

    const stage = trace.stages().find((entry) => entry.stage === 'ARCHETYPE_MINING');
    expect(stage?.stage).toBe('ARCHETYPE_MINING');
    if (stage?.stage !== 'ARCHETYPE_MINING') throw new Error('Missing ARCHETYPE_MINING trace');
    expect(stage.payload.candidates.some((candidate) => candidate.disposition === 'SELECTED')).toBe(true);
    expect(stage.payload.candidates.some((candidate) =>
      candidate.disposition === 'REJECTED' && candidate.reasonCodes.includes('CLUSTER_TOO_SMALL'),
    )).toBe(true);
  });
});
