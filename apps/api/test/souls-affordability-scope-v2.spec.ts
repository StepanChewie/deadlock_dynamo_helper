import { SOULS_AFFORDABILITY_EVIDENCE_V2, SoulsAffordabilityControlledObservationV2 } from '@dynamo-lab/shared';
import { SoulsAffordabilityEvidenceV2Service } from '../src/deadlock-live/souls-affordability-evidence-v2.service';

function observation(index: number, rulesetVersion = 'ruleset-a', catalogSha256 = 'a'.repeat(64)): SoulsAffordabilityControlledObservationV2 {
  const sufficient = index % 2 === 0;
  const before = sufficient ? 2000 : 500;
  const cost = 1000;
  return {
    evidenceVersion: SOULS_AFFORDABILITY_EVIDENCE_V2,
    observationId: `obs-${index}`,
    sessionId: `session-${Math.floor(index / 10)}`,
    matchId: `match-${Math.floor(index / 5)}`,
    gameTimeSec: index,
    actionType: 'BUY',
    itemId: 1,
    clientVersion: 'client-1',
    gepVersion: 'gep-1',
    normalizerVersion: 'normalizer-1',
    rulesetVersion,
    catalogSha256,
    sourceOccurredAtMs: 1_000 + index,
    capturedAtMs: 1_001 + index,
    shopOpportunityObserved: 'AVAILABLE',
    soulsRawBefore: before,
    soulsRawAfter: sufficient ? before - cost : before,
    effectiveCost: cost,
    actionSucceeded: sufficient,
    hudSoulsBefore: before,
    hudSoulsAfter: sufficient ? before - cost : before,
    inventoryConfirmedBefore: true,
    inventoryConfirmedAfter: true,
  };
}

describe('SoulsAffordabilityEvidenceV2Service scope verification', () => {
  it('verifies only the exact ruleset and catalog scope', async () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({ observation: observation(index) }));
    const repo = { find: jest.fn().mockResolvedValue(rows) } as any;
    const service = new SoulsAffordabilityEvidenceV2Service(repo);

    await expect(service.canVerifyScope('ruleset-a', 'a'.repeat(64))).resolves.toBe(true);
    await expect(service.canVerifyScope('ruleset-b', 'a'.repeat(64))).resolves.toBe(false);
    await expect(service.canVerifyScope('ruleset-a', 'b'.repeat(64))).resolves.toBe(false);
  });

  it('fails closed for malformed or insufficient scoped evidence', async () => {
    const malformed = observation(0);
    malformed.catalogSha256 = 'bad';
    const repo = {
      find: jest.fn().mockResolvedValue([
        { observation: malformed },
        ...Array.from({ length: 20 }, (_, index) => ({ observation: observation(index + 1) })),
      ]),
    } as any;
    const service = new SoulsAffordabilityEvidenceV2Service(repo);

    await expect(service.canVerifyScope('ruleset-a', 'a'.repeat(64))).resolves.toBe(false);
  });
});
