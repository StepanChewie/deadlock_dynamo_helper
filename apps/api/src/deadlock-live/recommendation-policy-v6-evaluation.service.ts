import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { RECOMMENDATION_BEHAVIORAL_V4_MODEL_VERSION } from './recommendation-behavioral-v4-training.service';
import { RECOMMENDATION_DECISION_DATASET_V5_VERSION } from './recommendation-decision-dataset-v5.service';
import { RECOMMENDATION_VALUE_V6_MODEL_VERSION } from './recommendation-value-v6-model';

export const RECOMMENDATION_POLICY_V6_EVALUATION_SCHEMA_VERSION = 1;
export const RECOMMENDATION_POLICY_V6_EVALUATION_VERSION =
  'RECOMMENDATION_POLICY_V6_DIAGNOSTIC_OPE_1' as const;

const DEFAULT_BEHAVIORAL_DIRECTORY =
  '/app/apps/api/storage/recommendation-behavioral-v4-training';
const DEFAULT_VALUE_DIRECTORY =
  '/app/apps/api/storage/recommendation-value-v6-training';
const DEFAULT_OUTPUT_DIRECTORY =
  '/app/apps/api/storage/recommendation-policy-v6-evaluation';
const BEHAVIORAL_DIRECTORY_ENV =
  'DEADLOCK_RECOMMENDATION_POLICY_V6_BEHAVIORAL_DIR';
const VALUE_DIRECTORY_ENV = 'DEADLOCK_RECOMMENDATION_POLICY_V6_VALUE_DIR';
const OUTPUT_DIRECTORY_ENV = 'DEADLOCK_RECOMMENDATION_POLICY_V6_OUTPUT_DIR';
const PROBABILITY_EPSILON = 1e-9;
const BUFFER_LIMIT_BYTES = 1024 * 1024;

export interface RecommendationPolicyV6EvaluationStartRequest {
  behaviorTemperature?: number;
  targetTemperature?: number;
  targetAdvantageWeight?: number;
  minBehaviorProbability?: number;
  maxImportanceWeight?: number;
  bootstrapReplicates?: number;
  bootstrapSeed?: number;
  maxCandidateActions?: number;
  expectedBehavioralModelSha256?: string;
  expectedValuePredictionSha256?: string;
  expectedValueModelSha256?: string;
}

export interface RecommendationPolicyV6EvaluationOptions {
  behaviorTemperature: number;
  targetTemperature: number;
  targetAdvantageWeight: number;
  minBehaviorProbability: number;
  maxImportanceWeight: number;
  bootstrapReplicates: number;
  bootstrapSeed: number;
  maxCandidateActions: number;
  expectedBehavioralModelSha256?: string;
  expectedValuePredictionSha256?: string;
  expectedValueModelSha256?: string;
}

export interface RecommendationPolicyV6EvaluationStatus {
  state: 'IDLE' | 'RUNNING' | 'COMPLETE' | 'FAILED';
  phase:
    | 'PREPARING'
    | 'JOINING'
    | 'EVALUATING'
    | 'BOOTSTRAPPING'
    | 'FINALIZING'
    | 'COMPLETE';
  processedBehavioralRowCount: number;
  processedValueRowCount: number;
  joinedDecisionCount: number;
  candidateCoveredDecisionCount: number;
  supportedDecisionCount: number;
  evaluatedDecisionCount: number;
  evaluatedMatchCount: number;
  outputDirectory: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  options?: RecommendationPolicyV6EvaluationOptions;
  manifestAvailable: boolean;
  auditAvailable: boolean;
  evaluationAvailable: boolean;
}

export interface RecommendationPolicyV6DecisionContribution {
  decisionId: string;
  matchId: string;
  evaluationWeight: number;
  reward: number;
  observedActionKey: string;
  behaviorProbability: number;
  targetProbability: number;
  rawImportanceWeight: number;
  clippedImportanceWeight: number;
  clipped: boolean;
  directValue: number;
  observedActionValue: number;
  ipsContribution: number;
  doublyRobustContribution: number;
}

export interface RecommendationPolicyV6MatchContribution {
  matchId: string;
  decisionCount: number;
  evaluationWeightSum: number;
  rewardWeightedSum: number;
  ipsWeightedSum: number;
  snipsWeightedSum: number;
  importanceWeightWeightedSum: number;
  importanceWeightSquareSum: number;
  directWeightedSum: number;
  doublyRobustWeightedSum: number;
}

export interface RecommendationPolicyV6EstimatorSummary {
  decisionCount: number;
  matchCount: number;
  evaluationWeightSum: number;
  observedValue: number;
  inversePropensityValue: number;
  selfNormalizedInversePropensityValue: number;
  directMethodValue: number;
  doublyRobustValue: number;
  effectiveSampleSize: number;
  effectiveSampleSizeRatio: number;
  deltasVsObserved: {
    inversePropensity: number;
    selfNormalizedInversePropensity: number;
    directMethod: number;
    doublyRobust: number;
  };
}

export interface RecommendationPolicyV6BootstrapSummary {
  confidenceLevel: 0.95;
  replicateCount: number;
  seed: number;
  intervals: Record<
    string,
    {
      lower: number;
      median: number;
      upper: number;
    }
  >;
}

interface BehavioralPreparedRow {
  decisionId: string;
  matchId: string;
  decisionOccurredAt: string;
  features: {
    heroId: number;
    teamId?: number;
    timeBucket: number;
    inventoryStateKey: string;
    previousActionTailKey: string;
    alliedHeroIds: number[];
    enemyHeroIds: number[];
    candidateActionKeys: string[];
  };
  targetActionKey: string;
}

interface BehavioralSerializedModel {
  modelVersion: typeof RECOMMENDATION_BEHAVIORAL_V4_MODEL_VERSION;
  options: {
    smoothing: number;
    minContextObservations: number;
  };
  weights: {
    inventoryDelta: number;
    previousActionTailDelta: number;
    alliedRosterDeltaAverage: number;
    enemyRosterDeltaAverage: number;
  };
  counts: {
    hero: CountTableRecord;
    heroTime: CountTableRecord;
    heroTimeInventory: CountTableRecord;
    heroTimePreviousTail: CountTableRecord;
    ally: CountTableRecord;
    enemy: CountTableRecord;
  };
}

interface ValueCandidatePrediction {
  actionKey: string;
  actionUtility: number;
  actionAdvantage: number;
  actionWinProbability: number;
  supportedActionKeyCount: number;
}

interface ValuePredictionRow {
  decisionId: string;
  matchId: string;
  playerWon: boolean;
  targetUtility: number;
  matchWeight: number;
  observedActionKey: string;
  observedActionUtility: number;
  candidates: ValueCandidatePrediction[];
}

interface CandidatePolicyValue extends ValueCandidatePrediction {
  behaviorScore: number;
  behaviorProbability: number;
  targetScore: number;
  targetProbability: number;
}

export interface RecommendationPolicyV6Aggregate {
  decisionCount: number;
  evaluationWeightSum: number;
  rewardWeightedSum: number;
  ipsWeightedSum: number;
  snipsWeightedSum: number;
  importanceWeightWeightedSum: number;
  importanceWeightSquareSum: number;
  directWeightedSum: number;
  doublyRobustWeightedSum: number;
}

interface EvaluationCounters {
  behavioralValidationRowCount: number;
  valuePredictionRowCount: number;
  duplicateBehavioralDecisionCount: number;
  duplicateValueDecisionCount: number;
  missingBehavioralDecisionCount: number;
  identityMismatchDecisionCount: number;
  observedActionMismatchDecisionCount: number;
  candidateMismatchDecisionCount: number;
  candidateCoveredDecisionCount: number;
  candidateMissingObservedActionCount: number;
  lowBehaviorSupportDecisionCount: number;
  nonFiniteDecisionCount: number;
  supportedDecisionCount: number;
  clippedWeightDecisionCount: number;
  joinedDecisionCount: number;
}

interface SourceBundle {
  behavioralManifest: Record<string, unknown>;
  behavioralAudit: Record<string, unknown>;
  behavioralModel: BehavioralSerializedModel;
  valueManifest: Record<string, unknown>;
  valueAudit: Record<string, unknown>;
  hashes: {
    behavioralValidation: string;
    behavioralModel: string;
    valuePrediction: string;
    valueModel: string;
  };
  lineage: {
    behavioralDatasetV4Sha256: string;
    valueDatasetV4Sha256: string;
  };
}

interface EvaluationArtifacts {
  decisionEvaluation: string;
  matchSummary: string;
  evaluation: string;
  audit: string;
  manifest: string;
}

type CountTableRecord = Record<string, Record<string, number>>;

@Injectable()
export class RecommendationPolicyV6EvaluationService implements OnModuleInit {
  private readonly logger = new Logger(
    RecommendationPolicyV6EvaluationService.name,
  );
  private readonly behavioralDirectory =
    process.env[BEHAVIORAL_DIRECTORY_ENV]?.trim() ||
    DEFAULT_BEHAVIORAL_DIRECTORY;
  private readonly valueDirectory =
    process.env[VALUE_DIRECTORY_ENV]?.trim() || DEFAULT_VALUE_DIRECTORY;
  private readonly outputDirectory =
    process.env[OUTPUT_DIRECTORY_ENV]?.trim() || DEFAULT_OUTPUT_DIRECTORY;
  private readonly paths: EvaluationArtifacts = {
    decisionEvaluation: join(this.outputDirectory, 'decision-evaluation.ndjson'),
    matchSummary: join(this.outputDirectory, 'match-summary.ndjson'),
    evaluation: join(this.outputDirectory, 'evaluation.json'),
    audit: join(this.outputDirectory, 'audit.json'),
    manifest: join(this.outputDirectory, 'manifest.json'),
  };
  private status = this.createIdleStatus();
  private manifest?: Record<string, unknown>;
  private audit?: Record<string, unknown>;
  private evaluation?: Record<string, unknown>;
  private runPromise: Promise<void> = Promise.resolve();

  async onModuleInit(): Promise<void> {
    await mkdir(this.outputDirectory, { recursive: true });
    this.manifest = await readJson(this.paths.manifest);
    this.audit = await readJson(this.paths.audit);
    this.evaluation = await readJson(this.paths.evaluation);
    if (this.manifest && this.audit && this.evaluation) {
      const coverage = record(this.audit.coverage);
      this.status = {
        ...this.createIdleStatus(),
        state: 'COMPLETE',
        phase: 'COMPLETE',
        joinedDecisionCount: numeric(coverage.joinedDecisionCount),
        candidateCoveredDecisionCount: numeric(
          coverage.candidateCoveredDecisionCount,
        ),
        supportedDecisionCount: numeric(coverage.supportedDecisionCount),
        evaluatedDecisionCount: numeric(coverage.evaluatedDecisionCount),
        evaluatedMatchCount: numeric(coverage.evaluatedMatchCount),
        completedAt: text(this.manifest.generatedAt),
        manifestAvailable: true,
        auditAvailable: true,
        evaluationAvailable: true,
      };
    }
  }

  async start(
    request: RecommendationPolicyV6EvaluationStartRequest = {},
  ): Promise<RecommendationPolicyV6EvaluationStatus> {
    if (this.status.state === 'RUNNING') {
      throw new Error('Recommendation Policy V6 evaluation is already running.');
    }
    const options = normalizeOptions(request);
    this.status = {
      ...this.createIdleStatus(),
      state: 'RUNNING',
      startedAt: new Date().toISOString(),
      options,
      manifestAvailable: this.manifest !== undefined,
      auditAvailable: this.audit !== undefined,
      evaluationAvailable: this.evaluation !== undefined,
    };
    this.runPromise = this.run(options);
    return this.getStatus();
  }

  async waitForIdle(): Promise<void> {
    await this.runPromise;
  }

  getStatus(): RecommendationPolicyV6EvaluationStatus {
    return clone(this.status);
  }

  getManifest(): Record<string, unknown> | undefined {
    return this.manifest ? clone(this.manifest) : undefined;
  }

  getAudit(): Record<string, unknown> | undefined {
    return this.audit ? clone(this.audit) : undefined;
  }

  getEvaluation(): Record<string, unknown> | undefined {
    return this.evaluation ? clone(this.evaluation) : undefined;
  }

  private async run(
    options: RecommendationPolicyV6EvaluationOptions,
  ): Promise<void> {
    try {
      this.status = { ...this.status, phase: 'PREPARING' };
      const sources = await this.loadAndValidateSources(options);
      await mkdir(this.outputDirectory, { recursive: true });
      await this.clearOutputs();
      this.manifest = undefined;
      this.audit = undefined;
      this.evaluation = undefined;
      this.status = {
        ...this.status,
        manifestAvailable: false,
        auditAvailable: false,
        evaluationAvailable: false,
      };

      this.status = { ...this.status, phase: 'JOINING' };
      const behavioralRows = new Map<string, BehavioralPreparedRow>();
      const counters: EvaluationCounters = {
        behavioralValidationRowCount: 0,
        valuePredictionRowCount: 0,
        duplicateBehavioralDecisionCount: 0,
        duplicateValueDecisionCount: 0,
        missingBehavioralDecisionCount: 0,
        identityMismatchDecisionCount: 0,
        observedActionMismatchDecisionCount: 0,
        candidateMismatchDecisionCount: 0,
        candidateCoveredDecisionCount: 0,
        candidateMissingObservedActionCount: 0,
        lowBehaviorSupportDecisionCount: 0,
        nonFiniteDecisionCount: 0,
        supportedDecisionCount: 0,
        clippedWeightDecisionCount: 0,
        joinedDecisionCount: 0,
      };
      await eachNdjson(
        join(this.behavioralDirectory, 'validation.ndjson'),
        (value, lineNumber) => {
          const row = parseBehavioralPreparedRow(value, lineNumber);
          counters.behavioralValidationRowCount += 1;
          if (behavioralRows.has(row.decisionId)) {
            counters.duplicateBehavioralDecisionCount += 1;
          } else {
            behavioralRows.set(row.decisionId, row);
          }
        },
      );
      this.status = {
        ...this.status,
        processedBehavioralRowCount: counters.behavioralValidationRowCount,
        phase: 'EVALUATING',
      };

      const decisionWriter = await LineWriter.create(
        `${this.paths.decisionEvaluation}.partial`,
      );
      const aggregate = createMutableAggregate();
      const matches = new Map<string, RecommendationPolicyV6Aggregate>();
      const valueDecisionIds = new Set<string>();
      const rawWeights: number[] = [];
      const clippedWeights: number[] = [];
      const behaviorProbabilities: number[] = [];
      const targetEntropies: number[] = [];
      try {
        await eachNdjson(
          join(this.valueDirectory, 'prediction-evaluation.ndjson'),
          async (value, lineNumber) => {
            const valueRow = parseValuePredictionRow(value, lineNumber);
            counters.valuePredictionRowCount += 1;
            this.status = {
              ...this.status,
              processedValueRowCount: counters.valuePredictionRowCount,
            };
            if (valueDecisionIds.has(valueRow.decisionId)) {
              counters.duplicateValueDecisionCount += 1;
              return;
            }
            valueDecisionIds.add(valueRow.decisionId);
            const behavioralRow = behavioralRows.get(valueRow.decisionId);
            if (!behavioralRow) {
              counters.missingBehavioralDecisionCount += 1;
              await decisionWriter.write(
                excludedDecision(
                  valueRow,
                  'MISSING_BEHAVIORAL_VALIDATION_ROW',
                ),
              );
              return;
            }
            counters.joinedDecisionCount += 1;
            if (behavioralRow.matchId !== valueRow.matchId) {
              counters.identityMismatchDecisionCount += 1;
              await decisionWriter.write(
                excludedDecision(valueRow, 'MATCH_ID_MISMATCH'),
              );
              return;
            }
            if (behavioralRow.targetActionKey !== valueRow.observedActionKey) {
              counters.observedActionMismatchDecisionCount += 1;
              await decisionWriter.write(
                excludedDecision(valueRow, 'OBSERVED_ACTION_MISMATCH'),
              );
              return;
            }
            const candidates = valueRow.candidates.slice(
              0,
              options.maxCandidateActions,
            );
            const candidateActionKeys = candidates.map(
              (candidate) => candidate.actionKey,
            );
            const behavioralCandidates = new Set(
              behavioralRow.features.candidateActionKeys,
            );
            if (
              candidateActionKeys.some(
                (actionKey) => !behavioralCandidates.has(actionKey),
              )
            ) {
              counters.candidateMismatchDecisionCount += 1;
              await decisionWriter.write(
                excludedDecision(
                  valueRow,
                  'VALUE_CANDIDATE_NOT_IN_BEHAVIORAL_CANDIDATE_SET',
                ),
              );
              return;
            }
            if (!candidateActionKeys.includes(valueRow.observedActionKey)) {
              counters.candidateMissingObservedActionCount += 1;
              await decisionWriter.write(
                excludedDecision(
                  valueRow,
                  'OBSERVED_ACTION_NOT_IN_VALUE_CANDIDATES',
                ),
              );
              return;
            }
            counters.candidateCoveredDecisionCount += 1;
            const policies = buildCandidatePolicies(
              behavioralRow,
              candidates,
              sources.behavioralModel,
              options,
            );
            const observed = policies.find(
              (candidate) =>
                candidate.actionKey === valueRow.observedActionKey,
            );
            if (!observed || !candidatePoliciesAreFinite(policies)) {
              counters.nonFiniteDecisionCount += 1;
              await decisionWriter.write(
                excludedDecision(valueRow, 'NON_FINITE_POLICY_VALUE'),
              );
              return;
            }
            if (
              observed.behaviorProbability < options.minBehaviorProbability
            ) {
              counters.lowBehaviorSupportDecisionCount += 1;
              await decisionWriter.write({
                ...excludedDecision(
                  valueRow,
                  'LOW_ESTIMATED_BEHAVIOR_SUPPORT',
                ),
                behaviorProbability: observed.behaviorProbability,
                minimumBehaviorProbability: options.minBehaviorProbability,
                candidates: policies,
              });
              return;
            }
            counters.supportedDecisionCount += 1;
            const rawImportanceWeight =
              observed.targetProbability / observed.behaviorProbability;
            const clippedImportanceWeight = Math.min(
              rawImportanceWeight,
              options.maxImportanceWeight,
            );
            const clipped = clippedImportanceWeight < rawImportanceWeight;
            counters.clippedWeightDecisionCount += clipped ? 1 : 0;
            const directValue = policies.reduce(
              (sum, candidate) =>
                sum +
                candidate.targetProbability * candidate.actionUtility,
              0,
            );
            const doublyRobustContribution =
              directValue +
              clippedImportanceWeight *
                (valueRow.targetUtility - observed.actionUtility);
            const contribution: RecommendationPolicyV6DecisionContribution = {
              decisionId: valueRow.decisionId,
              matchId: valueRow.matchId,
              evaluationWeight: valueRow.matchWeight,
              reward: valueRow.targetUtility,
              observedActionKey: valueRow.observedActionKey,
              behaviorProbability: observed.behaviorProbability,
              targetProbability: observed.targetProbability,
              rawImportanceWeight,
              clippedImportanceWeight,
              clipped,
              directValue,
              observedActionValue: observed.actionUtility,
              ipsContribution:
                clippedImportanceWeight * valueRow.targetUtility,
              doublyRobustContribution,
            };
            addContribution(aggregate, contribution);
            const matchAggregate =
              matches.get(valueRow.matchId) ?? createMutableAggregate();
            addContribution(matchAggregate, contribution);
            matches.set(valueRow.matchId, matchAggregate);
            rawWeights.push(rawImportanceWeight);
            clippedWeights.push(clippedImportanceWeight);
            behaviorProbabilities.push(observed.behaviorProbability);
            targetEntropies.push(policyEntropy(policies));
            await decisionWriter.write({
              schemaVersion: RECOMMENDATION_POLICY_V6_EVALUATION_SCHEMA_VERSION,
              evaluationVersion: RECOMMENDATION_POLICY_V6_EVALUATION_VERSION,
              decisionId: valueRow.decisionId,
              matchId: valueRow.matchId,
              eligible: true,
              evaluationWeight: valueRow.matchWeight,
              reward: valueRow.targetUtility,
              playerWon: valueRow.playerWon,
              observedActionKey: valueRow.observedActionKey,
              behaviorProbability: observed.behaviorProbability,
              targetProbability: observed.targetProbability,
              rawImportanceWeight,
              clippedImportanceWeight,
              clipped,
              directValue,
              observedActionValue: observed.actionUtility,
              ipsContribution: contribution.ipsContribution,
              doublyRobustContribution,
              candidates: policies,
            });
            if (aggregate.decisionCount % 1_000 === 0) {
              this.status = {
                ...this.status,
                joinedDecisionCount: counters.joinedDecisionCount,
                candidateCoveredDecisionCount:
                  counters.candidateCoveredDecisionCount,
                supportedDecisionCount: counters.supportedDecisionCount,
                evaluatedDecisionCount: aggregate.decisionCount,
                evaluatedMatchCount: matches.size,
              };
            }
            if (aggregate.decisionCount % 10_000 === 0) {
              await tick();
            }
          },
        );
      } finally {
        await decisionWriter.close();
      }
      await promote(this.paths.decisionEvaluation);
      if (aggregate.decisionCount <= 0 || matches.size <= 0) {
        throw new Error(
          'Recommendation Policy V6 evaluation contains no supported held-out decisions.',
        );
      }

      const matchWriter = await LineWriter.create(
        `${this.paths.matchSummary}.partial`,
      );
      const matchContributions: RecommendationPolicyV6MatchContribution[] = [];
      try {
        for (const [matchId, matchAggregate] of [...matches.entries()].sort(
          ([left], [right]) => left.localeCompare(right),
        )) {
          const summary = toMatchContribution(matchId, matchAggregate);
          matchContributions.push(summary);
          await matchWriter.write(summary);
        }
      } finally {
        await matchWriter.close();
      }
      await promote(this.paths.matchSummary);

      this.status = {
        ...this.status,
        phase: 'BOOTSTRAPPING',
        joinedDecisionCount: counters.joinedDecisionCount,
        candidateCoveredDecisionCount: counters.candidateCoveredDecisionCount,
        supportedDecisionCount: counters.supportedDecisionCount,
        evaluatedDecisionCount: aggregate.decisionCount,
        evaluatedMatchCount: matches.size,
      };
      const estimators = finalizeRecommendationPolicyV6Estimators(
        aggregate,
        matches.size,
      );
      const bootstrap = bootstrapRecommendationPolicyV6(
        matchContributions,
        options.bootstrapReplicates,
        options.bootstrapSeed,
      );

      this.status = { ...this.status, phase: 'FINALIZING' };
      const generatedAt = new Date().toISOString();
      const coverage = {
        behavioralValidationRowCount: counters.behavioralValidationRowCount,
        valuePredictionRowCount: counters.valuePredictionRowCount,
        joinedDecisionCount: counters.joinedDecisionCount,
        joinRate: divide(
          counters.joinedDecisionCount,
          counters.valuePredictionRowCount,
        ),
        candidateCoveredDecisionCount:
          counters.candidateCoveredDecisionCount,
        candidateCoverageRate: divide(
          counters.candidateCoveredDecisionCount,
          counters.joinedDecisionCount,
        ),
        supportedDecisionCount: counters.supportedDecisionCount,
        behaviorSupportRate: divide(
          counters.supportedDecisionCount,
          counters.candidateCoveredDecisionCount,
        ),
        evaluatedDecisionCount: aggregate.decisionCount,
        evaluatedMatchCount: matches.size,
        evaluationWeightSum: aggregate.evaluationWeightSum,
        missingBehavioralDecisionCount:
          counters.missingBehavioralDecisionCount,
        identityMismatchDecisionCount:
          counters.identityMismatchDecisionCount,
        observedActionMismatchDecisionCount:
          counters.observedActionMismatchDecisionCount,
        candidateMismatchDecisionCount:
          counters.candidateMismatchDecisionCount,
        candidateMissingObservedActionCount:
          counters.candidateMissingObservedActionCount,
        lowBehaviorSupportDecisionCount:
          counters.lowBehaviorSupportDecisionCount,
        nonFiniteDecisionCount: counters.nonFiniteDecisionCount,
      };
      const diagnostics = {
        estimatedBehaviorPropensity: true,
        actualLoggingPropensityAvailable: false,
        rewardKind: 'VALUE_V6_BOUNDED_TARGET_UTILITY',
        weighting: 'VALUE_V6_EQUAL_TOTAL_WEIGHT_PER_MATCH',
        minBehaviorProbability: options.minBehaviorProbability,
        maxImportanceWeight: options.maxImportanceWeight,
        rawImportanceWeight: summarizeNumbers(rawWeights),
        clippedImportanceWeight: summarizeNumbers(clippedWeights),
        behaviorProbability: summarizeNumbers(behaviorProbabilities),
        targetPolicyEntropy: summarizeNumbers(targetEntropies),
        clippedWeightDecisionCount: counters.clippedWeightDecisionCount,
        clippedWeightRate: divide(
          counters.clippedWeightDecisionCount,
          aggregate.decisionCount,
        ),
        effectiveSampleSize: estimators.effectiveSampleSize,
        effectiveSampleSizeRatio: estimators.effectiveSampleSizeRatio,
        ipsSnipsAbsoluteDifference: Math.abs(
          estimators.inversePropensityValue -
            estimators.selfNormalizedInversePropensityValue,
        ),
      };
      const releaseGate = buildReleaseGate({
        estimators,
        bootstrap,
        coverage,
        diagnostics,
        behavioralReleaseGatePassed: readReleaseGatePassed(
          sources.behavioralManifest,
        ),
        valueReleaseGatePassed: readReleaseGatePassed(sources.valueManifest),
      });
      const warnings = [
        'Behavior propensities are estimated from Behavioral V4 and are not actual historical logging probabilities.',
        'Value V6 action utilities and advantages are observational and may contain selection bias or unobserved confounding.',
        'IPS, SNIPS, direct-method, and doubly robust estimates are diagnostic only and never authorize production rollout.',
      ];
      const evaluation = {
        schemaVersion: RECOMMENDATION_POLICY_V6_EVALUATION_SCHEMA_VERSION,
        evaluationVersion: RECOMMENDATION_POLICY_V6_EVALUATION_VERSION,
        generatedAt,
        evaluationKind: 'MATCH_BALANCED_DIAGNOSTIC_OFFLINE_POLICY_EVALUATION',
        causalInterpretationAllowed: false,
        rolloutAuthorization: 'FORBIDDEN',
        behaviorPolicy: {
          kind: 'ESTIMATED_PLAYER_ACTION_POLICY',
          source: 'BEHAVIORAL_V4_HELD_OUT_SCORE_SOFTMAX',
          actualLoggingPropensityAvailable: false,
          temperature: options.behaviorTemperature,
        },
        targetPolicy: {
          kind: 'STOCHASTIC_ADVANTAGE_TILTED_BEHAVIORAL_POLICY',
          formula:
            'softmax((behavioralScore + targetAdvantageWeight * actionAdvantage) / targetTemperature)',
          temperature: options.targetTemperature,
          targetAdvantageWeight: options.targetAdvantageWeight,
          candidateSetPolicy: 'RECORDED_AT_DECISION_TIME',
        },
        estimators,
        bootstrap,
        coverage,
        diagnostics,
        releaseGate,
        warnings,
      };
      const audit = {
        schemaVersion: RECOMMENDATION_POLICY_V6_EVALUATION_SCHEMA_VERSION,
        evaluationVersion: RECOMMENDATION_POLICY_V6_EVALUATION_VERSION,
        generatedAt,
        passed:
          counters.duplicateBehavioralDecisionCount === 0 &&
          counters.duplicateValueDecisionCount === 0 &&
          counters.identityMismatchDecisionCount === 0 &&
          counters.observedActionMismatchDecisionCount === 0 &&
          aggregate.decisionCount > 0 &&
          matches.size > 0 &&
          Number.isFinite(estimators.doublyRobustValue),
        source: {
          behavioralDirectory: this.behavioralDirectory,
          valueDirectory: this.valueDirectory,
          behavioralModelVersion: RECOMMENDATION_BEHAVIORAL_V4_MODEL_VERSION,
          valueModelVersion: RECOMMENDATION_VALUE_V6_MODEL_VERSION,
          valueDatasetVersion: readNestedString(
            sources.valueManifest,
            ['source', 'datasetVersion'],
          ),
          lineage: sources.lineage,
          hashes: sources.hashes,
          behavioralAuditPassed: sources.behavioralAudit.passed === true,
          valueAuditPassed: sources.valueAudit.passed === true,
        },
        integrity: {
          duplicateBehavioralDecisionCount:
            counters.duplicateBehavioralDecisionCount,
          duplicateValueDecisionCount: counters.duplicateValueDecisionCount,
          missingBehavioralDecisionCount:
            counters.missingBehavioralDecisionCount,
          identityMismatchDecisionCount:
            counters.identityMismatchDecisionCount,
          observedActionMismatchDecisionCount:
            counters.observedActionMismatchDecisionCount,
          candidateMismatchDecisionCount:
            counters.candidateMismatchDecisionCount,
          nonFiniteDecisionCount: counters.nonFiniteDecisionCount,
        },
        coverage,
        diagnostics,
        leakage: {
          evaluationRows:
            'INTERSECTION_OF_BEHAVIORAL_V4_VALIDATION_AND_VALUE_V6_UNTOUCHED_TEST',
          targetUtilityUsedForPolicyScoring: false,
          observedActionUsedOnlyForImportanceWeightAndRewardCorrection: true,
          valueActionAdvantageUsedForTargetPolicyScoring: true,
          matchLevelBootstrap: true,
          matchBalancedEvaluationWeights: true,
          causalInterpretationAllowed: false,
          productionRolloutAuthorized: false,
        },
        warnings,
      };
      await Promise.all([
        atomicJson(this.paths.evaluation, evaluation),
        atomicJson(this.paths.audit, audit),
      ]);
      const manifest = await buildManifest({
        generatedAt,
        options,
        paths: this.paths,
        sources,
        behavioralDirectory: this.behavioralDirectory,
        valueDirectory: this.valueDirectory,
        coverage,
        auditPassed: audit.passed,
        releaseGate,
        warnings,
      });
      await atomicJson(this.paths.manifest, manifest);
      this.evaluation = evaluation;
      this.audit = audit;
      this.manifest = manifest;
      this.status = {
        ...this.status,
        state: 'COMPLETE',
        phase: 'COMPLETE',
        completedAt: generatedAt,
        joinedDecisionCount: counters.joinedDecisionCount,
        candidateCoveredDecisionCount:
          counters.candidateCoveredDecisionCount,
        supportedDecisionCount: counters.supportedDecisionCount,
        evaluatedDecisionCount: aggregate.decisionCount,
        evaluatedMatchCount: matches.size,
        manifestAvailable: true,
        auditAvailable: true,
        evaluationAvailable: true,
        error: undefined,
      };
      this.logger.log(
        `Recommendation Policy V6 evaluation completed: ${aggregate.decisionCount} decisions, ` +
          `${matches.size} matches, shadow-readiness gate ${releaseGate.passed ? 'PASS' : 'FAIL'}.`,
      );
    } catch (error) {
      const message = errorMessage(error);
      this.status = {
        ...this.status,
        state: 'FAILED',
        completedAt: new Date().toISOString(),
        error: message,
      };
      this.logger.error(
        `Recommendation Policy V6 evaluation failed: ${message}`,
      );
    }
  }

  private async loadAndValidateSources(
    options: RecommendationPolicyV6EvaluationOptions,
  ): Promise<SourceBundle> {
    const behavioralManifest = await requiredJson(
      join(this.behavioralDirectory, 'manifest.json'),
    );
    const behavioralAudit = await requiredJson(
      join(this.behavioralDirectory, 'audit.json'),
    );
    const behavioralModelValue = await requiredJson(
      join(this.behavioralDirectory, 'model.json'),
    );
    const valueManifest = await requiredJson(
      join(this.valueDirectory, 'manifest.json'),
    );
    const valueAudit = await requiredJson(
      join(this.valueDirectory, 'audit.json'),
    );
    if (
      behavioralManifest.auditPassed !== true ||
      behavioralAudit.passed !== true
    ) {
      throw new Error('Recommendation Behavioral V4 training did not pass audit.');
    }
    if (valueAudit.passed !== true) {
      throw new Error('Recommendation Value V6 training did not pass audit.');
    }
    if (
      readNestedString(valueManifest, ['source', 'datasetVersion']) !==
      RECOMMENDATION_DECISION_DATASET_V5_VERSION
    ) {
      throw new Error('Recommendation Policy V6 requires Dataset V5.3 lineage.');
    }
    const behavioralDatasetV4Sha256 = requiredSha(
      readNestedString(behavioralManifest, [
        'source',
        'artifactSha256',
      ]),
      'Behavioral V4 source Dataset V4 SHA-256',
    );
    const valueDatasetV4Sha256 = requiredSha(
      readNestedString(valueManifest, [
        'source',
        'upstreamDatasetV4Sha256',
      ]),
      'Value V6 upstream Dataset V4 SHA-256',
    );
    if (behavioralDatasetV4Sha256 !== valueDatasetV4Sha256) {
      throw new Error(
        'Behavioral V4 and Value V6 do not share the same Dataset V4 lineage.',
      );
    }
    const behavioralModel = parseBehavioralModel(behavioralModelValue);
    const hashes = {
      behavioralValidation: await hashFile(
        join(this.behavioralDirectory, 'validation.ndjson'),
      ),
      behavioralModel: await hashFile(
        join(this.behavioralDirectory, 'model.json'),
      ),
      valuePrediction: await hashFile(
        join(this.valueDirectory, 'prediction-evaluation.ndjson'),
      ),
      valueModel: await hashFile(join(this.valueDirectory, 'model.json')),
    };
    assertHash(
      hashes.behavioralValidation,
      readNestedString(behavioralManifest, [
        'artifacts',
        'validation',
        'sha256',
      ]),
      'Behavioral V4 validation artifact',
    );
    assertHash(
      hashes.behavioralModel,
      readNestedString(behavioralManifest, ['artifacts', 'model', 'sha256']),
      'Behavioral V4 model artifact',
    );
    assertHash(
      hashes.valuePrediction,
      readNestedString(valueManifest, [
        'artifacts',
        'predictionEvaluation',
        'sha256',
      ]),
      'Value V6 prediction evaluation artifact',
    );
    assertHash(
      hashes.valueModel,
      readNestedString(valueManifest, ['artifacts', 'model', 'sha256']),
      'Value V6 model artifact',
    );
    assertOptionalExpectedHash(
      options.expectedBehavioralModelSha256,
      hashes.behavioralModel,
      'Behavioral V4 model',
    );
    assertOptionalExpectedHash(
      options.expectedValuePredictionSha256,
      hashes.valuePrediction,
      'Value V6 prediction evaluation',
    );
    assertOptionalExpectedHash(
      options.expectedValueModelSha256,
      hashes.valueModel,
      'Value V6 model',
    );
    return {
      behavioralManifest,
      behavioralAudit,
      behavioralModel,
      valueManifest,
      valueAudit,
      hashes,
      lineage: {
        behavioralDatasetV4Sha256,
        valueDatasetV4Sha256,
      },
    };
  }

  private async clearOutputs(): Promise<void> {
    await Promise.all(
      Object.values(this.paths).flatMap((path) => [
        rm(path, { force: true }),
        rm(`${path}.partial`, { force: true }),
      ]),
    );
  }

  private createIdleStatus(): RecommendationPolicyV6EvaluationStatus {
    return {
      state: 'IDLE',
      phase: 'PREPARING',
      processedBehavioralRowCount: 0,
      processedValueRowCount: 0,
      joinedDecisionCount: 0,
      candidateCoveredDecisionCount: 0,
      supportedDecisionCount: 0,
      evaluatedDecisionCount: 0,
      evaluatedMatchCount: 0,
      outputDirectory: this.outputDirectory,
      manifestAvailable: false,
      auditAvailable: false,
      evaluationAvailable: false,
    };
  }
}

export function softmaxRecommendationPolicyV6(
  scores: readonly number[],
  temperature = 1,
): number[] {
  if (scores.length === 0) {
    return [];
  }
  if (!Number.isFinite(temperature) || temperature <= 0) {
    throw new Error('temperature must be greater than zero.');
  }
  if (scores.some((score) => !Number.isFinite(score))) {
    throw new Error('Softmax scores must be finite.');
  }
  const scaled = scores.map((score) => score / temperature);
  const maximum = Math.max(...scaled);
  const exponentials = scaled.map((score) => Math.exp(score - maximum));
  const total = exponentials.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error('Softmax normalization failed.');
  }
  return exponentials.map((value) => value / total);
}

export function createRecommendationPolicyV6Contribution(input: {
  decisionId: string;
  matchId: string;
  evaluationWeight: number;
  reward: number;
  observedActionKey: string;
  behaviorProbability: number;
  targetProbability: number;
  directValue: number;
  observedActionValue: number;
  maxImportanceWeight: number;
}): RecommendationPolicyV6DecisionContribution {
  if (
    !Number.isFinite(input.behaviorProbability) ||
    input.behaviorProbability < PROBABILITY_EPSILON
  ) {
    throw new Error('behaviorProbability must be positive and finite.');
  }
  if (
    !Number.isFinite(input.targetProbability) ||
    input.targetProbability < 0
  ) {
    throw new Error('targetProbability must be non-negative and finite.');
  }
  if (!Number.isFinite(input.evaluationWeight) || input.evaluationWeight <= 0) {
    throw new Error('evaluationWeight must be positive and finite.');
  }
  const rawImportanceWeight =
    input.targetProbability / input.behaviorProbability;
  const clippedImportanceWeight = Math.min(
    rawImportanceWeight,
    input.maxImportanceWeight,
  );
  const doublyRobustContribution =
    input.directValue +
    clippedImportanceWeight * (input.reward - input.observedActionValue);
  return {
    decisionId: input.decisionId,
    matchId: input.matchId,
    evaluationWeight: input.evaluationWeight,
    reward: input.reward,
    observedActionKey: input.observedActionKey,
    behaviorProbability: input.behaviorProbability,
    targetProbability: input.targetProbability,
    rawImportanceWeight,
    clippedImportanceWeight,
    clipped: clippedImportanceWeight < rawImportanceWeight,
    directValue: input.directValue,
    observedActionValue: input.observedActionValue,
    ipsContribution: clippedImportanceWeight * input.reward,
    doublyRobustContribution,
  };
}

export function finalizeRecommendationPolicyV6Estimators(
  aggregate: RecommendationPolicyV6Aggregate,
  matchCount: number,
): RecommendationPolicyV6EstimatorSummary {
  const observedValue = divide(
    aggregate.rewardWeightedSum,
    aggregate.evaluationWeightSum,
  );
  const inversePropensityValue = divide(
    aggregate.ipsWeightedSum,
    aggregate.evaluationWeightSum,
  );
  const selfNormalizedInversePropensityValue = divide(
    aggregate.snipsWeightedSum,
    aggregate.importanceWeightWeightedSum,
  );
  const directMethodValue = divide(
    aggregate.directWeightedSum,
    aggregate.evaluationWeightSum,
  );
  const doublyRobustValue = divide(
    aggregate.doublyRobustWeightedSum,
    aggregate.evaluationWeightSum,
  );
  const effectiveSampleSize = divide(
    aggregate.importanceWeightWeightedSum *
      aggregate.importanceWeightWeightedSum,
    aggregate.importanceWeightSquareSum,
  );
  return {
    decisionCount: aggregate.decisionCount,
    matchCount,
    evaluationWeightSum: aggregate.evaluationWeightSum,
    observedValue,
    inversePropensityValue,
    selfNormalizedInversePropensityValue,
    directMethodValue,
    doublyRobustValue,
    effectiveSampleSize,
    effectiveSampleSizeRatio: divide(
      effectiveSampleSize,
      aggregate.decisionCount,
    ),
    deltasVsObserved: {
      inversePropensity: inversePropensityValue - observedValue,
      selfNormalizedInversePropensity:
        selfNormalizedInversePropensityValue - observedValue,
      directMethod: directMethodValue - observedValue,
      doublyRobust: doublyRobustValue - observedValue,
    },
  };
}

export function bootstrapRecommendationPolicyV6(
  matches: readonly RecommendationPolicyV6MatchContribution[],
  replicateCount: number,
  seed: number,
): RecommendationPolicyV6BootstrapSummary {
  if (matches.length === 0) {
    throw new Error('At least one match is required for bootstrap.');
  }
  if (!Number.isSafeInteger(replicateCount) || replicateCount < 1) {
    throw new Error('bootstrapReplicates must be a positive safe integer.');
  }
  const random = createSeededRandom(seed);
  const values: Record<string, number[]> = {
    observedValue: [],
    inversePropensityValue: [],
    selfNormalizedInversePropensityValue: [],
    directMethodValue: [],
    doublyRobustValue: [],
    inversePropensityDelta: [],
    selfNormalizedInversePropensityDelta: [],
    directMethodDelta: [],
    doublyRobustDelta: [],
  };
  for (let replicate = 0; replicate < replicateCount; replicate += 1) {
    const aggregate = createMutableAggregate();
    for (let index = 0; index < matches.length; index += 1) {
      const selected = matches[Math.floor(random() * matches.length)];
      addMatchAggregate(aggregate, selected);
    }
    const summary = finalizeRecommendationPolicyV6Estimators(
      aggregate,
      matches.length,
    );
    values.observedValue.push(summary.observedValue);
    values.inversePropensityValue.push(summary.inversePropensityValue);
    values.selfNormalizedInversePropensityValue.push(
      summary.selfNormalizedInversePropensityValue,
    );
    values.directMethodValue.push(summary.directMethodValue);
    values.doublyRobustValue.push(summary.doublyRobustValue);
    values.inversePropensityDelta.push(
      summary.deltasVsObserved.inversePropensity,
    );
    values.selfNormalizedInversePropensityDelta.push(
      summary.deltasVsObserved.selfNormalizedInversePropensity,
    );
    values.directMethodDelta.push(summary.deltasVsObserved.directMethod);
    values.doublyRobustDelta.push(summary.deltasVsObserved.doublyRobust);
  }
  return {
    confidenceLevel: 0.95,
    replicateCount,
    seed,
    intervals: Object.fromEntries(
      Object.entries(values).map(([name, samples]) => [
        name,
        {
          lower: quantile(samples, 0.025),
          median: quantile(samples, 0.5),
          upper: quantile(samples, 0.975),
        },
      ]),
    ),
  };
}

function buildCandidatePolicies(
  row: BehavioralPreparedRow,
  candidates: readonly ValueCandidatePrediction[],
  behavioralModel: BehavioralSerializedModel,
  options: RecommendationPolicyV6EvaluationOptions,
): CandidatePolicyValue[] {
  const behaviorScores = candidates.map((candidate) =>
    behavioralScore(
      row,
      candidate.actionKey,
      candidates.length,
      behavioralModel,
    ),
  );
  const behaviorProbabilities = softmaxRecommendationPolicyV6(
    behaviorScores,
    options.behaviorTemperature,
  );
  const targetScores = behaviorScores.map(
    (score, index) =>
      score +
      options.targetAdvantageWeight * candidates[index].actionAdvantage,
  );
  const targetProbabilities = softmaxRecommendationPolicyV6(
    targetScores,
    options.targetTemperature,
  );
  return candidates.map((candidate, index) => ({
    ...candidate,
    behaviorScore: behaviorScores[index],
    behaviorProbability: behaviorProbabilities[index],
    targetScore: targetScores[index],
    targetProbability: targetProbabilities[index],
  }));
}

function behavioralScore(
  row: BehavioralPreparedRow,
  actionKey: string,
  candidateCount: number,
  model: BehavioralSerializedModel,
): number {
  const features = row.features;
  const baseKey = `${features.heroId}|${features.timeBucket}`;
  const heroCounts = model.counts.hero[String(features.heroId)];
  const heroTimeCounts = model.counts.heroTime[baseKey];
  const baseCounts = hasMinimumCountObservations(
    heroTimeCounts,
    model.options.minContextObservations,
  )
    ? heroTimeCounts
    : heroCounts;
  const base = logProbability(
    baseCounts,
    actionKey,
    candidateCount,
    model.options.smoothing,
  );
  const contextual = (
    counts: Record<string, number> | undefined,
  ): number =>
    hasMinimumCountObservations(
      counts,
      model.options.minContextObservations,
    )
      ? logProbability(
          counts,
          actionKey,
          candidateCount,
          model.options.smoothing,
        )
      : base;
  const inventory = contextual(
    model.counts.heroTimeInventory[
      `${baseKey}|${features.inventoryStateKey}`
    ],
  );
  const previousTail = contextual(
    model.counts.heroTimePreviousTail[
      `${baseKey}|${features.previousActionTailKey}`
    ],
  );
  const allies = features.alliedHeroIds.map((heroId) =>
    contextual(model.counts.ally[`${baseKey}|${heroId}`]),
  );
  const enemies = features.enemyHeroIds.map((heroId) =>
    contextual(model.counts.enemy[`${baseKey}|${heroId}`]),
  );
  return (
    base +
    model.weights.inventoryDelta * (inventory - base) +
    model.weights.previousActionTailDelta * (previousTail - base) +
    model.weights.alliedRosterDeltaAverage *
      (averageOr(allies, base) - base) +
    model.weights.enemyRosterDeltaAverage *
      (averageOr(enemies, base) - base)
  );
}

function parseBehavioralModel(
  value: Record<string, unknown>,
): BehavioralSerializedModel {
  if (value.modelVersion !== RECOMMENDATION_BEHAVIORAL_V4_MODEL_VERSION) {
    throw new Error('Unexpected Recommendation Behavioral V4 model version.');
  }
  const options = record(value.options);
  const weights = record(value.weights);
  const counts = record(value.counts);
  return {
    modelVersion: RECOMMENDATION_BEHAVIORAL_V4_MODEL_VERSION,
    options: {
      smoothing: positiveNumber(options.smoothing, 'behavioral smoothing'),
      minContextObservations: positiveInteger(
        options.minContextObservations,
        'behavioral minContextObservations',
      ),
    },
    weights: {
      inventoryDelta: finiteNumber(
        weights.inventoryDelta,
        'behavioral inventoryDelta',
      ),
      previousActionTailDelta: finiteNumber(
        weights.previousActionTailDelta,
        'behavioral previousActionTailDelta',
      ),
      alliedRosterDeltaAverage: finiteNumber(
        weights.alliedRosterDeltaAverage,
        'behavioral alliedRosterDeltaAverage',
      ),
      enemyRosterDeltaAverage: finiteNumber(
        weights.enemyRosterDeltaAverage,
        'behavioral enemyRosterDeltaAverage',
      ),
    },
    counts: {
      hero: countTable(counts.hero, 'behavioral hero counts'),
      heroTime: countTable(counts.heroTime, 'behavioral heroTime counts'),
      heroTimeInventory: countTable(
        counts.heroTimeInventory,
        'behavioral heroTimeInventory counts',
      ),
      heroTimePreviousTail: countTable(
        counts.heroTimePreviousTail,
        'behavioral heroTimePreviousTail counts',
      ),
      ally: countTable(counts.ally, 'behavioral ally counts'),
      enemy: countTable(counts.enemy, 'behavioral enemy counts'),
    },
  };
}

function parseBehavioralPreparedRow(
  value: unknown,
  lineNumber: number,
): BehavioralPreparedRow {
  const row = record(value);
  const features = record(row.features);
  const target = record(row.target);
  const decisionId = requiredText(
    row.decisionId,
    `behavioral line ${lineNumber} decisionId`,
  );
  const matchId = requiredText(
    row.matchId,
    `behavioral line ${lineNumber} matchId`,
  );
  return {
    decisionId,
    matchId,
    decisionOccurredAt: requiredText(
      row.decisionOccurredAt,
      `behavioral line ${lineNumber} decisionOccurredAt`,
    ),
    features: {
      heroId: positiveInteger(
        features.heroId,
        `behavioral line ${lineNumber} heroId`,
      ),
      teamId:
        features.teamId === undefined
          ? undefined
          : finiteNumber(
              features.teamId,
              `behavioral line ${lineNumber} teamId`,
            ),
      timeBucket: nonNegativeInteger(
        features.timeBucket,
        `behavioral line ${lineNumber} timeBucket`,
      ),
      inventoryStateKey: requiredText(
        features.inventoryStateKey,
        `behavioral line ${lineNumber} inventoryStateKey`,
      ),
      previousActionTailKey: requiredText(
        features.previousActionTailKey,
        `behavioral line ${lineNumber} previousActionTailKey`,
      ),
      alliedHeroIds: numberArray(features.alliedHeroIds),
      enemyHeroIds: numberArray(features.enemyHeroIds),
      candidateActionKeys: uniqueStrings(
        stringArray(features.candidateActionKeys),
      ),
    },
    targetActionKey: requiredText(
      target.actionKey,
      `behavioral line ${lineNumber} target.actionKey`,
    ),
  };
}

function parseValuePredictionRow(
  value: unknown,
  lineNumber: number,
): ValuePredictionRow {
  const row = record(value);
  if (row.modelVersion !== RECOMMENDATION_VALUE_V6_MODEL_VERSION) {
    throw new Error(
      `Value V6 prediction line ${lineNumber} has an unexpected model version.`,
    );
  }
  const candidates = records(row.candidateRanking).map(
    (candidate, index): ValueCandidatePrediction => ({
      actionKey: requiredText(
        candidate.actionKey,
        `Value V6 line ${lineNumber} candidate ${index} actionKey`,
      ),
      actionUtility: finiteNumber(
        candidate.actionUtility,
        `Value V6 line ${lineNumber} candidate ${index} actionUtility`,
      ),
      actionAdvantage: finiteNumber(
        candidate.actionAdvantage,
        `Value V6 line ${lineNumber} candidate ${index} actionAdvantage`,
      ),
      actionWinProbability: finiteNumber(
        candidate.actionWinProbability,
        `Value V6 line ${lineNumber} candidate ${index} actionWinProbability`,
      ),
      supportedActionKeyCount: nonNegativeInteger(
        candidate.supportedActionKeyCount,
        `Value V6 line ${lineNumber} candidate ${index} supportedActionKeyCount`,
      ),
    }),
  );
  const uniqueCandidates = uniqueStrings(
    candidates.map((candidate) => candidate.actionKey),
  );
  if (uniqueCandidates.length !== candidates.length || candidates.length === 0) {
    throw new Error(
      `Value V6 prediction line ${lineNumber} must contain unique candidates.`,
    );
  }
  const targetUtility = finiteNumber(
    row.targetUtility,
    `Value V6 line ${lineNumber} targetUtility`,
  );
  if (targetUtility < -1 - 1e-9 || targetUtility > 1 + 1e-9) {
    throw new Error(
      `Value V6 prediction line ${lineNumber} targetUtility is outside [-1, 1].`,
    );
  }
  return {
    decisionId: requiredText(
      row.decisionId,
      `Value V6 line ${lineNumber} decisionId`,
    ),
    matchId: requiredText(
      row.matchId,
      `Value V6 line ${lineNumber} matchId`,
    ),
    playerWon: requiredBoolean(
      row.playerWon,
      `Value V6 line ${lineNumber} playerWon`,
    ),
    targetUtility,
    matchWeight: positiveNumber(
      row.matchWeight,
      `Value V6 line ${lineNumber} matchWeight`,
    ),
    observedActionKey: requiredText(
      row.observedActionKey,
      `Value V6 line ${lineNumber} observedActionKey`,
    ),
    observedActionUtility: finiteNumber(
      row.observedActionUtility,
      `Value V6 line ${lineNumber} observedActionUtility`,
    ),
    candidates,
  };
}

function excludedDecision(
  row: ValuePredictionRow,
  exclusionReason: string,
): Record<string, unknown> {
  return {
    schemaVersion: RECOMMENDATION_POLICY_V6_EVALUATION_SCHEMA_VERSION,
    evaluationVersion: RECOMMENDATION_POLICY_V6_EVALUATION_VERSION,
    decisionId: row.decisionId,
    matchId: row.matchId,
    eligible: false,
    exclusionReason,
  };
}

function candidatePoliciesAreFinite(
  candidates: readonly CandidatePolicyValue[],
): boolean {
  return (
    candidates.length > 0 &&
    candidates.every((candidate) =>
      [
        candidate.actionUtility,
        candidate.actionAdvantage,
        candidate.actionWinProbability,
        candidate.behaviorScore,
        candidate.behaviorProbability,
        candidate.targetScore,
        candidate.targetProbability,
      ].every(Number.isFinite),
    )
  );
}

function createMutableAggregate(): RecommendationPolicyV6Aggregate {
  return {
    decisionCount: 0,
    evaluationWeightSum: 0,
    rewardWeightedSum: 0,
    ipsWeightedSum: 0,
    snipsWeightedSum: 0,
    importanceWeightWeightedSum: 0,
    importanceWeightSquareSum: 0,
    directWeightedSum: 0,
    doublyRobustWeightedSum: 0,
  };
}

function addContribution(
  aggregate: RecommendationPolicyV6Aggregate,
  contribution: RecommendationPolicyV6DecisionContribution,
): void {
  const weight = contribution.evaluationWeight;
  const weightedImportance = weight * contribution.clippedImportanceWeight;
  aggregate.decisionCount += 1;
  aggregate.evaluationWeightSum += weight;
  aggregate.rewardWeightedSum += weight * contribution.reward;
  aggregate.ipsWeightedSum += weight * contribution.ipsContribution;
  aggregate.snipsWeightedSum += weight * contribution.ipsContribution;
  aggregate.importanceWeightWeightedSum += weightedImportance;
  aggregate.importanceWeightSquareSum += weightedImportance * weightedImportance;
  aggregate.directWeightedSum += weight * contribution.directValue;
  aggregate.doublyRobustWeightedSum +=
    weight * contribution.doublyRobustContribution;
}

function toMatchContribution(
  matchId: string,
  aggregate: RecommendationPolicyV6Aggregate,
): RecommendationPolicyV6MatchContribution {
  return { matchId, ...aggregate };
}

function addMatchAggregate(
  aggregate: RecommendationPolicyV6Aggregate,
  match: RecommendationPolicyV6MatchContribution,
): void {
  aggregate.decisionCount += match.decisionCount;
  aggregate.evaluationWeightSum += match.evaluationWeightSum;
  aggregate.rewardWeightedSum += match.rewardWeightedSum;
  aggregate.ipsWeightedSum += match.ipsWeightedSum;
  aggregate.snipsWeightedSum += match.snipsWeightedSum;
  aggregate.importanceWeightWeightedSum +=
    match.importanceWeightWeightedSum;
  aggregate.importanceWeightSquareSum += match.importanceWeightSquareSum;
  aggregate.directWeightedSum += match.directWeightedSum;
  aggregate.doublyRobustWeightedSum += match.doublyRobustWeightedSum;
}

function buildReleaseGate(input: {
  estimators: RecommendationPolicyV6EstimatorSummary;
  bootstrap: RecommendationPolicyV6BootstrapSummary;
  coverage: Record<string, unknown>;
  diagnostics: Record<string, unknown>;
  behavioralReleaseGatePassed: boolean;
  valueReleaseGatePassed: boolean;
}): Record<string, unknown> {
  const drInterval =
    input.bootstrap.intervals.doublyRobustDelta ??
    { lower: Number.NEGATIVE_INFINITY, median: 0, upper: 0 };
  const conditions = [
    {
      name: 'behavioralReleaseGatePassed',
      passed: input.behavioralReleaseGatePassed,
      actual: input.behavioralReleaseGatePassed,
      required: true,
    },
    {
      name: 'valueReleaseGatePassed',
      passed: input.valueReleaseGatePassed,
      actual: input.valueReleaseGatePassed,
      required: true,
    },
    {
      name: 'minimumEvaluatedMatches',
      passed: input.estimators.matchCount >= 100,
      actual: input.estimators.matchCount,
      minimum: 100,
    },
    {
      name: 'candidateCoverageRate',
      passed: numeric(input.coverage.candidateCoverageRate) >= 0.9,
      actual: numeric(input.coverage.candidateCoverageRate),
      minimum: 0.9,
    },
    {
      name: 'behaviorSupportRate',
      passed: numeric(input.coverage.behaviorSupportRate) >= 0.8,
      actual: numeric(input.coverage.behaviorSupportRate),
      minimum: 0.8,
    },
    {
      name: 'effectiveSampleSizeRatio',
      passed: input.estimators.effectiveSampleSizeRatio >= 0.1,
      actual: input.estimators.effectiveSampleSizeRatio,
      minimum: 0.1,
    },
    {
      name: 'clippedWeightRate',
      passed: numeric(input.diagnostics.clippedWeightRate) <= 0.5,
      actual: numeric(input.diagnostics.clippedWeightRate),
      maximum: 0.5,
    },
    {
      name: 'doublyRobustValueFinite',
      passed: Number.isFinite(input.estimators.doublyRobustValue),
      actual: input.estimators.doublyRobustValue,
      required: 'finite',
    },
    {
      name: 'doublyRobustLowerBoundSafety',
      passed: drInterval.lower >= -0.05,
      actual: drInterval.lower,
      minimum: -0.05,
    },
  ];
  const failed = conditions
    .filter((condition) => !condition.passed)
    .map((condition) => condition.name);
  return {
    passed: failed.length === 0,
    authorization: 'OFFLINE_AND_SHADOW_ONLY',
    productionRolloutAuthorized: false,
    conditions,
    reasons: failed,
  };
}

async function buildManifest(input: {
  generatedAt: string;
  options: RecommendationPolicyV6EvaluationOptions;
  paths: EvaluationArtifacts;
  sources: SourceBundle;
  behavioralDirectory: string;
  valueDirectory: string;
  coverage: Record<string, unknown>;
  auditPassed: boolean;
  releaseGate: Record<string, unknown>;
  warnings: string[];
}): Promise<Record<string, unknown>> {
  const artifacts = {
    decisionEvaluation: await artifactDescription(
      input.paths.decisionEvaluation,
      'NDJSON',
    ),
    matchSummary: await artifactDescription(
      input.paths.matchSummary,
      'NDJSON',
    ),
    evaluation: await artifactDescription(input.paths.evaluation, 'JSON'),
    audit: await artifactDescription(input.paths.audit, 'JSON'),
  };
  return {
    schemaVersion: RECOMMENDATION_POLICY_V6_EVALUATION_SCHEMA_VERSION,
    evaluationVersion: RECOMMENDATION_POLICY_V6_EVALUATION_VERSION,
    generatedAt: input.generatedAt,
    source: {
      behavioralDirectory: input.behavioralDirectory,
      valueDirectory: input.valueDirectory,
      behavioralModelVersion: RECOMMENDATION_BEHAVIORAL_V4_MODEL_VERSION,
      valueModelVersion: RECOMMENDATION_VALUE_V6_MODEL_VERSION,
      valueDatasetVersion: readNestedString(
        input.sources.valueManifest,
        ['source', 'datasetVersion'],
      ),
      lineage: input.sources.lineage,
      hashes: input.sources.hashes,
    },
    policy: {
      behavior: 'BEHAVIORAL_V4_HELD_OUT_SCORE_SOFTMAX',
      target: 'BEHAVIOR_PLUS_VALUE_V6_ADVANTAGE_TILT',
      reward: 'VALUE_V6_BOUNDED_TARGET_UTILITY',
      weighting: 'VALUE_V6_EQUAL_TOTAL_WEIGHT_PER_MATCH',
      options: input.options,
    },
    coverage: input.coverage,
    artifacts,
    auditPassed: input.auditPassed,
    releaseGatePassed: input.releaseGate.passed === true,
    productionRolloutAuthorized: false,
    warnings: input.warnings,
  };
}

async function artifactDescription(
  path: string,
  format: 'JSON' | 'NDJSON',
): Promise<Record<string, unknown>> {
  const fileStat = await stat(path);
  return {
    format,
    fileName: path.split('/').pop() ?? path,
    byteLength: fileStat.size,
    sha256: await hashFile(path),
  };
}

function normalizeOptions(
  request: RecommendationPolicyV6EvaluationStartRequest,
): RecommendationPolicyV6EvaluationOptions {
  return {
    behaviorTemperature: boundedNumber(
      request.behaviorTemperature,
      1,
      0.01,
      100,
      'behaviorTemperature',
    ),
    targetTemperature: boundedNumber(
      request.targetTemperature,
      1,
      0.01,
      100,
      'targetTemperature',
    ),
    targetAdvantageWeight: boundedNumber(
      request.targetAdvantageWeight,
      1,
      0,
      100,
      'targetAdvantageWeight',
    ),
    minBehaviorProbability: boundedNumber(
      request.minBehaviorProbability,
      0.01,
      PROBABILITY_EPSILON,
      1,
      'minBehaviorProbability',
    ),
    maxImportanceWeight: boundedNumber(
      request.maxImportanceWeight,
      10,
      1,
      10_000,
      'maxImportanceWeight',
    ),
    bootstrapReplicates: boundedInteger(
      request.bootstrapReplicates,
      1_000,
      1,
      100_000,
      'bootstrapReplicates',
    ),
    bootstrapSeed: boundedInteger(
      request.bootstrapSeed,
      20_260_726,
      0,
      2_147_483_647,
      'bootstrapSeed',
    ),
    maxCandidateActions: boundedInteger(
      request.maxCandidateActions,
      128,
      2,
      512,
      'maxCandidateActions',
    ),
    expectedBehavioralModelSha256: optionalSha(
      request.expectedBehavioralModelSha256,
      'expectedBehavioralModelSha256',
    ),
    expectedValuePredictionSha256: optionalSha(
      request.expectedValuePredictionSha256,
      'expectedValuePredictionSha256',
    ),
    expectedValueModelSha256: optionalSha(
      request.expectedValueModelSha256,
      'expectedValueModelSha256',
    ),
  };
}

function countTable(value: unknown, name: string): CountTableRecord {
  const table = record(value);
  const result: CountTableRecord = {};
  for (const [key, rawCounts] of Object.entries(table)) {
    const counts = record(rawCounts);
    result[key] = Object.fromEntries(
      Object.entries(counts).map(([actionKey, count]) => [
        actionKey,
        nonNegativeNumber(count, `${name}.${key}.${actionKey}`),
      ]),
    );
  }
  return result;
}

function hasMinimumCountObservations(
  counts: Record<string, number> | undefined,
  minimum: number,
): counts is Record<string, number> {
  return Boolean(
    counts &&
      Object.values(counts).reduce((sum, value) => sum + value, 0) >= minimum,
  );
}

function logProbability(
  counts: Record<string, number> | undefined,
  actionKey: string,
  candidateCount: number,
  smoothing: number,
): number {
  const total = counts
    ? Object.values(counts).reduce((sum, value) => sum + value, 0)
    : 0;
  const count = counts?.[actionKey] ?? 0;
  return Math.log(
    (count + smoothing) /
      (total + smoothing * Math.max(1, candidateCount)),
  );
}

function policyEntropy(candidates: readonly CandidatePolicyValue[]): number {
  return -candidates.reduce(
    (sum, candidate) =>
      sum +
      (candidate.targetProbability > 0
        ? candidate.targetProbability * Math.log(candidate.targetProbability)
        : 0),
    0,
  );
}

function summarizeNumbers(values: readonly number[]): Record<string, number> {
  if (values.length === 0) {
    return { count: 0, minimum: 0, median: 0, maximum: 0, mean: 0 };
  }
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: values.length,
    minimum: sorted[0],
    median: quantile(sorted, 0.5),
    maximum: sorted[sorted.length - 1],
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
  };
}

function quantile(values: readonly number[], probability: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) {
    return sorted[lower];
  }
  const fraction = index - lower;
  return sorted[lower] * (1 - fraction) + sorted[upper] * fraction;
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function readReleaseGatePassed(manifest: Record<string, unknown>): boolean {
  return manifest.releaseGatePassed === true;
}

function assertHash(
  actual: string,
  expected: string | undefined,
  name: string,
): void {
  if (!expected || actual !== expected.toLowerCase()) {
    throw new Error(`${name} SHA-256 mismatch.`);
  }
}

function assertOptionalExpectedHash(
  expected: string | undefined,
  actual: string,
  name: string,
): void {
  if (expected && expected !== actual) {
    throw new Error(
      `${name} SHA-256 mismatch: expected ${expected}, received ${actual}.`,
    );
  }
}

function readNestedString(
  value: Record<string, unknown>,
  path: readonly string[],
): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    current = record(current)[key];
  }
  return text(current);
}

async function eachNdjson(
  path: string,
  handler: (
    value: unknown,
    lineNumber: number,
  ) => void | Promise<void>,
): Promise<void> {
  const lines = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw new Error(`Invalid JSON in ${path} at line ${lineNumber}.`);
    }
    await handler(value, lineNumber);
  }
}

class LineWriter {
  private buffered = '';
  private constructor(private readonly handle: FileHandle) {}

  static async create(path: string): Promise<LineWriter> {
    return new LineWriter(await open(path, 'w'));
  }

  async write(value: unknown): Promise<void> {
    this.buffered += `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(this.buffered) >= BUFFER_LIMIT_BYTES) {
      await this.flush();
    }
  }

  async close(): Promise<void> {
    await this.flush();
    await this.handle.close();
  }

  private async flush(): Promise<void> {
    if (!this.buffered) {
      return;
    }
    const content = this.buffered;
    this.buffered = '';
    await this.handle.write(content);
  }
}

async function promote(path: string): Promise<void> {
  await rm(path, { force: true });
  await rename(`${path}.partial`, path);
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const partial = `${path}.partial`;
  await writeFile(partial, `${JSON.stringify(value, undefined, 2)}\n`, 'utf8');
  await rename(partial, path);
}

async function requiredJson(
  path: string,
): Promise<Record<string, unknown>> {
  const value = await readJson(path);
  if (!value) {
    throw new Error(`Required JSON artifact is unavailable: ${path}.`);
  }
  return value;
}

async function readJson(
  path: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
    return record(value);
  } catch {
    return undefined;
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value
        .map((entry) => Number(entry))
        .filter((entry) => Number.isFinite(entry))
    : [];
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : undefined;
}

function requiredText(value: unknown, name: string): string {
  const result = text(value);
  if (!result) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return result;
}

function requiredSha(value: unknown, name: string): string {
  const result = requiredText(value, name).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) {
    throw new Error(`${name} must be a SHA-256 digest.`);
  }
  return result;
}

function requiredBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${name} must be boolean.`);
  }
  return value;
}

function finiteNumber(value: unknown, name: string): number {
  const result = Number(value);
  if (!Number.isFinite(result)) {
    throw new Error(`${name} must be finite.`);
  }
  return result;
}

function positiveNumber(value: unknown, name: string): number {
  const result = finiteNumber(value, name);
  if (result <= 0) {
    throw new Error(`${name} must be greater than zero.`);
  }
  return result;
}

function nonNegativeNumber(value: unknown, name: string): number {
  const result = finiteNumber(value, name);
  if (result < 0) {
    throw new Error(`${name} must be non-negative.`);
  }
  return result;
}

function positiveInteger(value: unknown, name: string): number {
  const result = finiteNumber(value, name);
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return result;
}

function nonNegativeInteger(value: unknown, name: string): number {
  const result = finiteNumber(value, name);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`${name} must be a non-negative safe integer.`);
  }
  return result;
}

function numeric(value: unknown): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function boundedNumber(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result < minimum || result > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return result;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return result;
}

function optionalSha(
  value: string | undefined,
  name: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`${name} must be a SHA-256 digest.`);
  }
  return normalized;
}

function averageOr(values: readonly number[], fallback: number): number {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : fallback;
}

function divide(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
