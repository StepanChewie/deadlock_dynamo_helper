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
import {
  RECOMMENDATION_BEHAVIORAL_V4_MODEL_VERSION,
  type RecommendationBehavioralV4PreparedRow,
} from './recommendation-behavioral-v4-training.service';
import { RECOMMENDATION_DECISION_DATASET_V4_VERSION } from './recommendation-decision-dataset-v4.service';
import {
  RECOMMENDATION_VALUE_V4_MODEL_VERSION,
  type RecommendationValueV4PreparedRow,
} from './recommendation-value-v4-training.service';

export const RECOMMENDATION_POLICY_V4_EVALUATION_SCHEMA_VERSION = 1;
export const RECOMMENDATION_POLICY_V4_EVALUATION_VERSION =
  'RECOMMENDATION_POLICY_V4_DIAGNOSTIC_OPE_1' as const;

const DEFAULT_DATASET_DIRECTORY =
  '/app/apps/api/storage/recommendation-decision-dataset-v4';
const DEFAULT_BEHAVIORAL_DIRECTORY =
  '/app/apps/api/storage/recommendation-behavioral-v4-training';
const DEFAULT_VALUE_DIRECTORY =
  '/app/apps/api/storage/recommendation-value-v4-training';
const DEFAULT_OUTPUT_DIRECTORY =
  '/app/apps/api/storage/recommendation-policy-v4-evaluation';
const DATASET_DIRECTORY_ENV = 'DEADLOCK_RECOMMENDATION_POLICY_V4_DATASET_DIR';
const BEHAVIORAL_DIRECTORY_ENV =
  'DEADLOCK_RECOMMENDATION_POLICY_V4_BEHAVIORAL_DIR';
const VALUE_DIRECTORY_ENV = 'DEADLOCK_RECOMMENDATION_POLICY_V4_VALUE_DIR';
const OUTPUT_DIRECTORY_ENV = 'DEADLOCK_RECOMMENDATION_POLICY_V4_OUTPUT_DIR';
const BUFFER_LIMIT_BYTES = 1024 * 1024;
const PROBABILITY_EPSILON = 1e-9;

export interface RecommendationPolicyV4EvaluationStartRequest {
  behaviorTemperature?: number;
  targetTemperature?: number;
  targetValueWeight?: number;
  minBehaviorProbability?: number;
  maxImportanceWeight?: number;
  bootstrapReplicates?: number;
  bootstrapSeed?: number;
  maxCandidateActions?: number;
  expectedDatasetSha256?: string;
  expectedBehavioralModelSha256?: string;
  expectedValueModelSha256?: string;
}

export interface RecommendationPolicyV4EvaluationOptions {
  behaviorTemperature: number;
  targetTemperature: number;
  targetValueWeight: number;
  minBehaviorProbability: number;
  maxImportanceWeight: number;
  bootstrapReplicates: number;
  bootstrapSeed: number;
  maxCandidateActions: number;
  expectedDatasetSha256?: string;
  expectedBehavioralModelSha256?: string;
  expectedValueModelSha256?: string;
}

export interface RecommendationPolicyV4EvaluationStatus {
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
  options?: RecommendationPolicyV4EvaluationOptions;
  manifestAvailable: boolean;
  auditAvailable: boolean;
  evaluationAvailable: boolean;
}

export interface RecommendationPolicyV4DecisionContribution {
  decisionId: string;
  matchId: string;
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
  snipsContribution: number;
  doublyRobustContribution: number;
}

export interface RecommendationPolicyV4MatchContribution {
  matchId: string;
  decisionCount: number;
  rewardSum: number;
  ipsNumerator: number;
  snipsNumerator: number;
  weightSum: number;
  weightSquareSum: number;
  directSum: number;
  doublyRobustSum: number;
}

export interface RecommendationPolicyV4EstimatorSummary {
  decisionCount: number;
  matchCount: number;
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

export interface RecommendationPolicyV4BootstrapSummary {
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

interface ValueSerializedModel {
  modelVersion: typeof RECOMMENDATION_VALUE_V4_MODEL_VERSION;
  causalInterpretationAllowed: false;
  options: {
    priorStrength: number;
    minContextObservations: number;
  };
  maximumAbsoluteLogitResidual: number;
  weights: {
    heroTeamTime: number;
    inventory: number;
    previousActionTail: number;
    alliedRosterAverage: number;
    enemyRosterAverage: number;
    heroTimeAction: number;
    inventoryAction: number;
    previousActionTailAction: number;
    alliedRosterActionAverage: number;
    enemyRosterActionAverage: number;
  };
  counts: {
    global: BinaryCount;
    hero: BinaryCountTableRecord;
    heroTime: BinaryCountTableRecord;
    heroTeamTime: BinaryCountTableRecord;
    heroTimeInventory: BinaryCountTableRecord;
    heroTimePreviousTail: BinaryCountTableRecord;
    ally: BinaryCountTableRecord;
    enemy: BinaryCountTableRecord;
    heroTimeAction: BinaryCountTableRecord;
    heroTimeInventoryAction: BinaryCountTableRecord;
    heroTimePreviousTailAction: BinaryCountTableRecord;
    allyAction: BinaryCountTableRecord;
    enemyAction: BinaryCountTableRecord;
  };
}

interface BinaryCount {
  wins: number;
  total: number;
}

type CountTableRecord = Record<string, Record<string, number>>;
type BinaryCountTableRecord = Record<string, BinaryCount>;

interface SourceBundle {
  datasetManifest: Record<string, unknown>;
  datasetAudit: Record<string, unknown>;
  behavioralManifest: Record<string, unknown>;
  behavioralAudit: Record<string, unknown>;
  behavioralModel: BehavioralSerializedModel;
  valueManifest: Record<string, unknown>;
  valueAudit: Record<string, unknown>;
  valueModel: ValueSerializedModel;
  hashes: {
    dataset: string;
    behavioralValidation: string;
    behavioralModel: string;
    valueValidation: string;
    valueModel: string;
  };
}

interface EvaluationArtifacts {
  decisionEvaluation: string;
  matchSummary: string;
  evaluation: string;
  audit: string;
  manifest: string;
}

interface MutableAggregate {
  decisionCount: number;
  rewardSum: number;
  ipsNumerator: number;
  snipsNumerator: number;
  weightSum: number;
  weightSquareSum: number;
  directSum: number;
  doublyRobustSum: number;
}

interface CandidatePolicyValue {
  actionKey: string;
  behaviorScore: number;
  behaviorProbability: number;
  valueProbability: number;
  targetScore: number;
  targetProbability: number;
}

interface EvaluationCounters {
  behavioralValidationRowCount: number;
  valueValidationRowCount: number;
  duplicateBehavioralDecisionCount: number;
  duplicateValueDecisionCount: number;
  missingBehavioralDecisionCount: number;
  featureMismatchDecisionCount: number;
  candidateCoveredDecisionCount: number;
  candidateMissingObservedActionCount: number;
  lowBehaviorSupportDecisionCount: number;
  nonFiniteDecisionCount: number;
  supportedDecisionCount: number;
  clippedWeightDecisionCount: number;
  joinedDecisionCount: number;
}

@Injectable()
export class RecommendationPolicyV4EvaluationService implements OnModuleInit {
  private readonly logger = new Logger(
    RecommendationPolicyV4EvaluationService.name,
  );
  private readonly datasetDirectory =
    process.env[DATASET_DIRECTORY_ENV]?.trim() || DEFAULT_DATASET_DIRECTORY;
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
      const coverage = asRecord(this.audit.coverage);
      this.status = {
        ...this.createIdleStatus(),
        state: 'COMPLETE',
        phase: 'COMPLETE',
        joinedDecisionCount: toNumber(coverage.joinedDecisionCount),
        candidateCoveredDecisionCount: toNumber(
          coverage.candidateCoveredDecisionCount,
        ),
        supportedDecisionCount: toNumber(coverage.supportedDecisionCount),
        evaluatedDecisionCount: toNumber(coverage.evaluatedDecisionCount),
        evaluatedMatchCount: toNumber(coverage.evaluatedMatchCount),
        completedAt: String(this.manifest.generatedAt ?? ''),
        manifestAvailable: true,
        auditAvailable: true,
        evaluationAvailable: true,
      };
    }
  }

  async start(
    request: RecommendationPolicyV4EvaluationStartRequest = {},
  ): Promise<RecommendationPolicyV4EvaluationStatus> {
    if (this.status.state === 'RUNNING') {
      throw new Error('Recommendation Policy V4 evaluation is already running.');
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

  getStatus(): RecommendationPolicyV4EvaluationStatus {
    return cloneJson(this.status);
  }

  getManifest(): Record<string, unknown> | undefined {
    return this.manifest ? cloneJson(this.manifest) : undefined;
  }

  getAudit(): Record<string, unknown> | undefined {
    return this.audit ? cloneJson(this.audit) : undefined;
  }

  getEvaluation(): Record<string, unknown> | undefined {
    return this.evaluation ? cloneJson(this.evaluation) : undefined;
  }

  private async run(options: RecommendationPolicyV4EvaluationOptions): Promise<void> {
    try {
      this.status = {
        ...this.status,
        phase: 'PREPARING',
      };
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

      this.status = {
        ...this.status,
        phase: 'JOINING',
      };
      const behavioralRows = new Map<string, RecommendationBehavioralV4PreparedRow>();
      const counters: EvaluationCounters = {
        behavioralValidationRowCount: 0,
        valueValidationRowCount: 0,
        duplicateBehavioralDecisionCount: 0,
        duplicateValueDecisionCount: 0,
        missingBehavioralDecisionCount: 0,
        featureMismatchDecisionCount: 0,
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
      const matches = new Map<string, MutableAggregate>();
      const valueDecisionIds = new Set<string>();
      const rawWeights: number[] = [];
      const clippedWeights: number[] = [];
      const behaviorProbabilities: number[] = [];
      const targetEntropies: number[] = [];
      try {
        await eachNdjson(
          join(this.valueDirectory, 'validation.ndjson'),
          async (value, lineNumber) => {
            const valueRow = parseValuePreparedRow(value, lineNumber);
            counters.valueValidationRowCount += 1;
            this.status = {
              ...this.status,
              processedValueRowCount: counters.valueValidationRowCount,
            };
            if (valueDecisionIds.has(valueRow.decisionId)) {
              counters.duplicateValueDecisionCount += 1;
              return;
            }
            valueDecisionIds.add(valueRow.decisionId);
            const behavioralRow = behavioralRows.get(valueRow.decisionId);
            if (!behavioralRow) {
              counters.missingBehavioralDecisionCount += 1;
              await decisionWriter.write({
                schemaVersion: RECOMMENDATION_POLICY_V4_EVALUATION_SCHEMA_VERSION,
                decisionId: valueRow.decisionId,
                matchId: valueRow.matchId,
                eligible: false,
                exclusionReason: 'MISSING_BEHAVIORAL_VALIDATION_ROW',
              });
              return;
            }
            counters.joinedDecisionCount += 1;
            if (!preparedRowsMatch(behavioralRow, valueRow)) {
              counters.featureMismatchDecisionCount += 1;
              await decisionWriter.write({
                schemaVersion: RECOMMENDATION_POLICY_V4_EVALUATION_SCHEMA_VERSION,
                decisionId: valueRow.decisionId,
                matchId: valueRow.matchId,
                eligible: false,
                exclusionReason: 'PREPARED_FEATURE_MISMATCH',
              });
              return;
            }
            const candidateActions = uniqueActionKeys(
              behavioralRow.features.candidateActionKeys,
            ).slice(0, options.maxCandidateActions);
            const observedActionKey = valueRow.features.actionKey;
            if (!candidateActions.includes(observedActionKey)) {
              counters.candidateMissingObservedActionCount += 1;
              await decisionWriter.write({
                schemaVersion: RECOMMENDATION_POLICY_V4_EVALUATION_SCHEMA_VERSION,
                decisionId: valueRow.decisionId,
                matchId: valueRow.matchId,
                eligible: false,
                exclusionReason: 'OBSERVED_ACTION_NOT_IN_RECORDED_CANDIDATES',
                observedActionKey,
                candidateActionKeys: candidateActions,
              });
              return;
            }
            counters.candidateCoveredDecisionCount += 1;
            const policies = buildCandidatePolicies(
              behavioralRow,
              candidateActions,
              sources.behavioralModel,
              sources.valueModel,
              options,
            );
            const observed = policies.find(
              (candidate) => candidate.actionKey === observedActionKey,
            );
            if (!observed || !candidatePoliciesAreFinite(policies)) {
              counters.nonFiniteDecisionCount += 1;
              await decisionWriter.write({
                schemaVersion: RECOMMENDATION_POLICY_V4_EVALUATION_SCHEMA_VERSION,
                decisionId: valueRow.decisionId,
                matchId: valueRow.matchId,
                eligible: false,
                exclusionReason: 'NON_FINITE_POLICY_VALUE',
              });
              return;
            }
            if (observed.behaviorProbability < options.minBehaviorProbability) {
              counters.lowBehaviorSupportDecisionCount += 1;
              await decisionWriter.write({
                schemaVersion: RECOMMENDATION_POLICY_V4_EVALUATION_SCHEMA_VERSION,
                decisionId: valueRow.decisionId,
                matchId: valueRow.matchId,
                eligible: false,
                exclusionReason: 'LOW_ESTIMATED_BEHAVIOR_SUPPORT',
                observedActionKey,
                behaviorProbability: observed.behaviorProbability,
                minimumBehaviorProbability: options.minBehaviorProbability,
                candidates: policies,
              });
              return;
            }
            counters.supportedDecisionCount += 1;
            const reward = valueRow.target.playerWon ? 1 : 0;
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
                candidate.targetProbability * candidate.valueProbability,
              0,
            );
            const doublyRobustContribution =
              directValue +
              clippedImportanceWeight *
                (reward - observed.valueProbability);
            const contribution: RecommendationPolicyV4DecisionContribution = {
              decisionId: valueRow.decisionId,
              matchId: valueRow.matchId,
              reward,
              observedActionKey,
              behaviorProbability: observed.behaviorProbability,
              targetProbability: observed.targetProbability,
              rawImportanceWeight,
              clippedImportanceWeight,
              clipped,
              directValue,
              observedActionValue: observed.valueProbability,
              ipsContribution: clippedImportanceWeight * reward,
              snipsContribution: clippedImportanceWeight * reward,
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
              schemaVersion: RECOMMENDATION_POLICY_V4_EVALUATION_SCHEMA_VERSION,
              evaluationVersion: RECOMMENDATION_POLICY_V4_EVALUATION_VERSION,
              decisionId: valueRow.decisionId,
              matchId: valueRow.matchId,
              decisionOccurredAt: valueRow.decisionOccurredAt,
              eligible: true,
              observedActionKey,
              playerWon: valueRow.target.playerWon,
              behaviorProbability: observed.behaviorProbability,
              targetProbability: observed.targetProbability,
              rawImportanceWeight,
              clippedImportanceWeight,
              clipped,
              directValue,
              observedActionValue: observed.valueProbability,
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
              await yieldToEventLoop();
            }
          },
        );
      } finally {
        await decisionWriter.close();
      }
      await promote(this.paths.decisionEvaluation);
      if (aggregate.decisionCount <= 0 || matches.size <= 0) {
        throw new Error(
          'Recommendation Policy V4 evaluation contains no supported held-out decisions.',
        );
      }

      const matchWriter = await LineWriter.create(
        `${this.paths.matchSummary}.partial`,
      );
      const matchContributions: RecommendationPolicyV4MatchContribution[] = [];
      try {
        for (const [matchId, value] of [...matches.entries()].sort(
          ([left], [right]) => left.localeCompare(right),
        )) {
          const summary = toMatchContribution(matchId, value);
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
      const estimators = finalizeRecommendationPolicyV4Estimators(
        aggregate,
        matches.size,
      );
      const bootstrap = bootstrapRecommendationPolicyV4(
        matchContributions,
        options.bootstrapReplicates,
        options.bootstrapSeed,
      );

      this.status = {
        ...this.status,
        phase: 'FINALIZING',
      };
      const generatedAt = new Date().toISOString();
      const coverage = {
        behavioralValidationRowCount: counters.behavioralValidationRowCount,
        valueValidationRowCount: counters.valueValidationRowCount,
        joinedDecisionCount: counters.joinedDecisionCount,
        candidateCoveredDecisionCount: counters.candidateCoveredDecisionCount,
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
        missingBehavioralDecisionCount: counters.missingBehavioralDecisionCount,
        featureMismatchDecisionCount: counters.featureMismatchDecisionCount,
        candidateMissingObservedActionCount:
          counters.candidateMissingObservedActionCount,
        lowBehaviorSupportDecisionCount:
          counters.lowBehaviorSupportDecisionCount,
        nonFiniteDecisionCount: counters.nonFiniteDecisionCount,
      };
      const diagnostics = {
        estimatedBehaviorPropensity: true,
        actualLoggingPropensityAvailable: false,
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
      const evaluation = {
        schemaVersion: RECOMMENDATION_POLICY_V4_EVALUATION_SCHEMA_VERSION,
        evaluationVersion: RECOMMENDATION_POLICY_V4_EVALUATION_VERSION,
        generatedAt,
        evaluationKind: 'DIAGNOSTIC_OFFLINE_POLICY_EVALUATION',
        causalInterpretationAllowed: false,
        rolloutAuthorization: 'FORBIDDEN',
        behaviorPolicy: {
          kind: 'ESTIMATED_PLAYER_ACTION_POLICY',
          source: 'BEHAVIORAL_V4_HELD_OUT_SCORE_SOFTMAX',
          actualLoggingPropensityAvailable: false,
          temperature: options.behaviorTemperature,
        },
        targetPolicy: {
          kind: 'STOCHASTIC_VALUE_TILTED_BEHAVIORAL_POLICY',
          formula:
            'softmax((behavioralScore + targetValueWeight * logit(valueProbability)) / targetTemperature)',
          temperature: options.targetTemperature,
          targetValueWeight: options.targetValueWeight,
          candidateSetPolicy: 'RECORDED_AT_DECISION_TIME',
        },
        estimators,
        bootstrap,
        coverage,
        diagnostics,
        releaseGate,
        warnings: [
          'Behavior propensities are estimated from Behavioral V4 and are not the actual historical logging probabilities.',
          'Value V4 is observational and may contain selection bias and unobserved confounding.',
          'IPS, SNIPS, and doubly robust estimates are diagnostic only and do not authorize production rollout.',
        ],
      };
      const audit = {
        schemaVersion: RECOMMENDATION_POLICY_V4_EVALUATION_SCHEMA_VERSION,
        evaluationVersion: RECOMMENDATION_POLICY_V4_EVALUATION_VERSION,
        generatedAt,
        passed:
          counters.duplicateBehavioralDecisionCount === 0 &&
          counters.duplicateValueDecisionCount === 0 &&
          counters.featureMismatchDecisionCount === 0 &&
          aggregate.decisionCount > 0 &&
          matches.size > 0 &&
          Number.isFinite(estimators.doublyRobustValue),
        source: {
          datasetVersion: RECOMMENDATION_DECISION_DATASET_V4_VERSION,
          datasetDirectory: this.datasetDirectory,
          behavioralDirectory: this.behavioralDirectory,
          valueDirectory: this.valueDirectory,
          hashes: sources.hashes,
          datasetAuditPassed: Boolean(sources.datasetAudit.passed),
          behavioralAuditPassed: Boolean(sources.behavioralAudit.passed),
          valueAuditPassed: Boolean(sources.valueAudit.passed),
        },
        integrity: {
          duplicateBehavioralDecisionCount:
            counters.duplicateBehavioralDecisionCount,
          duplicateValueDecisionCount: counters.duplicateValueDecisionCount,
          missingBehavioralDecisionCount:
            counters.missingBehavioralDecisionCount,
          featureMismatchDecisionCount: counters.featureMismatchDecisionCount,
          nonFiniteDecisionCount: counters.nonFiniteDecisionCount,
        },
        coverage,
        diagnostics,
        leakage: {
          evaluationRows: 'INTERSECTION_OF_BEHAVIORAL_AND_VALUE_VALIDATION',
          targetOutcomeUsedForPolicyScoring: false,
          observedActionUsedOnlyForImportanceWeightAndRewardCorrection: true,
          matchLevelBootstrap: true,
          causalInterpretationAllowed: false,
        },
        warnings: evaluation.warnings,
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
        datasetDirectory: this.datasetDirectory,
        behavioralDirectory: this.behavioralDirectory,
        valueDirectory: this.valueDirectory,
        coverage,
        auditPassed: audit.passed,
        releaseGate,
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
        candidateCoveredDecisionCount: counters.candidateCoveredDecisionCount,
        supportedDecisionCount: counters.supportedDecisionCount,
        evaluatedDecisionCount: aggregate.decisionCount,
        evaluatedMatchCount: matches.size,
        manifestAvailable: true,
        auditAvailable: true,
        evaluationAvailable: true,
        error: undefined,
      };
      this.logger.log(
        `Recommendation Policy V4 evaluation completed: ${aggregate.decisionCount} decisions, ` +
          `${matches.size} matches, shadow-readiness gate ${releaseGate.passed ? 'PASS' : 'FAIL'}.`,
      );
    } catch (error) {
      const message = getErrorMessage(error);
      this.status = {
        ...this.status,
        state: 'FAILED',
        completedAt: new Date().toISOString(),
        error: message,
      };
      this.logger.error(`Recommendation Policy V4 evaluation failed: ${message}`);
    }
  }

  private async loadAndValidateSources(
    options: RecommendationPolicyV4EvaluationOptions,
  ): Promise<SourceBundle> {
    const datasetManifest = await requiredJson<Record<string, unknown>>(
      join(this.datasetDirectory, 'manifest.json'),
    );
    const datasetAudit = await requiredJson<Record<string, unknown>>(
      join(this.datasetDirectory, 'audit.json'),
    );
    const behavioralManifest = await requiredJson<Record<string, unknown>>(
      join(this.behavioralDirectory, 'manifest.json'),
    );
    const behavioralAudit = await requiredJson<Record<string, unknown>>(
      join(this.behavioralDirectory, 'audit.json'),
    );
    const behavioralModelValue = await requiredJson<Record<string, unknown>>(
      join(this.behavioralDirectory, 'model.json'),
    );
    const valueManifest = await requiredJson<Record<string, unknown>>(
      join(this.valueDirectory, 'manifest.json'),
    );
    const valueAudit = await requiredJson<Record<string, unknown>>(
      join(this.valueDirectory, 'audit.json'),
    );
    const valueModelValue = await requiredJson<Record<string, unknown>>(
      join(this.valueDirectory, 'model.json'),
    );
    if (!datasetManifest.auditPassed || !datasetAudit.passed) {
      throw new Error('Recommendation Decision Dataset V4 did not pass audit.');
    }
    if (!behavioralManifest.auditPassed || !behavioralAudit.passed) {
      throw new Error('Recommendation Behavioral V4 training did not pass audit.');
    }
    if (!valueManifest.auditPassed || !valueAudit.passed) {
      throw new Error('Recommendation Value V4 training did not pass audit.');
    }
    const behavioralModel = parseBehavioralModel(behavioralModelValue);
    const valueModel = parseValueModel(valueModelValue);
    const hashes = {
      dataset: await hashFile(join(this.datasetDirectory, 'dataset.ndjson')),
      behavioralValidation: await hashFile(
        join(this.behavioralDirectory, 'validation.ndjson'),
      ),
      behavioralModel: await hashFile(
        join(this.behavioralDirectory, 'model.json'),
      ),
      valueValidation: await hashFile(
        join(this.valueDirectory, 'validation.ndjson'),
      ),
      valueModel: await hashFile(join(this.valueDirectory, 'model.json')),
    };
    assertHash(
      hashes.dataset,
      readNestedString(datasetManifest, ['artifact', 'sha256']),
      'dataset artifact',
    );
    assertHash(
      hashes.dataset,
      readNestedString(behavioralManifest, ['source', 'artifactSha256']),
      'Behavioral V4 source dataset',
    );
    assertHash(
      hashes.dataset,
      readNestedString(valueManifest, ['source', 'artifactSha256']),
      'Value V4 source dataset',
    );
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
      hashes.valueValidation,
      readNestedString(valueManifest, ['artifacts', 'validation', 'sha256']),
      'Value V4 validation artifact',
    );
    assertHash(
      hashes.valueModel,
      readNestedString(valueManifest, ['artifacts', 'model', 'sha256']),
      'Value V4 model artifact',
    );
    assertOptionalExpectedHash(
      options.expectedDatasetSha256,
      hashes.dataset,
      'dataset',
    );
    assertOptionalExpectedHash(
      options.expectedBehavioralModelSha256,
      hashes.behavioralModel,
      'Behavioral V4 model',
    );
    assertOptionalExpectedHash(
      options.expectedValueModelSha256,
      hashes.valueModel,
      'Value V4 model',
    );
    return {
      datasetManifest,
      datasetAudit,
      behavioralManifest,
      behavioralAudit,
      behavioralModel,
      valueManifest,
      valueAudit,
      valueModel,
      hashes,
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

  private createIdleStatus(): RecommendationPolicyV4EvaluationStatus {
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

export function softmaxRecommendationPolicyV4(
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

export function finalizeRecommendationPolicyV4Estimators(
  aggregate: MutableAggregate,
  matchCount: number,
): RecommendationPolicyV4EstimatorSummary {
  const observedValue = divide(aggregate.rewardSum, aggregate.decisionCount);
  const inversePropensityValue = divide(
    aggregate.ipsNumerator,
    aggregate.decisionCount,
  );
  const selfNormalizedInversePropensityValue = divide(
    aggregate.snipsNumerator,
    aggregate.weightSum,
  );
  const directMethodValue = divide(
    aggregate.directSum,
    aggregate.decisionCount,
  );
  const doublyRobustValue = divide(
    aggregate.doublyRobustSum,
    aggregate.decisionCount,
  );
  const effectiveSampleSize = divide(
    aggregate.weightSum * aggregate.weightSum,
    aggregate.weightSquareSum,
  );
  return {
    decisionCount: aggregate.decisionCount,
    matchCount,
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

export function bootstrapRecommendationPolicyV4(
  matches: readonly RecommendationPolicyV4MatchContribution[],
  replicateCount: number,
  seed: number,
): RecommendationPolicyV4BootstrapSummary {
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
    const summary = finalizeRecommendationPolicyV4Estimators(
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
  row: RecommendationBehavioralV4PreparedRow,
  candidateActions: readonly string[],
  behavioralModel: BehavioralSerializedModel,
  valueModel: ValueSerializedModel,
  options: RecommendationPolicyV4EvaluationOptions,
): CandidatePolicyValue[] {
  const behaviorScores = candidateActions.map((actionKey) =>
    behavioralScore(row, actionKey, candidateActions.length, behavioralModel),
  );
  const behaviorProbabilities = softmaxRecommendationPolicyV4(
    behaviorScores,
    options.behaviorTemperature,
  );
  const valueProbabilities = candidateActions.map((actionKey) =>
    valueProbability(row, actionKey, valueModel),
  );
  const targetScores = behaviorScores.map(
    (score, index) =>
      score + options.targetValueWeight * probabilityLogit(valueProbabilities[index]),
  );
  const targetProbabilities = softmaxRecommendationPolicyV4(
    targetScores,
    options.targetTemperature,
  );
  return candidateActions.map((actionKey, index) => ({
    actionKey,
    behaviorScore: behaviorScores[index],
    behaviorProbability: behaviorProbabilities[index],
    valueProbability: valueProbabilities[index],
    targetScore: targetScores[index],
    targetProbability: targetProbabilities[index],
  }));
}

function behavioralScore(
  row: RecommendationBehavioralV4PreparedRow,
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

function valueProbability(
  row: RecommendationBehavioralV4PreparedRow,
  actionKey: string,
  model: ValueSerializedModel,
): number {
  const features = row.features;
  const baseKey = `${features.heroId}|${features.timeBucket}`;
  const globalProbability = clampProbability(
    (model.counts.global.wins + 1) / (model.counts.global.total + 2),
  );
  const heroProbability = posteriorProbability(
    model.counts.hero[String(features.heroId)],
    globalProbability,
    model.options.priorStrength,
  );
  const heroTimeCount = model.counts.heroTime[baseKey];
  const base = hasMinimumBinaryObservations(
    heroTimeCount,
    model.options.minContextObservations,
  )
    ? posteriorProbability(
        heroTimeCount,
        heroProbability,
        model.options.priorStrength,
      )
    : heroProbability;
  const baseLogit = probabilityLogit(base);
  let residual = 0;
  const addResidual = (
    count: BinaryCount | undefined,
    weight: number,
  ): void => {
    if (
      !hasMinimumBinaryObservations(
        count,
        model.options.minContextObservations,
      )
    ) {
      return;
    }
    residual +=
      weight *
      (probabilityLogit(
        posteriorProbability(count, base, model.options.priorStrength),
      ) -
        baseLogit);
  };
  const addAverageResidual = (
    counts: readonly (BinaryCount | undefined)[],
    weight: number,
  ): void => {
    const deltas = counts
      .filter((count) =>
        hasMinimumBinaryObservations(
          count,
          model.options.minContextObservations,
        ),
      )
      .map(
        (count) =>
          probabilityLogit(
            posteriorProbability(count, base, model.options.priorStrength),
          ) - baseLogit,
      );
    if (deltas.length > 0) {
      residual += weight * average(deltas);
    }
  };

  addResidual(
    model.counts.heroTeamTime[
      `${baseKey}|${features.teamId ?? 'UNKNOWN_TEAM'}`
    ],
    model.weights.heroTeamTime,
  );
  addResidual(
    model.counts.heroTimeInventory[
      `${baseKey}|${features.inventoryStateKey}`
    ],
    model.weights.inventory,
  );
  addResidual(
    model.counts.heroTimePreviousTail[
      `${baseKey}|${features.previousActionTailKey}`
    ],
    model.weights.previousActionTail,
  );
  addAverageResidual(
    features.alliedHeroIds.map(
      (heroId) => model.counts.ally[`${baseKey}|${heroId}`],
    ),
    model.weights.alliedRosterAverage,
  );
  addAverageResidual(
    features.enemyHeroIds.map(
      (heroId) => model.counts.enemy[`${baseKey}|${heroId}`],
    ),
    model.weights.enemyRosterAverage,
  );
  addResidual(
    model.counts.heroTimeAction[`${baseKey}|${actionKey}`],
    model.weights.heroTimeAction,
  );
  addResidual(
    model.counts.heroTimeInventoryAction[
      `${baseKey}|${features.inventoryStateKey}|${actionKey}`
    ],
    model.weights.inventoryAction,
  );
  addResidual(
    model.counts.heroTimePreviousTailAction[
      `${baseKey}|${features.previousActionTailKey}|${actionKey}`
    ],
    model.weights.previousActionTailAction,
  );
  addAverageResidual(
    features.alliedHeroIds.map(
      (heroId) => model.counts.allyAction[`${baseKey}|${heroId}|${actionKey}`],
    ),
    model.weights.alliedRosterActionAverage,
  );
  addAverageResidual(
    features.enemyHeroIds.map(
      (heroId) => model.counts.enemyAction[`${baseKey}|${heroId}|${actionKey}`],
    ),
    model.weights.enemyRosterActionAverage,
  );
  return clampProbability(
    probabilityFromLogit(
      baseLogit +
        clamp(
          residual,
          -model.maximumAbsoluteLogitResidual,
          model.maximumAbsoluteLogitResidual,
        ),
    ),
  );
}

function buildReleaseGate(input: {
  estimators: RecommendationPolicyV4EstimatorSummary;
  bootstrap: RecommendationPolicyV4BootstrapSummary;
  coverage: Record<string, number>;
  diagnostics: Record<string, unknown>;
  behavioralReleaseGatePassed: boolean;
  valueReleaseGatePassed: boolean;
}): Record<string, unknown> {
  const blockers: string[] = [];
  const candidateCoverageRate = input.coverage.candidateCoverageRate ?? 0;
  const behaviorSupportRate = input.coverage.behaviorSupportRate ?? 0;
  const clippedWeightRate = toNumber(input.diagnostics.clippedWeightRate);
  const ipsSnipsAbsoluteDifference = toNumber(
    input.diagnostics.ipsSnipsAbsoluteDifference,
  );
  const drDeltaInterval = input.bootstrap.intervals.doublyRobustDelta;
  if (input.estimators.decisionCount < 200) {
    blockers.push('Evaluation contains fewer than 200 supported decisions.');
  }
  if (input.estimators.matchCount < 30) {
    blockers.push('Evaluation contains fewer than 30 held-out matches.');
  }
  if (candidateCoverageRate < 0.95) {
    blockers.push('Recorded candidate coverage is below 95%.');
  }
  if (behaviorSupportRate < 0.9) {
    blockers.push('Estimated behavior-policy support is below 90%.');
  }
  if (input.estimators.effectiveSampleSizeRatio < 0.2) {
    blockers.push('Importance-weight effective sample-size ratio is below 20%.');
  }
  if (clippedWeightRate > 0.1) {
    blockers.push('More than 10% of supported decisions require weight clipping.');
  }
  if (ipsSnipsAbsoluteDifference > 0.05) {
    blockers.push('IPS and SNIPS estimates differ by more than 0.05.');
  }
  if (!drDeltaInterval || drDeltaInterval.lower < 0) {
    blockers.push(
      'The match-bootstrap 95% lower bound for doubly robust delta is negative.',
    );
  }
  if (!input.behavioralReleaseGatePassed) {
    blockers.push('Behavioral V4 training release gate did not pass.');
  }
  if (!input.valueReleaseGatePassed) {
    blockers.push('Value V4 training release gate did not pass.');
  }
  return {
    name: 'SHADOW_READINESS_DIAGNOSTIC',
    productionRolloutAuthorized: false,
    minimumDecisionCount: 200,
    minimumMatchCount: 30,
    minimumCandidateCoverageRate: 0.95,
    minimumBehaviorSupportRate: 0.9,
    minimumEffectiveSampleSizeRatio: 0.2,
    maximumClippedWeightRate: 0.1,
    maximumIpsSnipsAbsoluteDifference: 0.05,
    minimumDoublyRobustDeltaLower95: 0,
    behavioralReleaseGatePassed: input.behavioralReleaseGatePassed,
    valueReleaseGatePassed: input.valueReleaseGatePassed,
    passed: blockers.length === 0,
    blockers,
    warnings: [
      'Passing this diagnostic gate does not authorize production rollout because historical propensities are estimated rather than logged.',
    ],
  };
}

async function buildManifest(input: {
  generatedAt: string;
  options: RecommendationPolicyV4EvaluationOptions;
  paths: EvaluationArtifacts;
  sources: SourceBundle;
  datasetDirectory: string;
  behavioralDirectory: string;
  valueDirectory: string;
  coverage: Record<string, number>;
  auditPassed: boolean;
  releaseGate: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const artifacts: Record<string, unknown> = {};
  for (const [name, path] of Object.entries(input.paths)) {
    if (name === 'manifest') {
      continue;
    }
    const metadata = await stat(path);
    artifacts[name] = {
      fileName: path.split('/').pop(),
      byteLength: metadata.size,
      sha256: await hashFile(path),
    };
  }
  return {
    schemaVersion: RECOMMENDATION_POLICY_V4_EVALUATION_SCHEMA_VERSION,
    evaluationVersion: RECOMMENDATION_POLICY_V4_EVALUATION_VERSION,
    generatedAt: input.generatedAt,
    evaluationKind: 'DIAGNOSTIC_OFFLINE_POLICY_EVALUATION',
    source: {
      dataset: {
        directory: input.datasetDirectory,
        sha256: input.sources.hashes.dataset,
      },
      behavioral: {
        directory: input.behavioralDirectory,
        validationSha256: input.sources.hashes.behavioralValidation,
        modelSha256: input.sources.hashes.behavioralModel,
        modelVersion: RECOMMENDATION_BEHAVIORAL_V4_MODEL_VERSION,
      },
      value: {
        directory: input.valueDirectory,
        validationSha256: input.sources.hashes.valueValidation,
        modelSha256: input.sources.hashes.valueModel,
        modelVersion: RECOMMENDATION_VALUE_V4_MODEL_VERSION,
      },
    },
    options: input.options,
    coverage: input.coverage,
    artifacts,
    auditPassed: input.auditPassed,
    releaseGate: input.releaseGate,
    productionRolloutAuthorized: false,
  };
}

function preparedRowsMatch(
  behavioral: RecommendationBehavioralV4PreparedRow,
  value: RecommendationValueV4PreparedRow,
): boolean {
  return (
    behavioral.matchId === value.matchId &&
    behavioral.decisionOccurredAt === value.decisionOccurredAt &&
    behavioral.features.heroId === value.features.heroId &&
    behavioral.features.teamId === value.features.teamId &&
    behavioral.features.gameTimeS === value.features.gameTimeS &&
    behavioral.features.timeBucket === value.features.timeBucket &&
    behavioral.features.inventoryStateKey ===
      value.features.inventoryStateKey &&
    behavioral.features.previousActionTailKey ===
      value.features.previousActionTailKey &&
    arraysEqual(
      behavioral.features.alliedHeroIds,
      value.features.alliedHeroIds,
    ) &&
    arraysEqual(behavioral.features.enemyHeroIds, value.features.enemyHeroIds)
  );
}

function parseBehavioralPreparedRow(
  value: unknown,
  lineNumber: number,
): RecommendationBehavioralV4PreparedRow {
  if (!isRecord(value)) {
    throw new Error(`Invalid Behavioral V4 validation row at line ${lineNumber}.`);
  }
  const features = asRecord(value.features);
  const target = asRecord(value.target);
  if (
    typeof value.decisionId !== 'string' ||
    typeof value.matchId !== 'string' ||
    typeof value.decisionOccurredAt !== 'string' ||
    !Number.isSafeInteger(Number(features.heroId)) ||
    typeof features.inventoryStateKey !== 'string' ||
    typeof features.previousActionTailKey !== 'string' ||
    !Array.isArray(features.alliedHeroIds) ||
    !Array.isArray(features.enemyHeroIds) ||
    !Array.isArray(features.candidateActionKeys) ||
    typeof target.actionKey !== 'string'
  ) {
    throw new Error(`Invalid Behavioral V4 validation row at line ${lineNumber}.`);
  }
  return value as unknown as RecommendationBehavioralV4PreparedRow;
}

function parseValuePreparedRow(
  value: unknown,
  lineNumber: number,
): RecommendationValueV4PreparedRow {
  if (!isRecord(value)) {
    throw new Error(`Invalid Value V4 validation row at line ${lineNumber}.`);
  }
  const features = asRecord(value.features);
  const target = asRecord(value.target);
  if (
    typeof value.decisionId !== 'string' ||
    typeof value.matchId !== 'string' ||
    typeof value.decisionOccurredAt !== 'string' ||
    !Number.isSafeInteger(Number(features.heroId)) ||
    typeof features.inventoryStateKey !== 'string' ||
    typeof features.previousActionTailKey !== 'string' ||
    typeof features.actionKey !== 'string' ||
    typeof target.playerWon !== 'boolean'
  ) {
    throw new Error(`Invalid Value V4 validation row at line ${lineNumber}.`);
  }
  return value as unknown as RecommendationValueV4PreparedRow;
}

function parseBehavioralModel(
  value: Record<string, unknown>,
): BehavioralSerializedModel {
  if (value.modelVersion !== RECOMMENDATION_BEHAVIORAL_V4_MODEL_VERSION) {
    throw new Error(`Unsupported Behavioral V4 model version: ${String(value.modelVersion)}.`);
  }
  const options = asRecord(value.options);
  const weights = asRecord(value.weights);
  const counts = asRecord(value.counts);
  if (
    !isPositiveNumber(options.smoothing) ||
    !isPositiveInteger(options.minContextObservations) ||
    !isFiniteNumber(weights.inventoryDelta) ||
    !isFiniteNumber(weights.previousActionTailDelta) ||
    !isFiniteNumber(weights.alliedRosterDeltaAverage) ||
    !isFiniteNumber(weights.enemyRosterDeltaAverage)
  ) {
    throw new Error('Behavioral V4 model options or weights are invalid.');
  }
  return {
    modelVersion: RECOMMENDATION_BEHAVIORAL_V4_MODEL_VERSION,
    options: {
      smoothing: options.smoothing,
      minContextObservations: options.minContextObservations,
    },
    weights: {
      inventoryDelta: weights.inventoryDelta,
      previousActionTailDelta: weights.previousActionTailDelta,
      alliedRosterDeltaAverage: weights.alliedRosterDeltaAverage,
      enemyRosterDeltaAverage: weights.enemyRosterDeltaAverage,
    },
    counts: {
      hero: asCountTableRecord(counts.hero),
      heroTime: asCountTableRecord(counts.heroTime),
      heroTimeInventory: asCountTableRecord(counts.heroTimeInventory),
      heroTimePreviousTail: asCountTableRecord(
        counts.heroTimePreviousTail,
      ),
      ally: asCountTableRecord(counts.ally),
      enemy: asCountTableRecord(counts.enemy),
    },
  };
}

function parseValueModel(value: Record<string, unknown>): ValueSerializedModel {
  if (value.modelVersion !== RECOMMENDATION_VALUE_V4_MODEL_VERSION) {
    throw new Error(`Unsupported Value V4 model version: ${String(value.modelVersion)}.`);
  }
  if (value.causalInterpretationAllowed !== false) {
    throw new Error('Value V4 model must explicitly forbid causal interpretation.');
  }
  const options = asRecord(value.options);
  const weights = asRecord(value.weights);
  const counts = asRecord(value.counts);
  if (
    !isPositiveNumber(options.priorStrength) ||
    !isPositiveInteger(options.minContextObservations) ||
    !isPositiveNumber(value.maximumAbsoluteLogitResidual) ||
    !isFiniteNumber(weights.heroTeamTime) ||
    !isFiniteNumber(weights.inventory) ||
    !isFiniteNumber(weights.previousActionTail) ||
    !isFiniteNumber(weights.alliedRosterAverage) ||
    !isFiniteNumber(weights.enemyRosterAverage) ||
    !isFiniteNumber(weights.heroTimeAction) ||
    !isFiniteNumber(weights.inventoryAction) ||
    !isFiniteNumber(weights.previousActionTailAction) ||
    !isFiniteNumber(weights.alliedRosterActionAverage) ||
    !isFiniteNumber(weights.enemyRosterActionAverage)
  ) {
    throw new Error('Value V4 model options or weights are invalid.');
  }
  return {
    modelVersion: RECOMMENDATION_VALUE_V4_MODEL_VERSION,
    causalInterpretationAllowed: false,
    options: {
      priorStrength: options.priorStrength,
      minContextObservations: options.minContextObservations,
    },
    maximumAbsoluteLogitResidual: value.maximumAbsoluteLogitResidual,
    weights: {
      heroTeamTime: weights.heroTeamTime,
      inventory: weights.inventory,
      previousActionTail: weights.previousActionTail,
      alliedRosterAverage: weights.alliedRosterAverage,
      enemyRosterAverage: weights.enemyRosterAverage,
      heroTimeAction: weights.heroTimeAction,
      inventoryAction: weights.inventoryAction,
      previousActionTailAction: weights.previousActionTailAction,
      alliedRosterActionAverage: weights.alliedRosterActionAverage,
      enemyRosterActionAverage: weights.enemyRosterActionAverage,
    },
    counts: {
      global: asBinaryCount(counts.global),
      hero: asBinaryCountTableRecord(counts.hero),
      heroTime: asBinaryCountTableRecord(counts.heroTime),
      heroTeamTime: asBinaryCountTableRecord(counts.heroTeamTime),
      heroTimeInventory: asBinaryCountTableRecord(counts.heroTimeInventory),
      heroTimePreviousTail: asBinaryCountTableRecord(
        counts.heroTimePreviousTail,
      ),
      ally: asBinaryCountTableRecord(counts.ally),
      enemy: asBinaryCountTableRecord(counts.enemy),
      heroTimeAction: asBinaryCountTableRecord(counts.heroTimeAction),
      heroTimeInventoryAction: asBinaryCountTableRecord(
        counts.heroTimeInventoryAction,
      ),
      heroTimePreviousTailAction: asBinaryCountTableRecord(
        counts.heroTimePreviousTailAction,
      ),
      allyAction: asBinaryCountTableRecord(counts.allyAction),
      enemyAction: asBinaryCountTableRecord(counts.enemyAction),
    },
  };
}

function asCountTableRecord(value: unknown): CountTableRecord {
  if (!isRecord(value)) {
    throw new Error('Behavioral V4 count table is invalid.');
  }
  const result: CountTableRecord = {};
  for (const [contextKey, countsValue] of Object.entries(value)) {
    if (!isRecord(countsValue)) {
      throw new Error(`Behavioral V4 count map ${contextKey} is invalid.`);
    }
    const counts: Record<string, number> = {};
    for (const [actionKey, count] of Object.entries(countsValue)) {
      if (!isNonNegativeInteger(count)) {
        throw new Error(`Behavioral V4 count ${contextKey}/${actionKey} is invalid.`);
      }
      counts[actionKey] = count;
    }
    result[contextKey] = counts;
  }
  return result;
}

function asBinaryCountTableRecord(value: unknown): BinaryCountTableRecord {
  if (!isRecord(value)) {
    throw new Error('Value V4 binary count table is invalid.');
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, count]) => [key, asBinaryCount(count)]),
  );
}

function asBinaryCount(value: unknown): BinaryCount {
  if (!isRecord(value) || !isNonNegativeInteger(value.wins) || !isNonNegativeInteger(value.total) || value.wins > value.total) {
    throw new Error('Value V4 binary count is invalid.');
  }
  return { wins: value.wins, total: value.total };
}

function createMutableAggregate(): MutableAggregate {
  return {
    decisionCount: 0,
    rewardSum: 0,
    ipsNumerator: 0,
    snipsNumerator: 0,
    weightSum: 0,
    weightSquareSum: 0,
    directSum: 0,
    doublyRobustSum: 0,
  };
}

function addContribution(
  aggregate: MutableAggregate,
  contribution: RecommendationPolicyV4DecisionContribution,
): void {
  aggregate.decisionCount += 1;
  aggregate.rewardSum += contribution.reward;
  aggregate.ipsNumerator += contribution.ipsContribution;
  aggregate.snipsNumerator += contribution.snipsContribution;
  aggregate.weightSum += contribution.clippedImportanceWeight;
  aggregate.weightSquareSum +=
    contribution.clippedImportanceWeight *
    contribution.clippedImportanceWeight;
  aggregate.directSum += contribution.directValue;
  aggregate.doublyRobustSum += contribution.doublyRobustContribution;
}

function addMatchAggregate(
  aggregate: MutableAggregate,
  match: RecommendationPolicyV4MatchContribution,
): void {
  aggregate.decisionCount += match.decisionCount;
  aggregate.rewardSum += match.rewardSum;
  aggregate.ipsNumerator += match.ipsNumerator;
  aggregate.snipsNumerator += match.snipsNumerator;
  aggregate.weightSum += match.weightSum;
  aggregate.weightSquareSum += match.weightSquareSum;
  aggregate.directSum += match.directSum;
  aggregate.doublyRobustSum += match.doublyRobustSum;
}

function toMatchContribution(
  matchId: string,
  aggregate: MutableAggregate,
): RecommendationPolicyV4MatchContribution {
  return {
    matchId,
    decisionCount: aggregate.decisionCount,
    rewardSum: aggregate.rewardSum,
    ipsNumerator: aggregate.ipsNumerator,
    snipsNumerator: aggregate.snipsNumerator,
    weightSum: aggregate.weightSum,
    weightSquareSum: aggregate.weightSquareSum,
    directSum: aggregate.directSum,
    doublyRobustSum: aggregate.doublyRobustSum,
  };
}

function candidatePoliciesAreFinite(
  candidates: readonly CandidatePolicyValue[],
): boolean {
  return (
    candidates.length > 0 &&
    candidates.every(
      (candidate) =>
        Number.isFinite(candidate.behaviorScore) &&
        Number.isFinite(candidate.behaviorProbability) &&
        candidate.behaviorProbability > 0 &&
        Number.isFinite(candidate.valueProbability) &&
        candidate.valueProbability > 0 &&
        candidate.valueProbability < 1 &&
        Number.isFinite(candidate.targetScore) &&
        Number.isFinite(candidate.targetProbability) &&
        candidate.targetProbability > 0,
    )
  );
}

function policyEntropy(candidates: readonly CandidatePolicyValue[]): number {
  return -candidates.reduce(
    (sum, candidate) =>
      sum +
      candidate.targetProbability *
        Math.log(Math.max(PROBABILITY_EPSILON, candidate.targetProbability)),
    0,
  );
}

function logProbability(
  counts: Record<string, number> | undefined,
  actionKey: string,
  vocabularySize: number,
  smoothing: number,
): number {
  const count = counts?.[actionKey] ?? 0;
  const total = counts
    ? Object.values(counts).reduce((sum, value) => sum + value, 0)
    : 0;
  return Math.log(
    (count + smoothing) /
      (total + smoothing * Math.max(1, vocabularySize)),
  );
}

function hasMinimumCountObservations(
  counts: Record<string, number> | undefined,
  minimum: number,
): boolean {
  return Boolean(
    counts &&
      Object.values(counts).reduce((sum, value) => sum + value, 0) >= minimum,
  );
}

function posteriorProbability(
  count: BinaryCount | undefined,
  priorProbability: number,
  priorStrength: number,
): number {
  if (!count || count.total <= 0) {
    return clampProbability(priorProbability);
  }
  return clampProbability(
    (count.wins + priorStrength * priorProbability) /
      (count.total + priorStrength),
  );
}

function hasMinimumBinaryObservations(
  count: BinaryCount | undefined,
  minimum: number,
): count is BinaryCount {
  return Boolean(count && count.total >= minimum);
}

function probabilityLogit(probability: number): number {
  const value = clampProbability(probability);
  return Math.log(value / (1 - value));
}

function probabilityFromLogit(value: number): number {
  if (value >= 0) {
    const exponent = Math.exp(-value);
    return 1 / (1 + exponent);
  }
  const exponent = Math.exp(value);
  return exponent / (1 + exponent);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function clampProbability(value: number): number {
  return Math.min(
    1 - PROBABILITY_EPSILON,
    Math.max(PROBABILITY_EPSILON, value),
  );
}

function summarizeNumbers(values: readonly number[]): Record<string, number> {
  if (values.length === 0) {
    return {
      count: 0,
      minimum: 0,
      p01: 0,
      p05: 0,
      median: 0,
      p95: 0,
      p99: 0,
      maximum: 0,
      mean: 0,
    };
  }
  return {
    count: values.length,
    minimum: Math.min(...values),
    p01: quantile(values, 0.01),
    p05: quantile(values, 0.05),
    median: quantile(values, 0.5),
    p95: quantile(values, 0.95),
    p99: quantile(values, 0.99),
    maximum: Math.max(...values),
    mean: average(values),
  };
}

function quantile(values: readonly number[], probability: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * probability;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  if (lowerIndex === upperIndex) {
    return sorted[lowerIndex];
  }
  const fraction = position - lowerIndex;
  return sorted[lowerIndex] * (1 - fraction) + sorted[upperIndex] * fraction;
}

function createSeededRandom(seed: number): () => number {
  let state = (seed >>> 0) || 0x6d2b79f5;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function uniqueActionKeys(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function readReleaseGatePassed(manifest: Record<string, unknown>): boolean {
  const direct = asRecord(manifest.releaseGate);
  const evaluationSummary = asRecord(manifest.evaluationSummary);
  const summarized = asRecord(evaluationSummary.releaseGate);
  return Boolean(direct.passed ?? summarized.passed);
}

function readNestedString(
  value: Record<string, unknown>,
  path: readonly string[],
): string {
  let current: unknown = value;
  for (const key of path) {
    current = asRecord(current)[key];
  }
  if (typeof current !== 'string' || !current.trim()) {
    throw new Error(`Required manifest field ${path.join('.')} is missing.`);
  }
  return current;
}

function assertHash(actual: string, expected: string, label: string): void {
  if (actual !== expected) {
    throw new Error(
      `${label} SHA-256 mismatch: expected ${expected}, received ${actual}.`,
    );
  }
}

function assertOptionalExpectedHash(
  expected: string | undefined,
  actual: string,
  label: string,
): void {
  if (expected && expected !== actual) {
    throw new Error(
      `${label} SHA-256 mismatch: expected ${expected}, received ${actual}.`,
    );
  }
}

function normalizeOptions(
  request: RecommendationPolicyV4EvaluationStartRequest,
): RecommendationPolicyV4EvaluationOptions {
  return {
    behaviorTemperature: normalizeNumber(
      request.behaviorTemperature,
      'behaviorTemperature',
      1,
      0.05,
      20,
    ),
    targetTemperature: normalizeNumber(
      request.targetTemperature,
      'targetTemperature',
      1,
      0.05,
      20,
    ),
    targetValueWeight: normalizeNumber(
      request.targetValueWeight,
      'targetValueWeight',
      1,
      0,
      20,
    ),
    minBehaviorProbability: normalizeNumber(
      request.minBehaviorProbability,
      'minBehaviorProbability',
      0.01,
      0.000001,
      0.5,
    ),
    maxImportanceWeight: normalizeNumber(
      request.maxImportanceWeight,
      'maxImportanceWeight',
      10,
      1,
      1_000,
    ),
    bootstrapReplicates: normalizeInteger(
      request.bootstrapReplicates,
      'bootstrapReplicates',
      1_000,
      100,
      10_000,
    ),
    bootstrapSeed: normalizeInteger(
      request.bootstrapSeed,
      'bootstrapSeed',
      20_260_724,
      1,
      2_147_483_647,
    ),
    maxCandidateActions: normalizeInteger(
      request.maxCandidateActions,
      'maxCandidateActions',
      128,
      2,
      512,
    ),
    expectedDatasetSha256: normalizeSha256(request.expectedDatasetSha256),
    expectedBehavioralModelSha256: normalizeSha256(
      request.expectedBehavioralModelSha256,
    ),
    expectedValueModelSha256: normalizeSha256(
      request.expectedValueModelSha256,
    ),
  };
}

function normalizeNumber(
  value: number | undefined,
  fieldName: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) {
    return defaultValue;
  }
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(
      `${fieldName} must be a finite number from ${minimum} to ${maximum}.`,
    );
  }
  return value;
}

function normalizeInteger(
  value: number | undefined,
  fieldName: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) {
    return defaultValue;
  }
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(
      `${fieldName} must be a safe integer from ${minimum} to ${maximum}.`,
    );
  }
  return value;
}

function normalizeSha256(value: string | undefined): string | undefined {
  if (value === undefined || !value.trim()) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error('Expected SHA-256 values must contain 64 hexadecimal characters.');
  }
  return normalized;
}

async function eachNdjson(
  path: string,
  visitor: (value: unknown, lineNumber: number) => Promise<void> | void,
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
      throw new Error(`Invalid JSON at ${path} line ${lineNumber}.`);
    }
    await visitor(value, lineNumber);
  }
}

async function requiredJson<T>(path: string): Promise<T> {
  const value = await readJson(path);
  if (!value) {
    throw new Error(`Required artifact is missing: ${path}.`);
  }
  return value as T;
}

async function readJson(
  path: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const content = await readFile(path, 'utf8');
    const value = JSON.parse(content) as unknown;
    return isRecord(value) ? value : undefined;
  } catch (error) {
    if (isErrorWithCode(error) && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const partialPath = `${path}.partial`;
  await writeFile(partialPath, `${JSON.stringify(value, undefined, 2)}\n`, 'utf8');
  await rm(path, { force: true });
  await rename(partialPath, path);
}

async function promote(path: string): Promise<void> {
  await rm(path, { force: true });
  await rename(`${path}.partial`, path);
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

class LineWriter {
  private buffer = '';

  private constructor(private readonly handle: FileHandle) {}

  static async create(path: string): Promise<LineWriter> {
    await rm(path, { force: true });
    return new LineWriter(await open(path, 'w'));
  }

  async write(value: unknown): Promise<void> {
    this.buffer += `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(this.buffer, 'utf8') >= BUFFER_LIMIT_BYTES) {
      await this.flush();
    }
  }

  async close(): Promise<void> {
    await this.flush();
    await this.handle.close();
  }

  private async flush(): Promise<void> {
    if (!this.buffer) {
      return;
    }
    const value = this.buffer;
    this.buffer = '';
    await this.handle.write(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isErrorWithCode(value: unknown): value is { code: string } {
  return isRecord(value) && typeof value.code === 'string';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function toNumber(value: unknown): number {
  return isFiniteNumber(value) ? value : 0;
}

function average(values: readonly number[]): number {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function averageOr(values: readonly number[], fallback: number): number {
  return values.length > 0 ? average(values) : fallback;
}

function divide(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
