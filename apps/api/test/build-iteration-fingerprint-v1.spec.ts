import {
  blockerFingerprintV1,
  boundRejectsForStorageV1,
  extractRejectsV1,
  planFingerprintV1,
  projectPlanForStorageV1,
} from '../src/statlocker-adaptive/build-iteration-fingerprint-v1';
import { AdaptiveFullBuildStepV2 } from '@deadlock-live-probe/shared';

function step(overrides: Partial<AdaptiveFullBuildStepV2>): AdaptiveFullBuildStepV2 {
  return {
    sequence: 1,
    action: 'BUY',
    buyItemId: 100,
    consumedItemIds: [],
    inventoryBefore: [],
    inventoryAfter: [],
    reasonCodes: [],
    ...overrides,
  };
}

describe('build iteration fingerprints', () => {
  it('treats step order as significant and distinguishes A -> B -> A', () => {
    const a = [step({ sequence: 1, buyItemId: 100 })];
    const b = [step({ sequence: 1, buyItemId: 200 })];

    expect(planFingerprintV1(a)).not.toBe(planFingerprintV1(b));
    expect(planFingerprintV1(a)).toBe(planFingerprintV1([step({ sequence: 1, buyItemId: 100 })]));
    expect(planFingerprintV1(a)).not.toBe(planFingerprintV1([...a, ...b]));
  });

  it('ignores blocker order and duplicates', () => {
    expect(blockerFingerprintV1(['B', 'A', 'A'])).toBe(blockerFingerprintV1(['A', 'B']));
    expect(blockerFingerprintV1(['A'])).not.toBe(blockerFingerprintV1(['B']));
  });

  it('keeps only rejected and hysteresis-suppressed candidates', () => {
    const rejects = extractRejectsV1([
      {
        stage: 'ARCHETYPE_SELECTION',
        reasonCodes: [],
        payload: {
          enemyHeroIds: [10],
          wpaQueryCount: 1,
          fallbackUsed: false,
          candidates: [
            { candidateId: 'archetype:a', archetypeId: 'a', disposition: 'SELECTED', reasonCodes: [] },
            { candidateId: 'archetype:b', archetypeId: 'b', disposition: 'REJECTED', reasonCodes: ['LOW_COVERAGE'] },
          ],
        },
      },
      {
        stage: 'PLAN_SEARCH',
        reasonCodes: [],
        payload: {
          branches: [
            { sequence: 1, targetItemId: 100, action: 'BUY', disposition: 'SUPPRESSED_BY_HYSTERESIS', reasonCodes: ['HYSTERESIS_GATE'] },
          ],
        },
      },
      { stage: 'LIVE_CONTEXT', reasonCodes: [], payload: { gameTimeSec: 600, inventoryItemIds: [], capacity: 9, enemyThreats: [] } },
    ] as any);

    expect(rejects.totalRejected).toBe(2);
    expect(rejects.stages.map((entry) => entry.stage)).toEqual(['ARCHETYPE_SELECTION', 'PLAN_SEARCH']);
    expect(rejects.stages[0].entries[0]).toEqual({
      disposition: 'REJECTED',
      archetypeId: 'b',
      reasonCodes: ['LOW_COVERAGE'],
    });
    expect(rejects.stages[1].entries[0].disposition).toBe('SUPPRESSED_BY_HYSTERESIS');
  });

  it('drops inventory snapshots when the plan exceeds the size cap', () => {
    const big = Array.from({ length: 400 }, (_, index) =>
      step({
        sequence: index + 1,
        buyItemId: 100 + index,
        inventoryBefore: Array.from({ length: 60 }, (__, i) => i),
        inventoryAfter: Array.from({ length: 60 }, (__, i) => i + 1),
      }),
    );
    const plan = {
      planRevision: 'rev-1',
      steps: big,
      degradedReasons: [],
      validation: { valid: true, reasonCodes: [] },
    };

    // The plan above serializes to ~186 KB, so the "generous" cap has to sit
    // above that for the not-truncated case to mean anything (the brief's
    // 64 KiB could never fit this fixture).
    expect(projectPlanForStorageV1(plan, 256 * 1024).truncated).toBe(false);
    const compacted = projectPlanForStorageV1(plan, 4 * 1024);
    expect(compacted.truncated).toBe(true);
    expect(compacted.payload.steps).toHaveLength(400);
    expect((compacted.payload.steps as any[])[0].inventoryBefore).toBeUndefined();
  });
});
