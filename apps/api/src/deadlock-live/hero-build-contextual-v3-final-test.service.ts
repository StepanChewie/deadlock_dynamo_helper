import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { Repository } from 'typeorm';
import { ItemComponent } from './entities/item-component.entity';
import { Item } from './entities/item.entity';
import { MatchPlayer } from './entities/match-player.entity';
import { Match } from './entities/match.entity';
import {
  ContextualV3CandidateCatalog,
  buildContextualV3CandidateReleaseGate,
  isContextualV3CandidateActionLegal,
  orderContextualV3CandidateActions,
} from './hero-build-contextual-v3-candidate-evaluation.service';
import {
  assignArchetype,
  ContextualV3ArchetypeDefinition,
} from './hero-build-contextual-v3-training.service';
import {
  createHeroBuildDecisionRows,
  HeroBuildDecisionActionType,
  HeroBuildDecisionDatasetV3Row,
} from './hero-build-decision-dataset-v3.service';
import {
  HeroBuildOfflineEvaluationDataLoaderService,
  HeroBuildOfflineLoadedHeroSample,
  chunkValues,
  isEvaluableBuildSequence,
} from './hero-build-offline-evaluation-data-loader.service';

const SCHEMA_VERSION = 1;
const FINAL_TEST_MATCH_COUNT = 1_950;
const DEFAULT_BATCH_SIZE = 100;
const MIN_BATCH_SIZE = 10;
const MAX_BATCH_SIZE = 500;
const DEFAULT_TRAINING_DIR = '/app/apps/api/storage/contextual-v3-training';
const DEFAULT_CANDIDATE_EVALUATION_DIR =
  '/app/apps/api/storage/contextual-v3-candidate-evaluation-v2';
const DEFAULT_OUTPUT_DIR = '/app/apps/api/storage/contextual-v3-final-test';
const BUFFER_LIMIT = 1024 * 1024;
const EXPECTED_CANDIDATE_POLICY =
  'TRAIN_OBSERVED_GLOBAL_BACKOFF_LEGAL_SHORTLIST';
const EXPECTED_CANDIDATE_LIMIT = 128;
const TOTAL_CACHE = new WeakMap<object, number>();

export interface ContextualV3FinalTestStartRequest {
  batchSize?: number;
}

interface FinalTestOptions {
  batchSize: number;
  matchCount: number;
  candidateLimit: number;
}

export interface ContextualV3FinalTestStatus {
  state: 'IDLE' | 'RUNNING' | 'COMPLETE' | 'FAILED';
  phase: 'PREPARING' | 'EXTRACTING' | 'EVALUATING' | 'FINALIZING' | 'COMPLETE';
  selectedMatchCount: number;
  totalHeroCount: number;
  processedHeroCount: number;
  processedMatchCount: number;
  decisionCount: number;
  candidateCoveredDecisionCount: number;
  excludedSequenceCount: number;
  excludedSellActionCount: number;
  outputDirectory: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  options?: FinalTestOptions;
  evaluationAvailable: boolean;
  auditAvailable: boolean;
  manifestAvailable: boolean;
  datasetAvailable: boolean;
}

export interface ContextualV3FinalTestDescriptor {
  matchId: number;
  startTime: string;
}

interface ArtifactDescriptor {
  fileName: string;
  byteLength: number;
  sha256: string;
  rowCount?: number;
}

interface TrainingManifest {
  schemaVersion: number;
  pipelineVersion: string;
  generatedAt: string;
  artifacts: {
    model: ArtifactDescriptor;
  };
  futureFinalTestNotBeforeMatchStartTime: string;
}

interface CandidateEvaluationManifest {
  schemaVersion: number;
  evaluationVersion: string;
  generatedAt: string;
  source: {
    modelSha256: string;
    modelVersion: string;
  };
  candidatePolicy: {
    name: string;
    candidateLimit: number;
  };
  evaluationReleaseGatePassed: boolean;
  futureFinalTestNotBeforeMatchStartTime: string;
}

interface CandidateEvaluation {
  schemaVersion: number;
  evaluationVersion: string;
  releaseGate: {
    passed: boolean;
  };
}

type CountRecord = Record<string, number>;
type CountTable = Record<string, CountRecord>;

interface SerializedModel {
  schemaVersion: number;
  modelVersion: string;
  generatedAt: string;
  options?: {
    smoothing?: number;
  };
  weights?: {
    archetypeDelta?: number;
    alliedRosterDeltaAverage?: number;
    enemyRosterDeltaAverage?: number;
  };
  archetypes: {
    fitSplit: 'TRAIN';
    definitionsByHero: Record<string, ContextualV3ArchetypeDefinition[]>;
  };
  counts: {
    hero: CountTable;
    heroPhase: CountTable;
    heroPhaseArchetype: CountTable;
    ally: CountTable;
    enemy: CountTable;
  };
}

interface PreparedFinalTestRow {
  schemaVersion: number;
  decisionId: string;
  matchId: number;
  matchStartTime: string;
  playerId: number;
  features: {
    heroId: number;
    team: number;
    gameTimeS: number;
    phase: string;
    inventoryBeforeStateKey: string;
    previousActionKeys: string[];
    buildPrefixKey: string;
    alliedHeroIds: number[];
    enemyHeroIds: number[];
    buildArchetypeId: string;
  };
  target: {
    actionType: HeroBuildDecisionActionType;
    itemId: number;
    actionKey: string;
  };
  outcomeLabel: {
    playerWon: boolean;
  };
}

interface Metrics {
  evaluatedDecisionCount: number;
  top1Count: number;
  top3Count: number;
  reciprocalRankSum: number;
}

interface CandidateCoverageDiagnostics {
  unseenInTrainCount: number;
  illegalByCatalogCount: number;
  truncatedByLimitCount: number;
  unexplainedCount: number;
}

interface CandidateSelection {
  actions: string[];
  actualActionObservedInTrain: boolean;
  actualActionLegal: boolean;
  actualActionRankBeforeLimit: number;
}

interface RawMatchDescriptor {
  matchId: string | number;
  startTime: string | Date;
}

@Injectable()
export class HeroBuildContextualV3FinalTestService implements OnModuleInit {
  private readonly logger = new Logger(HeroBuildContextualV3FinalTestService.name);
  private readonly trainingDir =
    process.env.DEADLOCK_CONTEXTUAL_V3_TRAINING_DIR?.trim() || DEFAULT_TRAINING_DIR;
  private readonly candidateEvaluationDir =
    process.env.DEADLOCK_CONTEXTUAL_V3_CANDIDATE_EVALUATION_DIR?.trim() ||
    DEFAULT_CANDIDATE_EVALUATION_DIR;
  private readonly outputDir =
    process.env.DEADLOCK_CONTEXTUAL_V3_FINAL_TEST_DIR?.trim() || DEFAULT_OUTPUT_DIR;
  private readonly paths = {
    dataset: join(this.outputDir, 'final-test.ndjson'),
    candidates: join(this.outputDir, 'candidate-sets.ndjson'),
    selectedMatches: join(this.outputDir, 'selected-matches.json'),
    evaluation: join(this.outputDir, 'evaluation.json'),
    audit: join(this.outputDir, 'audit.json'),
    manifest: join(this.outputDir, 'manifest.json'),
  };
  private readonly trainingManifestPath = join(this.trainingDir, 'manifest.json');
  private readonly candidateEvaluationManifestPath = join(
    this.candidateEvaluationDir,
    'manifest.json',
  );
  private readonly candidateEvaluationPath = join(
    this.candidateEvaluationDir,
    'evaluation.json',
  );

  private status = this.idleStatus();
  private evaluation?: Record<string, unknown>;
  private audit?: Record<string, unknown>;
  private manifest?: Record<string, unknown>;

  constructor(
    @InjectRepository(Match)
    private readonly matchRepository: Repository<Match>,
    @InjectRepository(MatchPlayer)
    private readonly matchPlayerRepository: Repository<MatchPlayer>,
    @InjectRepository(Item)
    private readonly itemRepository: Repository<Item>,
    @InjectRepository(ItemComponent)
    private readonly itemComponentRepository: Repository<ItemComponent>,
    private readonly dataLoader: HeroBuildOfflineEvaluationDataLoaderService,
  ) {}

  async onModuleInit(): Promise<void> {
    await mkdir(this.outputDir, { recursive: true });
    this.evaluation = await readJson(this.paths.evaluation);
    this.audit = await readJson(this.paths.audit);
    this.manifest = await readJson(this.paths.manifest);
    if (this.evaluation && this.audit && this.manifest) {
      const source = asRecord(this.audit.source);
      const decisions = asRecord(this.audit.decisions);
      const candidates = asRecord(this.audit.candidates);
      this.status = {
        ...this.idleStatus(),
        state: 'COMPLETE',
        phase: 'COMPLETE',
        selectedMatchCount: toNumber(source.selectedMatchCount),
        decisionCount: toNumber(decisions.rowCount),
        candidateCoveredDecisionCount: toNumber(candidates.coveredDecisionCount),
        completedAt: String(this.manifest.generatedAt ?? ''),
        evaluationAvailable: true,
        auditAvailable: true,
        manifestAvailable: true,
        datasetAvailable: true,
      };
    }
  }

  getStatus(): ContextualV3FinalTestStatus {
    return clone(this.status);
  }

  getEvaluation(): Record<string, unknown> | undefined {
    return this.evaluation ? clone(this.evaluation) : undefined;
  }

  getAudit(): Record<string, unknown> | undefined {
    return this.audit ? clone(this.audit) : undefined;
  }

  getManifest(): Record<string, unknown> | undefined {
    return this.manifest ? clone(this.manifest) : undefined;
  }

  async start(
    request: ContextualV3FinalTestStartRequest = {},
  ): Promise<ContextualV3FinalTestStatus> {
    if (this.status.state === 'RUNNING') {
      throw new Error('Contextual V3 future final test is already running.');
    }
    const options = normalizeOptions(request);
    this.status = {
      ...this.idleStatus(),
      state: 'RUNNING',
      startedAt: new Date().toISOString(),
      options,
      evaluationAvailable: this.evaluation !== undefined,
      auditAvailable: this.audit !== undefined,
      manifestAvailable: this.manifest !== undefined,
      datasetAvailable: this.status.datasetAvailable,
    };
    void this.run(options);
    return this.getStatus();
  }

  private async run(options: FinalTestOptions): Promise<void> {
    try {
      const [trainingManifest, candidateManifest, candidateEvaluation] =
        await Promise.all([
          requiredJson<TrainingManifest>(this.trainingManifestPath),
          requiredJson<CandidateEvaluationManifest>(
            this.candidateEvaluationManifestPath,
          ),
          requiredJson<CandidateEvaluation>(this.candidateEvaluationPath),
        ]);
      validateReleaseSources(trainingManifest, candidateManifest, candidateEvaluation);
      const cutoff = resolveFinalTestCutoff(trainingManifest, candidateManifest);
      const modelArtifact = trainingManifest.artifacts?.model;
      validateArtifactDescriptor(modelArtifact, 'model');
      const modelPath = join(this.trainingDir, modelArtifact.fileName);
      const [modelSha256, model, catalog, rawDescriptors] = await Promise.all([
        hashFile(modelPath),
        requiredJson<SerializedModel>(modelPath),
        this.loadCatalog(),
        this.loadFutureMatchDescriptors(cutoff, options.matchCount),
      ]);
      if (
        modelSha256 !== modelArtifact.sha256 ||
        modelSha256 !== candidateManifest.source.modelSha256
      ) {
        throw new Error('The frozen model SHA-256 does not match release artifacts.');
      }
      validateModel(model);
      const descriptors = selectContextualV3FinalTestDescriptors(
        rawDescriptors,
        cutoff,
        options.matchCount,
      );
      const evaluationDescriptors = descriptors.map((descriptor) => ({
        matchId: descriptor.matchId,
        startTime: new Date(descriptor.startTime),
      }));
      const heroIds = await this.dataLoader.collectHeroIds(
        evaluationDescriptors,
        options.batchSize,
      );
      if (heroIds.length === 0) {
        throw new Error('No heroes are available for the future final test.');
      }
      const globalCounts = aggregateGlobalCounts(model.counts.hero);
      const catalogSha256 = hashCatalog(catalog);

      await mkdir(this.outputDir, { recursive: true });
      await this.clearOutputs();
      this.evaluation = undefined;
      this.audit = undefined;
      this.manifest = undefined;
      await atomicJson(this.paths.selectedMatches, {
        schemaVersion: SCHEMA_VERSION,
        selectionPolicy: 'OLDEST_STRICTLY_FUTURE_STANDARD_6V6_MATCHES',
        cutoffExclusive: cutoff,
        requiredMatchCount: options.matchCount,
        descriptorSha256: hashDescriptors(descriptors),
        matches: descriptors,
      });

      this.status = {
        ...this.status,
        phase: 'EXTRACTING',
        selectedMatchCount: descriptors.length,
        totalHeroCount: heroIds.length,
        processedHeroCount: 0,
        processedMatchCount: 0,
        decisionCount: 0,
        candidateCoveredDecisionCount: 0,
        excludedSequenceCount: 0,
        excludedSellActionCount: 0,
        evaluationAvailable: false,
        auditAvailable: false,
        manifestAvailable: false,
        datasetAvailable: false,
      };

      const datasetWriter = await LineWriter.create(`${this.paths.dataset}.partial`);
      const candidateWriter = await LineWriter.create(
        `${this.paths.candidates}.partial`,
      );
      const baseline = emptyMetrics();
      const contextual = emptyMetrics();
      const diagnostics: CandidateCoverageDiagnostics = {
        unseenInTrainCount: 0,
        illegalByCatalogCount: 0,
        truncatedByLimitCount: 0,
        unexplainedCount: 0,
      };
      const decisionIds = new Set<string>();
      const matchesWithRows = new Set<number>();
      const playersWithRows = new Set<string>();
      let decisionCount = 0;
      let coveredCount = 0;
      let excludedSequenceCount = 0;
      let excludedSellActionCount = 0;
      let duplicateDecisionCount = 0;
      let incompleteRosterRowCount = 0;
      const smoothing = boundedNumber(model.options?.smoothing, 10, 0.01, 10_000);
      const weights = {
        archetypeDelta: boundedNumber(model.weights?.archetypeDelta, 0.5, 0, 10),
        alliedRosterDeltaAverage: boundedNumber(
          model.weights?.alliedRosterDeltaAverage,
          0.08,
          0,
          10,
        ),
        enemyRosterDeltaAverage: boundedNumber(
          model.weights?.enemyRosterDeltaAverage,
          0.12,
          0,
          10,
        ),
      };

      try {
        for (let heroIndex = 0; heroIndex < heroIds.length; heroIndex += 1) {
          const heroId = heroIds[heroIndex];
          const batches = chunkValues(evaluationDescriptors, options.batchSize);
          for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
            const batch = batches[batchIndex];
            const [loaded, roster] = await Promise.all([
              this.dataLoader.loadHeroBatch(
                heroId,
                batch,
                options.batchSize,
                `V3 future final test hero ${heroId}, batch ${batchIndex + 1}`,
              ),
              this.loadRoster(batch.map((descriptor) => descriptor.matchId)),
            ]);
            const rosterByMatchId = groupBy(
              roster,
              (player) => Number(player.matchId),
            );
            for (const sample of loaded.samples.sort(compareSamples)) {
              if (!isEvaluableBuildSequence(sample.sequence)) {
                excludedSequenceCount += 1;
                continue;
              }
              const alliedHeroIds = normalizeHeroIds(
                (rosterByMatchId.get(sample.descriptor.matchId) ?? [])
                  .filter(
                    (player) =>
                      Number(player.team) === sample.player.team &&
                      Number(player.id) !== sample.player.id,
                  )
                  .map((player) => Number(player.heroId)),
              );
              const extracted = createHeroBuildDecisionRows(
                sample,
                alliedHeroIds,
                false,
              );
              excludedSellActionCount += extracted.excludedSellActionCount;
              for (const row of extracted.rows) {
                decisionCount += 1;
                if (decisionIds.has(row.decisionId)) {
                  duplicateDecisionCount += 1;
                } else {
                  decisionIds.add(row.decisionId);
                }
                if (row.alliedHeroIds.length !== 5 || row.enemyHeroIds.length !== 6) {
                  incompleteRosterRowCount += 1;
                }
                matchesWithRows.add(row.matchId);
                playersWithRows.add(`${row.matchId}:${row.playerId}`);
                const prepared = prepareFinalTestRow(
                  row,
                  assignArchetype(
                    row.heroId,
                    row.previousActionKeys,
                    model.archetypes.definitionsByHero,
                  ),
                );
                const selection = createCandidateSelection(
                  prepared,
                  model,
                  globalCounts,
                  catalog,
                  options.candidateLimit,
                );
                const covered = selection.actions.includes(prepared.target.actionKey);
                coveredCount += covered ? 1 : 0;
                if (!covered) {
                  applyCoverageDiagnostic(
                    diagnostics,
                    selection,
                    options.candidateLimit,
                  );
                }
                await datasetWriter.write(prepared);
                await candidateWriter.write({
                  schemaVersion: SCHEMA_VERSION,
                  decisionId: prepared.decisionId,
                  candidateActionKeys: selection.actions,
                  actualActionKey: prepared.target.actionKey,
                  actualActionCovered: covered,
                  actualActionObservedInTrain: selection.actualActionObservedInTrain,
                  actualActionLegal: selection.actualActionLegal,
                  actualActionRankBeforeLimit: selection.actualActionRankBeforeLimit,
                });
                updateMetrics(
                  baseline,
                  rankBaseline(prepared, selection.actions, model, smoothing),
                  prepared.target.actionKey,
                );
                updateMetrics(
                  contextual,
                  rankContextual(
                    prepared,
                    selection.actions,
                    model,
                    smoothing,
                    weights,
                  ),
                  prepared.target.actionKey,
                );
                if (decisionCount % 1_000 === 0) {
                  this.status = {
                    ...this.status,
                    phase: 'EVALUATING',
                    decisionCount,
                    candidateCoveredDecisionCount: coveredCount,
                    excludedSequenceCount,
                    excludedSellActionCount,
                  };
                }
                if (decisionCount % 10_000 === 0) {
                  await tick();
                }
              }
            }
            this.status = {
              ...this.status,
              processedMatchCount: Math.min(
                descriptors.length,
                (batchIndex + 1) * options.batchSize,
              ),
            };
          }
          this.status = {
            ...this.status,
            processedHeroCount: heroIndex + 1,
          };
        }
      } finally {
        await Promise.all([datasetWriter.close(), candidateWriter.close()]);
      }

      if (decisionCount === 0) {
        throw new Error('The future final test produced no decision rows.');
      }
      await Promise.all([promote(this.paths.dataset), promote(this.paths.candidates)]);
      this.status = {
        ...this.status,
        phase: 'FINALIZING',
        processedHeroCount: heroIds.length,
        processedMatchCount: descriptors.length,
        decisionCount,
        candidateCoveredDecisionCount: coveredCount,
        excludedSequenceCount,
        excludedSellActionCount,
        datasetAvailable: true,
      };

      const generatedAt = new Date().toISOString();
      const baselineFinal = finalizeMetrics(baseline);
      const contextualFinal = finalizeMetrics(contextual);
      const coverageRate = divide(coveredCount, decisionCount);
      const deltas = {
        top1Rate: contextualFinal.top1Rate - baselineFinal.top1Rate,
        top3Rate: contextualFinal.top3Rate - baselineFinal.top3Rate,
        meanReciprocalRank:
          contextualFinal.meanReciprocalRank - baselineFinal.meanReciprocalRank,
      };
      const releaseGate = buildContextualV3CandidateReleaseGate(
        coverageRate,
        deltas.top1Rate,
        deltas.top3Rate,
      );
      const uncoveredCount = decisionCount - coveredCount;
      const classifiedUncoveredCount = Object.values(diagnostics).reduce(
        (total, value) => total + value,
        0,
      );
      const auditPassed =
        descriptors.length === options.matchCount &&
        descriptors.every((descriptor) =>
          isStrictlyNewerThanCutoff(descriptor.startTime, cutoff),
        ) &&
        decisionCount > 0 &&
        matchesWithRows.size === descriptors.length &&
        duplicateDecisionCount === 0 &&
        incompleteRosterRowCount === 0 &&
        uncoveredCount === classifiedUncoveredCount &&
        diagnostics.unexplainedCount === 0;
      const shadowEligible = releaseGate.passed && auditPassed;
      const evaluation = {
        schemaVersion: SCHEMA_VERSION,
        evaluationVersion: 'CONTEXTUAL_V3_FUTURE_FINAL_TEST_1',
        generatedAt,
        split: 'FINAL_TEST',
        modelVersion: model.modelVersion,
        candidateSetPolicy: EXPECTED_CANDIDATE_POLICY,
        candidateLimit: options.candidateLimit,
        finalTestMatchCount: descriptors.length,
        finalTestDecisionCount: decisionCount,
        candidateCoveredDecisionCount: coveredCount,
        candidateCoverageRate: coverageRate,
        candidateCoverageDiagnostics: { ...diagnostics },
        baseline: baselineFinal,
        contextual: contextualFinal,
        deltas,
        releaseGate: {
          minimumCandidateCoverageRate: 0.98,
          minimumTop1Delta: 0.001,
          maximumTop3Regression: 0.0005,
          ...releaseGate,
        },
        productionDecision: {
          status: shadowEligible ? 'ELIGIBLE_FOR_SHADOW_MODE' : 'BLOCKED',
          reason: shadowEligible
            ? 'The frozen model, candidate policy, release gate, and final-test audit passed.'
            : !auditPassed
              ? 'The strictly future final-test audit failed.'
              : 'The strictly future final-test release gate failed.',
        },
      };
      const auditWarnings: string[] = [];
      if (excludedSequenceCount > 0) {
        auditWarnings.push(
          `${excludedSequenceCount} player sequences were excluded because they were not safe to evaluate.`,
        );
      }
      if (uncoveredCount > 0) {
        auditWarnings.push(
          `${uncoveredCount} final-test actions were not covered by the fixed shortlist.`,
        );
      }
      if (!auditPassed) {
        auditWarnings.push(
          'The future final-test audit failed; shadow mode and production deployment remain blocked.',
        );
      }
      if (!releaseGate.passed) {
        auditWarnings.push(
          'The future final-test release gate failed; shadow mode and production deployment remain blocked.',
        );
      }
      const audit = {
        schemaVersion: SCHEMA_VERSION,
        generatedAt,
        passed: auditPassed,
        source: {
          selectionPolicy: 'OLDEST_STRICTLY_FUTURE_STANDARD_6V6_MATCHES',
          cutoffExclusive: cutoff,
          requiredMatchCount: options.matchCount,
          selectedMatchCount: descriptors.length,
          selectedWindowStartTime: descriptors[0].startTime,
          selectedWindowEndTime: descriptors[descriptors.length - 1].startTime,
          descriptorSha256: hashDescriptors(descriptors),
          modelExpectedSha256: modelArtifact.sha256,
          modelActualSha256: modelSha256,
          candidateEvaluationVersion: candidateManifest.evaluationVersion,
          candidateEvaluationReleaseGatePassed:
            candidateManifest.evaluationReleaseGatePassed,
          catalogSha256,
        },
        decisions: {
          rowCount: decisionCount,
          duplicateDecisionCount,
          matchCountWithRows: matchesWithRows.size,
          playerCountWithRows: playersWithRows.size,
          excludedSequenceCount,
          excludedSellActionCount,
          incompleteRosterRowCount,
        },
        candidates: {
          policy: EXPECTED_CANDIDATE_POLICY,
          candidateLimit: options.candidateLimit,
          coveredDecisionCount: coveredCount,
          coverageRate,
          uncoveredDecisionCount: uncoveredCount,
          diagnostics: { ...diagnostics },
        },
        leakage: {
          modelFitSplit: 'TRAIN',
          archetypeFitSplit: model.archetypes.fitSplit,
          finalTestRowsUsedForTraining: false,
          targetUsedForCandidateConstruction: false,
          targetUsedForCoverageDiagnosticsOnly: true,
          candidateInputs: [
            'features.heroId',
            'features.phase',
            'features.inventoryBeforeStateKey',
            'train.counts.heroPhase',
            'train.counts.hero',
            'train.globalActionCounts',
            'itemCatalog',
            'itemRecipes',
          ],
        },
        warnings: auditWarnings,
      };
      await Promise.all([
        atomicJson(this.paths.evaluation, evaluation),
        atomicJson(this.paths.audit, audit),
      ]);
      const manifest = await this.buildManifest({
        generatedAt,
        cutoff,
        descriptors,
        model,
        modelSha256,
        catalogSha256,
        candidateManifest,
        evaluation,
        audit,
        decisionCount,
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
        evaluationAvailable: true,
        auditAvailable: true,
        manifestAvailable: true,
        datasetAvailable: true,
        error: undefined,
      };
      this.logger.log(
        `Contextual V3 future final test completed with ${decisionCount} decisions ` +
          `from ${descriptors.length} matches. Release gate ` +
          `${releaseGate.passed ? 'PASS' : 'FAIL'}.`,
      );
    } catch (error) {
      const message = getErrorMessage(error);
      this.status = {
        ...this.status,
        state: 'FAILED',
        completedAt: new Date().toISOString(),
        error: message,
      };
      this.logger.error(`Contextual V3 future final test failed: ${message}`);
    }
  }

  private async loadFutureMatchDescriptors(
    cutoff: string,
    matchCount: number,
  ): Promise<ContextualV3FinalTestDescriptor[]> {
    const rows = await this.dataLoader.withDatabaseRetry(
      'selecting strictly future standard 6v6 matches',
      () =>
        this.matchRepository
          .createQueryBuilder('m')
          .innerJoin(MatchPlayer, 'p', 'p.matchId = m.matchId')
          .select('m.matchId', 'matchId')
          .addSelect('m.startTime', 'startTime')
          .where('m.startTime > :cutoff', { cutoff: new Date(cutoff) })
          .groupBy('m.matchId')
          .addGroupBy('m.startTime')
          .having('COUNT(p.id) = 12')
          .andHaving('COUNT(DISTINCT p.heroId) = 12')
          .andHaving('SUM(CASE WHEN p.team = 0 THEN 1 ELSE 0 END) = 6')
          .andHaving('SUM(CASE WHEN p.team = 1 THEN 1 ELSE 0 END) = 6')
          .orderBy('m.startTime', 'ASC')
          .addOrderBy('m.matchId', 'ASC')
          .limit(matchCount)
          .getRawMany<RawMatchDescriptor>(),
    );
    return rows.map((row) => ({
      matchId: Number(row.matchId),
      startTime: new Date(row.startTime).toISOString(),
    }));
  }

  private async loadRoster(matchIds: number[]): Promise<MatchPlayer[]> {
    if (matchIds.length === 0) {
      return [];
    }
    return this.dataLoader.withDatabaseRetry(
      'loading future final-test rosters',
      () =>
        this.matchPlayerRepository
          .createQueryBuilder('player')
          .where('player.matchId IN (:...matchIds)', { matchIds })
          .getMany(),
    );
  }

  private async loadCatalog(): Promise<ContextualV3CandidateCatalog> {
    const [items, components] = await Promise.all([
      this.itemRepository.find(),
      this.itemComponentRepository.find({
        order: { parentItemId: 'ASC', componentOrder: 'ASC' },
      }),
    ]);
    const itemIds = new Set(
      items
        .filter((item) => Number(item.cost) > 0)
        .map((item) => Number(item.itemId))
        .filter((itemId) => Number.isSafeInteger(itemId) && itemId > 0),
    );
    const componentsByParent = new Map<number, Set<number>>();
    for (const component of components) {
      const parentItemId = Number(component.parentItemId);
      const componentItemId = Number(component.componentItemId);
      if (!itemIds.has(parentItemId) || !itemIds.has(componentItemId)) {
        continue;
      }
      const values = componentsByParent.get(parentItemId) ?? new Set<number>();
      values.add(componentItemId);
      componentsByParent.set(parentItemId, values);
    }
    return { itemIds, componentsByParent };
  }

  private async buildManifest(input: {
    generatedAt: string;
    cutoff: string;
    descriptors: ContextualV3FinalTestDescriptor[];
    model: SerializedModel;
    modelSha256: string;
    catalogSha256: string;
    candidateManifest: CandidateEvaluationManifest;
    evaluation: Record<string, unknown>;
    audit: Record<string, unknown>;
    decisionCount: number;
  }): Promise<Record<string, unknown>> {
    const artifacts: Record<string, unknown> = {};
    const rowCounts: Record<string, number | undefined> = {
      dataset: input.decisionCount,
      candidates: input.decisionCount,
      selectedMatches: input.descriptors.length,
    };
    for (const [name, path] of Object.entries(this.paths)) {
      if (name === 'manifest') {
        continue;
      }
      const info = await stat(path);
      artifacts[name] = {
        fileName: path.split('/').pop(),
        byteLength: info.size,
        sha256: await hashFile(path),
        rowCount: rowCounts[name],
      };
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      evaluationVersion: 'CONTEXTUAL_V3_FUTURE_FINAL_TEST_1',
      generatedAt: input.generatedAt,
      source: {
        selectionPolicy: 'OLDEST_STRICTLY_FUTURE_STANDARD_6V6_MATCHES',
        cutoffExclusive: input.cutoff,
        selectedMatchCount: input.descriptors.length,
        selectedWindowStartTime: input.descriptors[0].startTime,
        selectedWindowEndTime:
          input.descriptors[input.descriptors.length - 1].startTime,
        descriptorSha256: hashDescriptors(input.descriptors),
        modelSha256: input.modelSha256,
        modelVersion: input.model.modelVersion,
        candidateEvaluationVersion: input.candidateManifest.evaluationVersion,
        candidateEvaluationGeneratedAt: input.candidateManifest.generatedAt,
        catalogSha256: input.catalogSha256,
      },
      candidatePolicy: {
        name: EXPECTED_CANDIDATE_POLICY,
        candidateLimit: EXPECTED_CANDIDATE_LIMIT,
        ordering: [
          'HERO_PHASE_COUNT',
          'HERO_COUNT',
          'GLOBAL_TRAIN_COUNT',
          'ACTION_KEY',
        ],
        legality: {
          purchasableItemsOnly: true,
          buyAndRebuyMustNotBeHeld: true,
          upgradeRequiresEveryDirectComponent: true,
          sellExcluded: true,
        },
      },
      artifacts,
      auditPassed: Boolean(input.audit.passed),
      finalTestReleaseGatePassed: Boolean(
        asRecord(input.evaluation.releaseGate).passed,
      ),
      productionDecision: asRecord(input.evaluation.productionDecision),
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

  private idleStatus(): ContextualV3FinalTestStatus {
    return {
      state: 'IDLE',
      phase: 'PREPARING',
      selectedMatchCount: 0,
      totalHeroCount: 0,
      processedHeroCount: 0,
      processedMatchCount: 0,
      decisionCount: 0,
      candidateCoveredDecisionCount: 0,
      excludedSequenceCount: 0,
      excludedSellActionCount: 0,
      outputDirectory: this.outputDir,
      evaluationAvailable: false,
      auditAvailable: false,
      manifestAvailable: false,
      datasetAvailable: false,
    };
  }
}

export function selectContextualV3FinalTestDescriptors(
  candidates: readonly ContextualV3FinalTestDescriptor[],
  cutoffExclusive: string,
  requiredMatchCount: number,
): ContextualV3FinalTestDescriptor[] {
  if (!Number.isSafeInteger(requiredMatchCount) || requiredMatchCount <= 0) {
    throw new Error('requiredMatchCount must be a positive safe integer.');
  }
  const cutoffTime = new Date(cutoffExclusive).getTime();
  if (!Number.isFinite(cutoffTime)) {
    throw new Error('The final-test cutoff is invalid.');
  }
  const byMatchId = new Map<number, ContextualV3FinalTestDescriptor>();
  for (const candidate of candidates) {
    const startTime = new Date(candidate.startTime).getTime();
    if (
      !Number.isSafeInteger(candidate.matchId) ||
      candidate.matchId <= 0 ||
      !Number.isFinite(startTime) ||
      startTime <= cutoffTime
    ) {
      continue;
    }
    const normalized = {
      matchId: candidate.matchId,
      startTime: new Date(startTime).toISOString(),
    };
    const existing = byMatchId.get(candidate.matchId);
    if (existing && existing.startTime !== normalized.startTime) {
      throw new Error(`Conflicting start time for future match ${candidate.matchId}.`);
    }
    byMatchId.set(candidate.matchId, normalized);
  }
  const selected = [...byMatchId.values()]
    .sort(compareDescriptors)
    .slice(0, requiredMatchCount);
  if (selected.length !== requiredMatchCount) {
    throw new Error(
      `Only ${selected.length} strictly future standard 6v6 matches are available; ` +
        `${requiredMatchCount} are required for the frozen final test.`,
    );
  }
  return selected;
}

export function isStrictlyNewerThanCutoff(
  startTime: string,
  cutoffExclusive: string,
): boolean {
  const start = new Date(startTime).getTime();
  const cutoff = new Date(cutoffExclusive).getTime();
  return Number.isFinite(start) && Number.isFinite(cutoff) && start > cutoff;
}

export function hashContextualV3FinalTestDescriptors(
  descriptors: readonly ContextualV3FinalTestDescriptor[],
): string {
  return hashDescriptors(descriptors);
}

function validateReleaseSources(
  trainingManifest: TrainingManifest,
  candidateManifest: CandidateEvaluationManifest,
  candidateEvaluation: CandidateEvaluation,
): void {
  if (
    !candidateManifest.evaluationReleaseGatePassed ||
    !candidateEvaluation.releaseGate?.passed
  ) {
    throw new Error(
      'The frozen validation candidate evaluation did not pass its release gate.',
    );
  }
  if (
    candidateManifest.candidatePolicy?.name !== EXPECTED_CANDIDATE_POLICY ||
    candidateManifest.candidatePolicy?.candidateLimit !== EXPECTED_CANDIDATE_LIMIT
  ) {
    throw new Error(
      'The frozen candidate policy does not match the approved validation policy.',
    );
  }
  if (
    trainingManifest.futureFinalTestNotBeforeMatchStartTime !==
    candidateManifest.futureFinalTestNotBeforeMatchStartTime
  ) {
    throw new Error(
      'Training and candidate-evaluation artifacts disagree on the final-test cutoff.',
    );
  }
}

function resolveFinalTestCutoff(
  trainingManifest: TrainingManifest,
  candidateManifest: CandidateEvaluationManifest,
): string {
  const cutoff =
    candidateManifest.futureFinalTestNotBeforeMatchStartTime ||
    trainingManifest.futureFinalTestNotBeforeMatchStartTime;
  if (!Number.isFinite(new Date(cutoff).getTime())) {
    throw new Error('The future final-test cutoff is invalid.');
  }
  return new Date(cutoff).toISOString();
}

function validateModel(model: SerializedModel): void {
  if (
    model.schemaVersion !== SCHEMA_VERSION ||
    typeof model.modelVersion !== 'string' ||
    model.archetypes?.fitSplit !== 'TRAIN' ||
    !model.archetypes?.definitionsByHero ||
    !model.counts?.hero ||
    !model.counts?.heroPhase ||
    !model.counts?.heroPhaseArchetype ||
    !model.counts?.ally ||
    !model.counts?.enemy
  ) {
    throw new Error('The frozen Contextual V3 model is invalid.');
  }
}

function validateArtifactDescriptor(
  artifact: ArtifactDescriptor | undefined,
  name: string,
): asserts artifact is ArtifactDescriptor {
  if (
    !artifact ||
    typeof artifact.fileName !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(artifact.sha256)
  ) {
    throw new Error(`The ${name} artifact descriptor is invalid.`);
  }
}

function prepareFinalTestRow(
  row: HeroBuildDecisionDatasetV3Row,
  archetypeId: string,
): PreparedFinalTestRow {
  return {
    schemaVersion: SCHEMA_VERSION,
    decisionId: row.decisionId,
    matchId: row.matchId,
    matchStartTime: row.matchStartTime,
    playerId: row.playerId,
    features: {
      heroId: row.heroId,
      team: row.team,
      gameTimeS: row.gameTimeS,
      phase: row.phase,
      inventoryBeforeStateKey: row.inventoryBeforeStateKey,
      previousActionKeys: [...row.previousActionKeys],
      buildPrefixKey: row.buildPrefixKey,
      alliedHeroIds: [...row.alliedHeroIds],
      enemyHeroIds: [...row.enemyHeroIds],
      buildArchetypeId: archetypeId,
    },
    target: {
      actionType: row.actualActionType,
      itemId: row.actualItemId,
      actionKey: row.actualActionKey,
    },
    outcomeLabel: {
      playerWon: row.outcomeLabel.playerWon,
    },
  };
}

function createCandidateSelection(
  row: PreparedFinalTestRow,
  model: SerializedModel,
  globalCounts: CountRecord,
  catalog: ContextualV3CandidateCatalog,
  limit: number,
): CandidateSelection {
  const phaseKey = `${row.features.heroId}|${row.features.phase}`;
  const inventory = parseInventoryItemIds(row.features.inventoryBeforeStateKey);
  const ordered = orderContextualV3CandidateActions(
    model.counts.heroPhase[phaseKey],
    model.counts.hero[String(row.features.heroId)],
    globalCounts,
    inventory,
    catalog,
  );
  return {
    actions: ordered.slice(0, limit),
    actualActionObservedInTrain: globalCounts[row.target.actionKey] !== undefined,
    actualActionLegal: isContextualV3CandidateActionLegal(
      row.target.actionKey,
      inventory,
      catalog,
    ),
    actualActionRankBeforeLimit: ordered.indexOf(row.target.actionKey),
  };
}

function applyCoverageDiagnostic(
  diagnostics: CandidateCoverageDiagnostics,
  selection: CandidateSelection,
  limit: number,
): void {
  if (!selection.actualActionObservedInTrain) {
    diagnostics.unseenInTrainCount += 1;
  } else if (!selection.actualActionLegal) {
    diagnostics.illegalByCatalogCount += 1;
  } else if (selection.actualActionRankBeforeLimit >= limit) {
    diagnostics.truncatedByLimitCount += 1;
  } else {
    diagnostics.unexplainedCount += 1;
  }
}

function rankBaseline(
  row: PreparedFinalTestRow,
  candidates: readonly string[],
  model: SerializedModel,
  smoothing: number,
): string[] {
  const counts =
    model.counts.heroPhase[`${row.features.heroId}|${row.features.phase}`];
  return rank(candidates, (action) =>
    logProbability(counts, action, candidates.length, smoothing),
  );
}

function rankContextual(
  row: PreparedFinalTestRow,
  candidates: readonly string[],
  model: SerializedModel,
  smoothing: number,
  weights: {
    archetypeDelta: number;
    alliedRosterDeltaAverage: number;
    enemyRosterDeltaAverage: number;
  },
): string[] {
  const features = row.features;
  const baseKey = `${features.heroId}|${features.phase}`;
  return rank(candidates, (action) => {
    const base = logProbability(
      model.counts.heroPhase[baseKey],
      action,
      candidates.length,
      smoothing,
    );
    const archetype = logProbability(
      model.counts.heroPhaseArchetype[
        `${baseKey}|${features.buildArchetypeId}`
      ],
      action,
      candidates.length,
      smoothing,
    );
    const allies = features.alliedHeroIds.map((heroId) =>
      logProbability(
        model.counts.ally[`${baseKey}|${heroId}`],
        action,
        candidates.length,
        smoothing,
      ),
    );
    const enemies = features.enemyHeroIds.map((heroId) =>
      logProbability(
        model.counts.enemy[`${baseKey}|${heroId}`],
        action,
        candidates.length,
        smoothing,
      ),
    );
    return (
      base +
      weights.archetypeDelta * (archetype - base) +
      weights.alliedRosterDeltaAverage * (average(allies) - base) +
      weights.enemyRosterDeltaAverage * (average(enemies) - base)
    );
  });
}

function aggregateGlobalCounts(heroTable: CountTable): CountRecord {
  const globalCounts: CountRecord = {};
  for (const counts of Object.values(heroTable)) {
    for (const [actionKey, count] of Object.entries(counts)) {
      globalCounts[actionKey] = (globalCounts[actionKey] ?? 0) + count;
    }
  }
  return globalCounts;
}

function parseInventoryItemIds(stateKey: string): Set<number> {
  if (!stateKey || stateKey === 'EMPTY') {
    return new Set();
  }
  return new Set(
    stateKey
      .split('|')
      .map((value) => Number(value.split('x')[0]))
      .filter((itemId) => Number.isSafeInteger(itemId) && itemId > 0),
  );
}

function rank(
  candidates: readonly string[],
  score: (action: string) => number,
): string[] {
  return [...candidates]
    .map((action) => ({ action, score: score(action) }))
    .sort(
      (left, right) =>
        right.score - left.score || left.action.localeCompare(right.action),
    )
    .map((value) => value.action);
}

function logProbability(
  counts: CountRecord | undefined,
  action: string,
  vocabularySize: number,
  smoothing: number,
): number {
  return Math.log(
    ((counts?.[action] ?? 0) + smoothing) /
      (countTotal(counts) + smoothing * Math.max(1, vocabularySize)),
  );
}

function countTotal(counts: CountRecord | undefined): number {
  if (!counts) {
    return 0;
  }
  const cached = TOTAL_CACHE.get(counts);
  if (cached !== undefined) {
    return cached;
  }
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  TOTAL_CACHE.set(counts, total);
  return total;
}

function emptyMetrics(): Metrics {
  return {
    evaluatedDecisionCount: 0,
    top1Count: 0,
    top3Count: 0,
    reciprocalRankSum: 0,
  };
}

function updateMetrics(
  metrics: Metrics,
  ranking: readonly string[],
  actual: string,
): void {
  metrics.evaluatedDecisionCount += 1;
  const index = ranking.indexOf(actual);
  metrics.top1Count += index === 0 ? 1 : 0;
  metrics.top3Count += index >= 0 && index < 3 ? 1 : 0;
  metrics.reciprocalRankSum += index >= 0 ? 1 / (index + 1) : 0;
}

function finalizeMetrics(metrics: Metrics): {
  evaluatedDecisionCount: number;
  top1Count: number;
  top3Count: number;
  reciprocalRankSum: number;
  top1Rate: number;
  top3Rate: number;
  meanReciprocalRank: number;
} {
  return {
    ...metrics,
    top1Rate: divide(metrics.top1Count, metrics.evaluatedDecisionCount),
    top3Rate: divide(metrics.top3Count, metrics.evaluatedDecisionCount),
    meanReciprocalRank: divide(
      metrics.reciprocalRankSum,
      metrics.evaluatedDecisionCount,
    ),
  };
}

function hashCatalog(catalog: ContextualV3CandidateCatalog): string {
  const lines = [
    ...[...catalog.itemIds]
      .sort((left, right) => left - right)
      .map((itemId) => `ITEM:${itemId}`),
    ...[...catalog.componentsByParent]
      .sort(([left], [right]) => left - right)
      .flatMap(([parentItemId, componentItemIds]) =>
        [...componentItemIds]
          .sort((left, right) => left - right)
          .map(
            (componentItemId) => `RECIPE:${parentItemId}:${componentItemId}`,
          ),
      ),
  ];
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

function hashDescriptors(
  descriptors: readonly ContextualV3FinalTestDescriptor[],
): string {
  return createHash('sha256')
    .update(
      descriptors
        .map((descriptor) => `${descriptor.matchId}:${descriptor.startTime}`)
        .join('\n'),
    )
    .digest('hex');
}

function compareDescriptors(
  left: ContextualV3FinalTestDescriptor,
  right: ContextualV3FinalTestDescriptor,
): number {
  return (
    new Date(left.startTime).getTime() - new Date(right.startTime).getTime() ||
    left.matchId - right.matchId
  );
}

function compareSamples(
  left: HeroBuildOfflineLoadedHeroSample,
  right: HeroBuildOfflineLoadedHeroSample,
): number {
  return (
    left.descriptor.startTime.getTime() - right.descriptor.startTime.getTime() ||
    left.descriptor.matchId - right.descriptor.matchId ||
    left.player.id - right.player.id
  );
}

function normalizeHeroIds(heroIds: readonly number[]): number[] {
  return [
    ...new Set(
      heroIds.filter((heroId) => Number.isSafeInteger(heroId) && heroId > 0),
    ),
  ].sort((left, right) => left - right);
}

function groupBy<T, K>(
  values: readonly T[],
  keyOf: (value: T) => K,
): Map<K, T[]> {
  const result = new Map<K, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    const group = result.get(key) ?? [];
    group.push(value);
    result.set(key, group);
  }
  return result;
}

function normalizeOptions(
  request: ContextualV3FinalTestStartRequest,
): FinalTestOptions {
  return {
    batchSize: boundedInteger(
      request.batchSize,
      DEFAULT_BATCH_SIZE,
      MIN_BATCH_SIZE,
      MAX_BATCH_SIZE,
      'batchSize',
    ),
    matchCount: FINAL_TEST_MATCH_COUNT,
    candidateLimit: EXPECTED_CANDIDATE_LIMIT,
  };
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  fieldName: string,
): number {
  const resolved = value ?? fallback;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < minimum ||
    resolved > maximum
  ) {
    throw new Error(
      `${fieldName} must be a safe integer from ${minimum} to ${maximum}.`,
    );
  }
  return resolved;
}

function boundedNumber(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  return Number.isFinite(resolved) &&
    resolved >= minimum &&
    resolved <= maximum
    ? resolved
    : fallback;
}

class LineWriter {
  private buffer = '';

  private constructor(private readonly handle: FileHandle) {}

  static async create(path: string): Promise<LineWriter> {
    return new LineWriter(await open(path, 'w'));
  }

  async write(value: unknown): Promise<void> {
    this.buffer += `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(this.buffer) >= BUFFER_LIMIT) {
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

async function promote(path: string): Promise<void> {
  await rm(path, { force: true });
  await rename(`${path}.partial`, path);
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await writeFile(
    `${path}.partial`,
    `${JSON.stringify(value, undefined, 2)}\n`,
    'utf8',
  );
  await rm(path, { force: true });
  await rename(`${path}.partial`, path);
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if (getErrorCode(error) === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function requiredJson<T>(path: string): Promise<T> {
  const value = await readJson<T>(path);
  if (!value) {
    throw new Error(`Required artifact is missing: ${path}`);
  }
  return value;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function average(values: readonly number[]): number {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function divide(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
