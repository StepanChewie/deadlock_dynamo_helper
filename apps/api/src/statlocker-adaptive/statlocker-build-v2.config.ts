export interface StatlockerBuildV2Config {
  profileLinkSimilarity: number;
  minClusterSize: number;
  minInternalSimilarity: number;
  minConsensusSimilarity: number;
  minClusterSeparation: number;
  maxPublishedArchetypes: number;
}

export const STATLOCKER_BUILD_V2_CONFIG: Readonly<StatlockerBuildV2Config> = Object.freeze({
  profileLinkSimilarity: 0.72,
  minClusterSize: 3,
  minInternalSimilarity: 0.80,
  minConsensusSimilarity: 0.72,
  minClusterSeparation: 0.20,
  maxPublishedArchetypes: 3,
});
