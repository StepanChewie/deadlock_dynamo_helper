import { createHash } from 'node:crypto';
import { AdaptiveFullBuildPlanV2, AdaptiveFullBuildStepV2 } from '@deadlock-live-probe/shared';
import { BuildDecisionTraceStageEntryV2 } from './build-decision-trace-v2';

export type BuildIterationKindV1 = 'PLAN' | 'NOT_READY';
export type BuildIterationRejectDispositionV1 = 'REJECTED' | 'SUPPRESSED_BY_HYSTERESIS';

export interface BuildIterationRejectEntryV1 {
  disposition: BuildIterationRejectDispositionV1;
  itemId?: number;
  archetypeId?: string;
  sellItemId?: number;
  buyItemId?: number;
  reasonCodes: readonly string[];
}

export interface BuildIterationRejectStageV1 {
  stage: string;
  entries: readonly BuildIterationRejectEntryV1[];
}

export interface BuildIterationRejectsV1 {
  stages: readonly BuildIterationRejectStageV1[];
  totalRejected: number;
}

export function planFingerprintV1(steps: readonly AdaptiveFullBuildStepV2[]): string {
  const canonical = steps
    .map((step) => [step.action, step.buyItemId, step.sellItemId ?? '', step.recipeId ?? ''].join('|'))
    .join(';');
  return sha256(canonical);
}

export function blockerFingerprintV1(blockers: readonly string[]): string {
  return sha256([...new Set(blockers)].sort().join('|'));
}

export function extractRejectsV1(
  stages: readonly BuildDecisionTraceStageEntryV2[],
): BuildIterationRejectsV1 {
  const collected: BuildIterationRejectStageV1[] = [];

  for (const entry of stages) {
    const entries = rejectsOfStage(entry);
    if (entries.length === 0) continue;
    collected.push({ stage: entry.stage, entries });
  }

  return {
    stages: collected,
    totalRejected: collected.reduce((total, stage) => total + stage.entries.length, 0),
  };
}

function rejectsOfStage(entry: BuildDecisionTraceStageEntryV2): BuildIterationRejectEntryV1[] {
  if (entry.stage === 'ARCHETYPE_SELECTION' || entry.stage === 'CANDIDATE_DISCOVERY') {
    return entry.payload.candidates
      .filter(isRejected)
      .map((candidate) => ({
        disposition: candidate.disposition as BuildIterationRejectDispositionV1,
        ...(candidate.itemId === undefined ? {} : { itemId: candidate.itemId }),
        ...(candidate.archetypeId === undefined ? {} : { archetypeId: candidate.archetypeId }),
        reasonCodes: [...candidate.reasonCodes],
      }));
  }
  if (entry.stage === 'CHOICE_RESOLUTION') {
    return entry.payload.groups.flatMap((group) =>
      group.candidates.filter(isRejected).map((candidate) => ({
        disposition: candidate.disposition as BuildIterationRejectDispositionV1,
        ...(candidate.itemId === undefined ? {} : { itemId: candidate.itemId }),
        reasonCodes: [...candidate.reasonCodes],
      })),
    );
  }
  if (entry.stage === 'PLAN_SEARCH') {
    return entry.payload.branches
      .filter(isRejected)
      .map((branch) => ({
        disposition: branch.disposition as BuildIterationRejectDispositionV1,
        itemId: branch.targetItemId,
        reasonCodes: [...branch.reasonCodes],
      }));
  }
  if (entry.stage === 'REPLACEMENT_SEARCH') {
    return entry.payload.candidates
      .filter(isRejected)
      .map((candidate) => ({
        disposition: candidate.disposition as BuildIterationRejectDispositionV1,
        sellItemId: candidate.sellItemId,
        buyItemId: candidate.buyItemId,
        reasonCodes: [...candidate.reasonCodes],
      }));
  }
  return [];
}

function isRejected(candidate: { disposition: string }): boolean {
  return candidate.disposition === 'REJECTED' || candidate.disposition === 'SUPPRESSED_BY_HYSTERESIS';
}

export function projectPlanForStorageV1(
  plan: AdaptiveFullBuildPlanV2,
  maxBytes: number,
): { payload: Record<string, unknown>; truncated: boolean } {
  const full = JSON.parse(JSON.stringify(plan)) as Record<string, unknown>;
  if (byteSize(full) <= maxBytes) return { payload: full, truncated: false };

  const compact = {
    ...full,
    steps: (plan.steps as AdaptiveFullBuildStepV2[]).map((step) => ({
      sequence: step.sequence,
      action: step.action,
      buyItemId: step.buyItemId,
      ...(step.sellItemId === undefined ? {} : { sellItemId: step.sellItemId }),
      ...(step.recipeId === undefined ? {} : { recipeId: step.recipeId }),
      reasonCodes: [...step.reasonCodes],
    })),
    ...(full.semanticValidation === undefined
      ? {}
      : { semanticValidation: { ...(full.semanticValidation as Record<string, unknown>), finalFamilyStates: [] } }),
  };
  return { payload: compact, truncated: true };
}

export function boundRejectsForStorageV1(
  rejects: BuildIterationRejectsV1,
  maxBytes: number,
): { payload: Record<string, unknown>; truncated: boolean } {
  let stages = rejects.stages.map((stage) => ({ stage: stage.stage, entries: [...stage.entries] }));
  const asPayload = () => ({ stages, totalRejected: rejects.totalRejected });

  if (byteSize(asPayload()) <= maxBytes) return { payload: asPayload() as unknown as Record<string, unknown>, truncated: false };

  while (stages.some((stage) => stage.entries.length > 0)) {
    stages = stages.map((stage) => ({ stage: stage.stage, entries: stage.entries.slice(0, Math.floor(stage.entries.length / 2)) }));
    if (byteSize(asPayload()) <= maxBytes) break;
  }
  return { payload: asPayload() as unknown as Record<string, unknown>, truncated: true };
}

function byteSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
