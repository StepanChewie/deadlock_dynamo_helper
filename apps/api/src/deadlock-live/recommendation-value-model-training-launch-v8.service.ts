import { Injectable } from '@nestjs/common';
import { RecommendationValueDatasetRegistryService } from './recommendation-value-dataset-registry.service';
import { RecommendationValueTrainingLaunchV8Service } from './recommendation-value-training-launch-v8.service';

export interface RecommendationValueModelTrainingPreflightV8 {
  ready: boolean;
  blockers: readonly string[];
  datasetId: string;
  datasetSha256: string;
  manifestSha256: string;
  reward: string;
  futureTestEvaluated: false;
}

@Injectable()
export class RecommendationValueModelTrainingLaunchV8Service {
  constructor(
    private readonly datasets: RecommendationValueDatasetRegistryService,
    private readonly valueTraining: RecommendationValueTrainingLaunchV8Service,
  ) {}

  async preflight(datasetId: string): Promise<RecommendationValueModelTrainingPreflightV8> {
    const dataset = await this.datasets.getVerified(datasetId);
    const manifest = dataset.manifest;
    const from = new Date(manifest.splits[0].from);
    const to = new Date(manifest.splits[manifest.splits.length - 1].to);
    const launch = await this.valueTraining.preflight({
      reward: manifest.reward as 'economyDelta120s' | 'economyDelta300s' | 'objectiveDelta300s' | 'finalPlayerWon',
      from,
      to,
    });
    const blockers = [...launch.blockers];
    if (manifest.futureTestEvaluated) blockers.push('VALUE_DATASET_FUTURE_TEST_EVALUATED');
    return {
      ready: blockers.length === 0,
      blockers: [...new Set(blockers)].sort(),
      datasetId: manifest.datasetId,
      datasetSha256: manifest.datasetSha256,
      manifestSha256: dataset.manifestSha256,
      reward: manifest.reward,
      futureTestEvaluated: false,
    };
  }
}
