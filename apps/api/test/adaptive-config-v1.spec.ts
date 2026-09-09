import {
  ADAPTIVE_POLICY_V1_CONFIG,
  loadAdaptivePolicyV1Config,
} from '../src/statlocker-adaptive/statlocker-adaptive.config';

describe('adaptive policy v1 config', () => {
  it('keeps the approved deterministic defaults', () => {
    expect(ADAPTIVE_POLICY_V1_CONFIG.gameStateThreshold).toBe(0.08);
    expect(ADAPTIVE_POLICY_V1_CONFIG.exactEnemyMaxMatchups).toBe(3);
    expect(ADAPTIVE_POLICY_V1_CONFIG.planningDepth).toBe(3);
    expect(ADAPTIVE_POLICY_V1_CONFIG.beamWidth).toBe(8);
    expect((ADAPTIVE_POLICY_V1_CONFIG.threat as any).smoothingAlpha).toBe(0.35);
    expect(ADAPTIVE_POLICY_V1_CONFIG.sellMinImprovement).toBeGreaterThan(
      ADAPTIVE_POLICY_V1_CONFIG.minPlanSwitchImprovement,
    );
    expect(ADAPTIVE_POLICY_V1_CONFIG.coreReplaceMinImprovement).toBeGreaterThan(
      ADAPTIVE_POLICY_V1_CONFIG.sellMinImprovement,
    );
  });

  it('accepts bounded overrides and reports invalid values while falling back', () => {
    const loaded = loadAdaptivePolicyV1Config({
      ADAPTIVE_GAME_STATE_THRESHOLD: '0.10',
      ADAPTIVE_PLANNING_DEPTH: '99',
      ADAPTIVE_BEAM_WIDTH: 'not-a-number',
      ADAPTIVE_THREAT_SMOOTHING_ALPHA: '0.40',
    });

    expect(loaded.config.gameStateThreshold).toBe(0.10);
    expect(loaded.config.planningDepth).toBe(3);
    expect(loaded.config.beamWidth).toBe(8);
    expect((loaded.config.threat as any).smoothingAlpha).toBe(0.40);
    expect(loaded.diagnostics.map((entry) => entry.key).sort()).toEqual([
      'ADAPTIVE_BEAM_WIDTH',
      'ADAPTIVE_PLANNING_DEPTH',
    ]);
  });

  it('rejects an invalid smoothing alpha instead of silently accepting it', () => {
    const loaded = loadAdaptivePolicyV1Config({
      ADAPTIVE_THREAT_SMOOTHING_ALPHA: '0',
    });

    expect((loaded.config.threat as any).smoothingAlpha).toBe(0.35);
    expect(loaded.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'ADAPTIVE_THREAT_SMOOTHING_ALPHA',
        reason: 'OUT_OF_RANGE',
      }),
    ]));
  });
});
