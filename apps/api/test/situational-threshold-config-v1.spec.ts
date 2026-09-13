import {
  ADAPTIVE_POLICY_V1_CONFIG,
  loadAdaptivePolicyV1Config,
} from '../src/statlocker-adaptive/statlocker-adaptive.config';

describe('situational threshold configuration V1', () => {
  it('defines one authoritative situational improvement threshold', () => {
    expect(ADAPTIVE_POLICY_V1_CONFIG.situational.minImprovementOverCore).toBe(0.08);
  });

  it('defines stricter sell-driven outside-skeleton thresholds', () => {
    const situational = ADAPTIVE_POLICY_V1_CONFIG.situational as any;

    expect(situational.matchupDiscoverySellMinConfidence).toBe(0.40);
    expect(situational.matchupDiscoveryReplaceMinImprovement).toBe(0.30);
  });

  it('allows bounded overrides for sell-driven outside-skeleton thresholds', () => {
    const loaded = loadAdaptivePolicyV1Config({
      ADAPTIVE_SITUATIONAL_MATCHUP_DISCOVERY_SELL_MIN_CONFIDENCE: '0.45',
      ADAPTIVE_SITUATIONAL_MATCHUP_DISCOVERY_REPLACE_MIN_IMPROVEMENT: '0.35',
    });
    const situational = loaded.config.situational as any;

    expect(situational.matchupDiscoverySellMinConfidence).toBe(0.45);
    expect(situational.matchupDiscoveryReplaceMinImprovement).toBe(0.35);
    expect(loaded.diagnostics).toEqual([]);
  });
});
