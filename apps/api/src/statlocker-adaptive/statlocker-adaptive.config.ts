export interface AdaptivePolicyV1Config {
  version: string;
  gameStateThreshold: number;
  gameStateBlendWidth: number;
  exactEnemyMaxMatchups: number;
  planningDepth: number;
  beamWidth: number;
  futureDiscount: number;
  minPlanSwitchImprovement: number;
  sellMinImprovement: number;
  coreReplaceMinImprovement: number;
  recentPurchaseProtectionMs: number;
  recentSellRebuyPenaltyMs: number;
  phase: {
    midMinTimeSec: number;
    lateMinTimeSec: number;
    strongInvestmentMinAchievedBreakpoints: number;
    strongInvestmentProgressAccelerationSec: number;
  };
  choice: {
    switchMinImprovement: number;
    committedReplaceMinImprovement: number;
    inferenceMinCoverage: number;
    inferenceMaxCooccurrence: number;
    inferenceMaxMedianTimeDeltaSec: number;
    inferenceMinConfidence: number;
  };
  situational: {
    minTargetConfidence: number;
    minTargetPriority: number;
    maxDisplayedTargets: number;
    minImprovementOverCore: number;
    targetSwitchMinImprovement: number;
    maxCoreDelaySouls: number;
  };
  threat: {
    weights: {
      souls: number;
      heroDamage: number;
      killsAssists: number;
      level: number;
      deaths: number;
    };
    minMultiplier: number;
    maxMultiplier: number;
  };
  optionalActivationMinScore: number;
  investment: {
    crossingBonus: number;
    nearBreakpointBonus: number;
    achievedBreakpointDropPenalty: number;
    nearBreakpointMaxSouls: number;
  };
  shrinkK: {
    baseWpa: number;
    gameState: number;
    exactEnemy: number;
    chain: number;
    proProfile: number;
  };
  weights: {
    skeletonPrior: number;
    baseWpa: number;
    gameStateFit: number;
    exactEnemyFit: number;
    enemyCompositionFit: number;
    ownBuildFit: number;
    timingFit: number;
    laneFit: number;
    chainFit: number;
    skeletonDeviation: number;
    investmentUtility: number;
    slotEfficiency: number;
    transaction: number;
    churn: number;
    instability: number;
  };
}

export const ADAPTIVE_POLICY_V1_CONFIG: AdaptivePolicyV1Config = {
  version: 'statlocker-adaptive-v1.3.0',
  gameStateThreshold: 0.08,
  gameStateBlendWidth: 0.03,
  exactEnemyMaxMatchups: 3,
  planningDepth: 3,
  beamWidth: 8,
  futureDiscount: 0.8,
  minPlanSwitchImprovement: 0.08,
  sellMinImprovement: 0.20,
  coreReplaceMinImprovement: 0.25,
  recentPurchaseProtectionMs: 120_000,
  recentSellRebuyPenaltyMs: 180_000,
  phase: {
    midMinTimeSec: 600,
    lateMinTimeSec: 1500,
    strongInvestmentMinAchievedBreakpoints: 2,
    strongInvestmentProgressAccelerationSec: 120,
  },
  choice: {
    switchMinImprovement: 0.08,
    committedReplaceMinImprovement: 0.25,
    inferenceMinCoverage: 0.30,
    inferenceMaxCooccurrence: 0.25,
    inferenceMaxMedianTimeDeltaSec: 300,
    inferenceMinConfidence: 0.60,
  },
  situational: {
    minTargetConfidence: 0.35,
    minTargetPriority: 0.04,
    maxDisplayedTargets: 2,
    minImprovementOverCore: 0.08,
    targetSwitchMinImprovement: 0.05,
    maxCoreDelaySouls: 3200,
  },
  threat: {
    weights: {
      souls: 0.35,
      heroDamage: 0.30,
      killsAssists: 0.20,
      level: 0.10,
      deaths: -0.05,
    },
    minMultiplier: 0.75,
    maxMultiplier: 1.50,
  },
  optionalActivationMinScore: 0.15,
  investment: {
    crossingBonus: 0.18,
    nearBreakpointBonus: 0.08,
    achievedBreakpointDropPenalty: 0.20,
    nearBreakpointMaxSouls: 800,
  },
  shrinkK: {
    baseWpa: 200,
    gameState: 250,
    exactEnemy: 500,
    chain: 200,
    proProfile: 50,
  },
  weights: {
    skeletonPrior: 1.0,
    baseWpa: 0.7,
    gameStateFit: 0.7,
    exactEnemyFit: 0.9,
    enemyCompositionFit: 0.5,
    ownBuildFit: 0.5,
    timingFit: 0.4,
    laneFit: 0.3,
    chainFit: 0.7,
    skeletonDeviation: 1.0,
    investmentUtility: 1.0,
    slotEfficiency: 0.3,
    transaction: 0.7,
    churn: 1.0,
    instability: 0.8,
  },
};

export interface AdaptiveConfigDiagnosticV1 {
  key: string;
  suppliedValue?: string;
  reason: 'NOT_NUMERIC' | 'OUT_OF_RANGE' | 'NOT_INTEGER';
  fallback: number;
}

export interface LoadedAdaptivePolicyV1Config {
  config: AdaptivePolicyV1Config;
  diagnostics: readonly AdaptiveConfigDiagnosticV1[];
}

type NumericEnvSpec = {
  key: string;
  min: number;
  max: number;
  integer?: boolean;
  get: (config: AdaptivePolicyV1Config) => number;
  set: (config: AdaptivePolicyV1Config, value: number) => void;
};

const NUMERIC_ENV_SPECS: readonly NumericEnvSpec[] = [
  scalar('ADAPTIVE_GAME_STATE_THRESHOLD', 0.01, 0.5, (c) => c.gameStateThreshold, (c, v) => { c.gameStateThreshold = v; }),
  scalar('ADAPTIVE_GAME_STATE_BLEND_WIDTH', 0, 0.2, (c) => c.gameStateBlendWidth, (c, v) => { c.gameStateBlendWidth = v; }),
  scalar('ADAPTIVE_EXACT_ENEMY_MAX_MATCHUPS', 1, 12, (c) => c.exactEnemyMaxMatchups, (c, v) => { c.exactEnemyMaxMatchups = v; }, true),
  scalar('ADAPTIVE_PLANNING_DEPTH', 1, 6, (c) => c.planningDepth, (c, v) => { c.planningDepth = v; }, true),
  scalar('ADAPTIVE_BEAM_WIDTH', 1, 32, (c) => c.beamWidth, (c, v) => { c.beamWidth = v; }, true),
  scalar('ADAPTIVE_FUTURE_DISCOUNT', 0, 1, (c) => c.futureDiscount, (c, v) => { c.futureDiscount = v; }),
  scalar('ADAPTIVE_MIN_PLAN_SWITCH_IMPROVEMENT', 0, 1, (c) => c.minPlanSwitchImprovement, (c, v) => { c.minPlanSwitchImprovement = v; }),
  scalar('ADAPTIVE_SELL_MIN_IMPROVEMENT', 0, 1, (c) => c.sellMinImprovement, (c, v) => { c.sellMinImprovement = v; }),
  scalar('ADAPTIVE_CORE_REPLACE_MIN_IMPROVEMENT', 0, 1, (c) => c.coreReplaceMinImprovement, (c, v) => { c.coreReplaceMinImprovement = v; }),
  scalar('ADAPTIVE_RECENT_PURCHASE_PROTECTION_MS', 0, 900_000, (c) => c.recentPurchaseProtectionMs, (c, v) => { c.recentPurchaseProtectionMs = v; }, true),
  scalar('ADAPTIVE_RECENT_SELL_REBUY_PENALTY_MS', 0, 900_000, (c) => c.recentSellRebuyPenaltyMs, (c, v) => { c.recentSellRebuyPenaltyMs = v; }, true),
  scalar('ADAPTIVE_SITUATIONAL_MIN_TARGET_CONFIDENCE', 0, 1, (c) => c.situational.minTargetConfidence, (c, v) => { c.situational.minTargetConfidence = v; }),
  scalar('ADAPTIVE_SITUATIONAL_MIN_TARGET_PRIORITY', 0, 1, (c) => c.situational.minTargetPriority, (c, v) => { c.situational.minTargetPriority = v; }),
  scalar('ADAPTIVE_SITUATIONAL_MAX_DISPLAYED_TARGETS', 1, 6, (c) => c.situational.maxDisplayedTargets, (c, v) => { c.situational.maxDisplayedTargets = v; }, true),
  scalar('ADAPTIVE_SITUATIONAL_MIN_IMPROVEMENT_OVER_CORE', 0, 1, (c) => c.situational.minImprovementOverCore, (c, v) => { c.situational.minImprovementOverCore = v; }),
  scalar('ADAPTIVE_SITUATIONAL_TARGET_SWITCH_MIN_IMPROVEMENT', 0, 1, (c) => c.situational.targetSwitchMinImprovement, (c, v) => { c.situational.targetSwitchMinImprovement = v; }),
  scalar('ADAPTIVE_SITUATIONAL_MAX_CORE_DELAY_SOULS', 0, 20_000, (c) => c.situational.maxCoreDelaySouls, (c, v) => { c.situational.maxCoreDelaySouls = v; }, true),
  scalar('ADAPTIVE_THREAT_WEIGHT_SOULS', 0, 1, (c) => c.threat.weights.souls, (c, v) => { c.threat.weights.souls = v; }),
  scalar('ADAPTIVE_THREAT_WEIGHT_HERO_DAMAGE', 0, 1, (c) => c.threat.weights.heroDamage, (c, v) => { c.threat.weights.heroDamage = v; }),
  scalar('ADAPTIVE_THREAT_WEIGHT_KILLS_ASSISTS', 0, 1, (c) => c.threat.weights.killsAssists, (c, v) => { c.threat.weights.killsAssists = v; }),
  scalar('ADAPTIVE_THREAT_WEIGHT_LEVEL', 0, 1, (c) => c.threat.weights.level, (c, v) => { c.threat.weights.level = v; }),
  scalar('ADAPTIVE_THREAT_WEIGHT_DEATHS', -1, 0, (c) => c.threat.weights.deaths, (c, v) => { c.threat.weights.deaths = v; }),
  scalar('ADAPTIVE_THREAT_MIN_MULTIPLIER', 0, 1, (c) => c.threat.minMultiplier, (c, v) => { c.threat.minMultiplier = v; }),
  scalar('ADAPTIVE_THREAT_MAX_MULTIPLIER', 1, 3, (c) => c.threat.maxMultiplier, (c, v) => { c.threat.maxMultiplier = v; }),
];

export function loadAdaptivePolicyV1Config(
  env: Readonly<Record<string, string | undefined>> = process.env,
): LoadedAdaptivePolicyV1Config {
  const config = cloneDefaults();
  const diagnostics: AdaptiveConfigDiagnosticV1[] = [];
  for (const spec of NUMERIC_ENV_SPECS) {
    const raw = env[spec.key];
    if (raw === undefined || raw.trim() === '') continue;
    const numeric = Number(raw);
    const fallback = spec.get(config);
    if (!Number.isFinite(numeric)) {
      diagnostics.push({ key: spec.key, suppliedValue: raw, reason: 'NOT_NUMERIC', fallback });
      continue;
    }
    if (spec.integer && !Number.isInteger(numeric)) {
      diagnostics.push({ key: spec.key, suppliedValue: raw, reason: 'NOT_INTEGER', fallback });
      continue;
    }
    if (numeric < spec.min || numeric > spec.max) {
      diagnostics.push({ key: spec.key, suppliedValue: raw, reason: 'OUT_OF_RANGE', fallback });
      continue;
    }
    spec.set(config, numeric);
  }

  if (config.sellMinImprovement <= config.minPlanSwitchImprovement) {
    diagnostics.push({
      key: 'ADAPTIVE_SELL_MIN_IMPROVEMENT',
      reason: 'OUT_OF_RANGE',
      fallback: ADAPTIVE_POLICY_V1_CONFIG.sellMinImprovement,
    });
    config.sellMinImprovement = ADAPTIVE_POLICY_V1_CONFIG.sellMinImprovement;
  }
  if (config.coreReplaceMinImprovement <= config.sellMinImprovement) {
    diagnostics.push({
      key: 'ADAPTIVE_CORE_REPLACE_MIN_IMPROVEMENT',
      reason: 'OUT_OF_RANGE',
      fallback: ADAPTIVE_POLICY_V1_CONFIG.coreReplaceMinImprovement,
    });
    config.coreReplaceMinImprovement = ADAPTIVE_POLICY_V1_CONFIG.coreReplaceMinImprovement;
  }
  if (config.threat.minMultiplier > config.threat.maxMultiplier) {
    diagnostics.push({
      key: 'ADAPTIVE_THREAT_MIN_MULTIPLIER',
      reason: 'OUT_OF_RANGE',
      fallback: ADAPTIVE_POLICY_V1_CONFIG.threat.minMultiplier,
    });
    config.threat.minMultiplier = ADAPTIVE_POLICY_V1_CONFIG.threat.minMultiplier;
    config.threat.maxMultiplier = ADAPTIVE_POLICY_V1_CONFIG.threat.maxMultiplier;
  }

  return { config, diagnostics };
}

function scalar(
  key: string,
  min: number,
  max: number,
  get: NumericEnvSpec['get'],
  set: NumericEnvSpec['set'],
  integer = false,
): NumericEnvSpec {
  return { key, min, max, get, set, integer };
}

function cloneDefaults(): AdaptivePolicyV1Config {
  return {
    ...ADAPTIVE_POLICY_V1_CONFIG,
    phase: { ...ADAPTIVE_POLICY_V1_CONFIG.phase },
    choice: { ...ADAPTIVE_POLICY_V1_CONFIG.choice },
    situational: { ...ADAPTIVE_POLICY_V1_CONFIG.situational },
    threat: {
      ...ADAPTIVE_POLICY_V1_CONFIG.threat,
      weights: { ...ADAPTIVE_POLICY_V1_CONFIG.threat.weights },
    },
    investment: { ...ADAPTIVE_POLICY_V1_CONFIG.investment },
    shrinkK: { ...ADAPTIVE_POLICY_V1_CONFIG.shrinkK },
    weights: { ...ADAPTIVE_POLICY_V1_CONFIG.weights },
  };
}