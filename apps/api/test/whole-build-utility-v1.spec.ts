import { WholeBuildUtilityV1Service } from '../src/statlocker-adaptive/whole-build-utility-v1.service';

function contributions(overrides: Partial<Record<string, number>> = {}) {
  return {
    skeletonAdherence: 0,
    coreIntegrity: 0,
    branchCoherence: 0,
    threatMatchup: 0,
    synergy: 0,
    timing: 0,
    slotEfficiency: 0,
    economyOpportunityCost: 0,
    investmentContinuity: 0,
    ...overrides,
  };
}

describe('whole build utility v1', () => {
  const service = new WholeBuildUtilityV1Service();

  it('rejects an ordinary sell-and-buy at +0.19 and accepts it at +0.21', () => {
    const rejected = service.evaluateReplacement({
      kind: 'ORDINARY',
      current: contributions({ skeletonAdherence: 0.50 }),
      candidate: contributions({ skeletonAdherence: 0.69 }),
      transactionFriction: 0,
      churnPenalty: 0,
      investmentLoss: 0,
      finalItemCount: 12,
      maxItemCount: 12,
      protectedSale: false,
      sellEconomicsKnown: true,
    });
    const accepted = service.evaluateReplacement({
      kind: 'ORDINARY',
      current: contributions({ skeletonAdherence: 0.50 }),
      candidate: contributions({ skeletonAdherence: 0.71 }),
      transactionFriction: 0,
      churnPenalty: 0,
      investmentLoss: 0,
      finalItemCount: 12,
      maxItemCount: 12,
      protectedSale: false,
      sellEconomicsKnown: true,
    });

    expect(rejected).toMatchObject({ accepted: false, threshold: 0.20, netGain: 0.19 });
    expect(accepted).toMatchObject({ accepted: true, threshold: 0.20, netGain: 0.21 });
  });

  it('uses the stricter 0.25 threshold for soft-core replacement', () => {
    const result = service.evaluateReplacement({
      kind: 'SOFT_CORE',
      current: contributions({ coreIntegrity: 0.40 }),
      candidate: contributions({ coreIntegrity: 0.64 }),
      transactionFriction: 0,
      churnPenalty: 0,
      investmentLoss: 0,
      finalItemCount: 12,
      maxItemCount: 12,
      protectedSale: false,
      sellEconomicsKnown: true,
    });

    expect(result).toMatchObject({ accepted: false, threshold: 0.25, netGain: 0.24 });
  });

  it('uses the 0.30 threshold for outside-skeleton wildcard replacement', () => {
    const result = service.evaluateReplacement({
      kind: 'OUTSIDE_SKELETON',
      current: contributions({ threatMatchup: 0.20 }),
      candidate: contributions({ threatMatchup: 0.51 }),
      transactionFriction: 0,
      churnPenalty: 0,
      investmentLoss: 0,
      finalItemCount: 12,
      maxItemCount: 12,
      protectedSale: false,
      sellEconomicsKnown: true,
    });

    expect(result).toMatchObject({ accepted: true, threshold: 0.30, netGain: 0.31 });
  });

  it('subtracts transaction friction, churn and investment loss from whole-build gain', () => {
    const result = service.evaluateReplacement({
      kind: 'ORDINARY',
      current: contributions({ synergy: 0.30, timing: 0.20 }),
      candidate: contributions({ synergy: 0.55, timing: 0.35 }),
      transactionFriction: 0.05,
      churnPenalty: 0.04,
      investmentLoss: 0.03,
      finalItemCount: 12,
      maxItemCount: 12,
      protectedSale: false,
      sellEconomicsKnown: true,
    });

    expect(result.currentUtility).toBeCloseTo(0.50);
    expect(result.candidateUtility).toBeCloseTo(0.90);
    expect(result.netGain).toBeCloseTo(0.28);
    expect(result.accepted).toBe(true);
  });

  it('fails closed for protected sales, unknown sell economics and over-capacity results', () => {
    const base = {
      kind: 'ORDINARY' as const,
      current: contributions(),
      candidate: contributions({ threatMatchup: 1 }),
      transactionFriction: 0,
      churnPenalty: 0,
      investmentLoss: 0,
      finalItemCount: 12,
      maxItemCount: 12,
      protectedSale: false,
      sellEconomicsKnown: true,
    };

    expect(service.evaluateReplacement({ ...base, protectedSale: true })).toMatchObject({
      accepted: false,
      reasonCodes: expect.arrayContaining(['PROTECTED_SALE']),
    });
    expect(service.evaluateReplacement({ ...base, sellEconomicsKnown: false })).toMatchObject({
      accepted: false,
      reasonCodes: expect.arrayContaining(['SELL_ECONOMICS_UNKNOWN']),
    });
    expect(service.evaluateReplacement({ ...base, finalItemCount: 13 })).toMatchObject({
      accepted: false,
      reasonCodes: expect.arrayContaining(['FINAL_CAPACITY_EXCEEDED']),
    });
  });

  it('returns an auditable component trace for current and candidate builds', () => {
    const result = service.evaluateReplacement({
      kind: 'ORDINARY',
      current: contributions({ skeletonAdherence: 0.30, branchCoherence: 0.10 }),
      candidate: contributions({ skeletonAdherence: 0.25, branchCoherence: 0.20, threatMatchup: 0.40 }),
      transactionFriction: 0.02,
      churnPenalty: 0.01,
      investmentLoss: 0.01,
      finalItemCount: 12,
      maxItemCount: 12,
      protectedSale: false,
      sellEconomicsKnown: true,
    });

    expect(result.trace.current.skeletonAdherence).toBe(0.30);
    expect(result.trace.candidate.threatMatchup).toBe(0.40);
    expect(result.trace.penalties).toEqual({ transactionFriction: 0.02, churnPenalty: 0.01, investmentLoss: 0.01 });
  });
});
