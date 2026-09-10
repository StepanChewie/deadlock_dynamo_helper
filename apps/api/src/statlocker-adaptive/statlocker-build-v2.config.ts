export interface BuildProfileSimilarityWeightsV2 {
  composition: number;
  tierAgreement: number;
  groupAgreement: number;
  relationshipAgreement: number;
  phaseAgreement: number;
  timingAgreement: number;
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
}

export const STATLOCKER_BUILD_V2_CONFIG: Readonly<StatlockerBuildV2Config> = Object.freeze({
  profileLinkSimilarity: 0.72,
  minClusterSize: 3,
  minInternalSimilarity: 0.80,
  minConsensusSimilarity: 0.72,
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
});
