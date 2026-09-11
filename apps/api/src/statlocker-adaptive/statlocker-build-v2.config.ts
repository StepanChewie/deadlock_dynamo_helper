export interface BuildProfileSimilarityWeightsV2 {
  composition: number;
  tierAgreement: number;
  groupAgreement: number;
  relationshipAgreement: number;
  phaseAgreement: number;
  timingAgreement: number;
}

export interface BuildArchetypeSelectionRoleWeightsV2 {
  CORE: number;
  FREQUENT: number;
  SITUATIONAL: number;
  FLEX: number;
}

export interface BuildItemUtilityV2Config {
  layerWeights: {
    structure: number;
    matchup: number;
    progression: number;
    transition: number;
  };
  rolePriors: BuildArchetypeSelectionRoleWeightsV2;
  outsideArchetypePrior: number;
  structureWeights: {
    role: number;
    structuralPriority: number;
    profileCoverage: number;
    purchaseRate: number;
  };
  matchupWeights: {
    exactEnemy: number;
    baseWpa: number;
  };
  progressionWeights: {
    timing: number;
    phase: number;
    order: number;
    relationship: number;
    chain: number;
  };
  transitionPenaltyWeights: {
    transaction: number;
    churn: number;
    recentPurchase: number;
    replacement: number;
  };
  baseWpaSamplePrior: number;
  chainSamplePrior: number;
  wpaNormalizationScale: number;
  timingScaleS: number;
  phaseMidMinTimeS: number;
  phaseLateMinTimeS: number;
}

export interface OutsideMatchupDiscoveryV2Config {
  minCoverage: number;
  minConfidence: number;
  replacementMinConfidence: number;
  minNormalizedSupport: number;
  buyMinImprovement: number;
  replacementMinImprovement: number;
  coreReplacementMinImprovement: number;
}

export interface FullBuildResolverV2Config {
  buyMinImprovement: number;
  replacementMinImprovement: number;
  coreReplacementMinImprovement: number;
  recentPurchaseProtectionS: number;
  minPlanSwitchImprovement: number;
  nearTermProtectedStepCount: number;
  nearTermPlanSwitchMinImprovement: number;
}

export interface ArchetypePublicationV2Config {
  heldItemCapacity: number;
}

export interface StatlockerBuildV2Config {
  profileLinkSimilarity: number;
  minClusterSize: number;
  minInternalSimilarity: number;
  minConsensusSimilarity: number;
  minClusterSeparation: number;
  maxPublishedArchetypes: number;
  profileSimilarityWeights: BuildProfileSimilarityWeightsV2;
  minOrderSourceProfiles: number;
  softOrderConfidence: number;
  hardOrderConfidence: number;
  orderTimingToleranceS: number;
  inferredChoiceMaxCooccurrence: number;
  inferredChoiceMaxTimingGapS: number;
  inferredChoiceMinRelationshipStrength: number;
  archetypeSelectionSamplePrior: number;
  archetypeSelectionRoleWeights: BuildArchetypeSelectionRoleWeightsV2;
  offlineArchetypeSupportWeight: number;
  offlineArchetypeCoherenceWeight: number;
  archetypePublication: ArchetypePublicationV2Config;
  itemUtility: BuildItemUtilityV2Config;
  outsideMatchupDiscovery: OutsideMatchupDiscoveryV2Config;
  fullBuildResolver: FullBuildResolverV2Config;
}

export const STATLOCKER_BUILD_V2_CONFIG: Readonly<StatlockerBuildV2Config> = Object.freeze({
  profileLinkSimilarity: 0.60,
  minClusterSize: 2,
  minInternalSimilarity: 0.60,
  minConsensusSimilarity: 0.52,
  minClusterSeparation: 0.20,
  maxPublishedArchetypes: 3,
  profileSimilarityWeights: Object.freeze({
    composition: 0.70,
    tierAgreement: 0.10,
    groupAgreement: 0.05,
    relationshipAgreement: 0.05,
    phaseAgreement: 0.05,
    timingAgreement: 0.05,
  }),
  minOrderSourceProfiles: 2,
  softOrderConfidence: 0.65,
  hardOrderConfidence: 0.80,
  orderTimingToleranceS: 45,
  inferredChoiceMaxCooccurrence: 0.25,
  inferredChoiceMaxTimingGapS: 360,
  inferredChoiceMinRelationshipStrength: 0.50,
  archetypeSelectionSamplePrior: 500,
  archetypeSelectionRoleWeights: Object.freeze({
    CORE: 1,
    FREQUENT: 0.75,
    SITUATIONAL: 0.35,
    FLEX: 0.20,
  }),
  offlineArchetypeSupportWeight: 0.60,
  offlineArchetypeCoherenceWeight: 0.40,
  archetypePublication: Object.freeze({
    heldItemCapacity: 12,
  }),
  itemUtility: Object.freeze({
    layerWeights: Object.freeze({
      structure: 1,
      matchup: 0.9,
      progression: 0.65,
      transition: 1,
    }),
    rolePriors: Object.freeze({
      CORE: 1,
      FREQUENT: 0.75,
      SITUATIONAL: 0.35,
      FLEX: 0.20,
    }),
    outsideArchetypePrior: -0.08,
    structureWeights: Object.freeze({
      role: 0.35,
      structuralPriority: 0.35,
      profileCoverage: 0.15,
      purchaseRate: 0.15,
    }),
    matchupWeights: Object.freeze({
      exactEnemy: 0.8,
      baseWpa: 0.2,
    }),
    progressionWeights: Object.freeze({
      timing: 0.25,
      phase: 0.15,
      order: 0.25,
      relationship: 0.15,
      chain: 0.20,
    }),
    transitionPenaltyWeights: Object.freeze({
      transaction: 0.35,
      churn: 0.30,
      recentPurchase: 0.20,
      replacement: 0.15,
    }),
    baseWpaSamplePrior: 200,
    chainSamplePrior: 200,
    wpaNormalizationScale: 0.15,
    timingScaleS: 900,
    phaseMidMinTimeS: 600,
    phaseLateMinTimeS: 1500,
  }),
  outsideMatchupDiscovery: Object.freeze({
    minCoverage: 0.30,
    minConfidence: 0.35,
    replacementMinConfidence: 0.40,
    minNormalizedSupport: 0,
    buyMinImprovement: 0.08,
    replacementMinImprovement: 0.30,
    coreReplacementMinImprovement: 0.45,
  }),
  fullBuildResolver: Object.freeze({
    buyMinImprovement: 0.08,
    replacementMinImprovement: 0.30,
    coreReplacementMinImprovement: 0.45,
    recentPurchaseProtectionS: 120,
    minPlanSwitchImprovement: 0.08,
    nearTermProtectedStepCount: 2,
    nearTermPlanSwitchMinImprovement: 0.16,
  }),
});
