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
});
