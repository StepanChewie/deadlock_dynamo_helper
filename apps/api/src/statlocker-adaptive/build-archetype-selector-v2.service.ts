import { Injectable } from '@nestjs/common';
import { BuildArchetypeGroupV2, BuildArchetypeItemV2, BuildArchetypeSnapshotV2, BuildArchetypeV2 } from './build-archetype-v2';
import { BuildDecisionTraceSinkV2 } from './build-decision-trace-v2';
import { STATLOCKER_BUILD_V2_CONFIG } from './statlocker-build-v2.config';
import {
  StatlockerVsHeroWpaAggregateSourceV1,
  aggregateStatlockerVsHeroWpaRowsV1,
} from './statlocker-vs-hero-wpa-repository-v1.service';

export interface SelectBuildArchetypeV2Input {
  heroId: number;
  enemyHeroIds: readonly number[];
  snapshot: BuildArchetypeSnapshotV2;
  vsHeroRows: readonly StatlockerVsHeroWpaAggregateSourceV1[];
  wpaQueryCount?: number;
}

export interface BuildArchetypeSelectionScoreV2 {
  archetypeId: string;
  score: number;
  confidence: number;
  coverage: number;
}

export interface BuildArchetypeSelectionV2 {
  archetypeId: string;
  mode: 'VS_HERO_WPA' | 'OFFLINE_DEFAULT';
  scores: readonly BuildArchetypeSelectionScoreV2[];
  degradedReasons: readonly string[];
}

interface ItemMatchupV2 {
  score: number;
  confidence: number;
  coverage: number;
}

interface WeightedMatchupUnitV2 extends ItemMatchupV2 {
  weight: number;
}

@Injectable()
export class BuildArchetypeSelectorV2Service {
  select(
    input: SelectBuildArchetypeV2Input,
    trace?: BuildDecisionTraceSinkV2,
  ): BuildArchetypeSelectionV2 {
    validateInput(input);
    const enemyHeroIds = [...new Set(input.enemyHeroIds)].sort((a, b) => a - b);
    const enemySet = new Set(enemyHeroIds);
    const rows = aggregateStatlockerVsHeroWpaRowsV1(input.vsHeroRows).filter((row) =>
      row.heroId === input.heroId && enemySet.has(row.enemyHeroId),
    );
    const rowByKey = new Map(rows.map((row) => [`${row.enemyHeroId}:${row.itemId}`, row]));

    const matchupScores = input.snapshot.archetypes
      .map((archetype) => scoreArchetype(archetype, enemyHeroIds, rowByKey))
      .sort(compareScores);
    const hasUsableMatchupEvidence = matchupScores.some((entry) => entry.coverage > 0 && entry.confidence > 0);
    const result = hasUsableMatchupEvidence
      ? selectFromMatchupScores(matchupScores)
      : selectOfflineDefault(input.snapshot.archetypes);

    trace?.record({
      stage: 'ARCHETYPE_SELECTION',
      reasonCodes: [...result.degradedReasons],
      payload: {
        enemyHeroIds,
        wpaQueryCount: normalizeQueryCount(input.wpaQueryCount),
        candidates: result.scores.map((score) => ({
          candidateId: score.archetypeId,
          archetypeId: score.archetypeId,
          score: score.score,
          confidence: score.confidence,
          coverage: score.coverage,
          disposition: score.archetypeId === result.archetypeId ? 'SELECTED' : 'REJECTED',
          reasonCodes: score.archetypeId === result.archetypeId
            ? ['ARCHETYPE_SELECTED']
            : ['LOWER_ARCHETYPE_SELECTION_SCORE'],
        })),
        selectedArchetypeId: result.archetypeId,
        fallbackUsed: result.mode === 'OFFLINE_DEFAULT',
      },
    });

    return result;
  }
}

function selectFromMatchupScores(
  matchupScores: readonly BuildArchetypeSelectionScoreV2[],
): BuildArchetypeSelectionV2 {
  const winner = matchupScores[0];
  const degradedReasons = winner.coverage < 1 ? ['ARCHETYPE_SELECTION_WPA_PARTIAL'] : [];
  return {
    archetypeId: winner.archetypeId,
    mode: 'VS_HERO_WPA',
    scores: matchupScores,
    degradedReasons,
  };
}

function scoreArchetype(
  archetype: BuildArchetypeV2,
  enemyHeroIds: readonly number[],
  rowByKey: ReadonlyMap<string, ReturnType<typeof aggregateStatlockerVsHeroWpaRowsV1>[number]>,
): BuildArchetypeSelectionScoreV2 {
  const itemById = new Map(archetype.items.map((item) => [item.itemId, item]));
  const groupedItemIds = new Set(archetype.groups.flatMap((group) => group.candidateItemIds));
  const units: WeightedMatchupUnitV2[] = [];

  for (const item of archetype.items) {
    if (groupedItemIds.has(item.itemId)) continue;
    units.push({
      ...scoreItem(item.itemId, enemyHeroIds, rowByKey),
      weight: structuralWeight(item),
    });
  }

  for (const group of archetype.groups) {
    const unit = scoreGroup(group, itemById, enemyHeroIds, rowByKey);
    if (unit) units.push(unit);
  }

  const weightMass = units.reduce((sum, unit) => sum + unit.weight, 0);
  if (weightMass <= 0) {
    return { archetypeId: archetype.archetypeId, score: 0, confidence: 0, coverage: 0 };
  }
  return {
    archetypeId: archetype.archetypeId,
    score: units.reduce((sum, unit) => sum + unit.score * unit.weight, 0) / weightMass,
    confidence: units.reduce((sum, unit) => sum + unit.confidence * unit.weight, 0) / weightMass,
    coverage: units.reduce((sum, unit) => sum + unit.coverage * unit.weight, 0) / weightMass,
  };
}

function scoreGroup(
  group: BuildArchetypeGroupV2,
  itemById: ReadonlyMap<number, BuildArchetypeItemV2>,
  enemyHeroIds: readonly number[],
  rowByKey: ReadonlyMap<string, ReturnType<typeof aggregateStatlockerVsHeroWpaRowsV1>[number]>,
): WeightedMatchupUnitV2 | undefined {
  const candidates = group.candidateItemIds
    .map((itemId) => {
      const item = itemById.get(itemId);
      if (!item) return undefined;
      return {
        item,
        matchup: scoreItem(itemId, enemyHeroIds, rowByKey),
      };
    })
    .filter((entry): entry is { item: BuildArchetypeItemV2; matchup: ItemMatchupV2 } => entry !== undefined)
    .sort((left, right) =>
      right.matchup.score - left.matchup.score ||
      right.matchup.confidence - left.matchup.confidence ||
      left.item.itemId - right.item.itemId,
    );
  if (candidates.length === 0) return undefined;

  const requiredSelections = group.type === 'OPTIONAL'
    ? Math.min(1, candidates.length)
    : Math.max(1, Math.min(group.minSelect, candidates.length));
  const selected = candidates.slice(0, requiredSelections);
  const score = group.type === 'OPTIONAL' && selected[0].matchup.score < 0
    ? 0
    : average(selected.map((entry) => entry.matchup.score));
  const confidence = group.type === 'OPTIONAL' && selected[0].matchup.score < 0
    ? 0
    : average(selected.map((entry) => entry.matchup.confidence));
  const coverage = group.type === 'OPTIONAL' && selected[0].matchup.score < 0
    ? 0
    : average(selected.map((entry) => entry.matchup.coverage));
  const weight = Math.max(...selected.map((entry) => structuralWeight(entry.item))) * Math.max(group.confidence, 0.05);
  return { score, confidence, coverage, weight };
}

function scoreItem(
  itemId: number,
  enemyHeroIds: readonly number[],
  rowByKey: ReadonlyMap<string, ReturnType<typeof aggregateStatlockerVsHeroWpaRowsV1>[number]>,
): ItemMatchupV2 {
  if (enemyHeroIds.length === 0) return { score: 0, confidence: 0, coverage: 0 };
  let score = 0;
  let confidence = 0;
  let covered = 0;
  for (const enemyHeroId of enemyHeroIds) {
    const row = rowByKey.get(`${enemyHeroId}:${itemId}`);
    if (!row || row.count <= 0 || !Number.isFinite(row.deltaWpa)) continue;
    const sampleConfidence = row.count / (row.count + STATLOCKER_BUILD_V2_CONFIG.archetypeSelectionSamplePrior);
    score += row.deltaWpa * sampleConfidence;
    confidence += sampleConfidence;
    covered += 1;
  }
  return {
    score: score / enemyHeroIds.length,
    confidence: confidence / enemyHeroIds.length,
    coverage: covered / enemyHeroIds.length,
  };
}

function structuralWeight(item: BuildArchetypeItemV2): number {
  const roleWeight = STATLOCKER_BUILD_V2_CONFIG.archetypeSelectionRoleWeights[item.role];
  return roleWeight * Math.max(item.structuralPriority, 0.05);
}

function selectOfflineDefault(archetypes: readonly BuildArchetypeV2[]): BuildArchetypeSelectionV2 {
  const scores = archetypes
    .map((archetype) => ({
      archetypeId: archetype.archetypeId,
      score:
        archetype.quality.support * STATLOCKER_BUILD_V2_CONFIG.offlineArchetypeSupportWeight +
        archetype.quality.coherence * STATLOCKER_BUILD_V2_CONFIG.offlineArchetypeCoherenceWeight,
      confidence: archetype.quality.coherence,
      coverage: 0,
    }))
    .sort(compareScores);
  return {
    archetypeId: scores[0].archetypeId,
    mode: 'OFFLINE_DEFAULT',
    scores,
    degradedReasons: ['ARCHETYPE_SELECTION_WPA_UNAVAILABLE'],
  };
}

function compareScores(left: BuildArchetypeSelectionScoreV2, right: BuildArchetypeSelectionScoreV2): number {
  return right.score - left.score || right.confidence - left.confidence || left.archetypeId.localeCompare(right.archetypeId);
}

function validateInput(input: SelectBuildArchetypeV2Input): void {
  if (!Number.isInteger(input.heroId) || input.heroId <= 0) {
    throw new Error('Build archetype v2 selector: heroId must be a positive integer');
  }
  if (input.enemyHeroIds.length === 0 || input.enemyHeroIds.some((heroId) => !Number.isInteger(heroId) || heroId <= 0)) {
    throw new Error('Build archetype v2 selector: enemy hero roster is required');
  }
  if (input.snapshot.heroId !== input.heroId || input.snapshot.archetypes.length === 0) {
    throw new Error('Build archetype v2 selector: snapshot identity/archetypes are invalid');
  }
  if (input.snapshot.archetypes.some((archetype) => archetype.heroId !== input.heroId)) {
    throw new Error('Build archetype v2 selector: archetype hero identity mismatch');
  }
  if (input.wpaQueryCount !== undefined && (!Number.isInteger(input.wpaQueryCount) || input.wpaQueryCount < 0)) {
    throw new Error('Build archetype v2 selector: wpaQueryCount must be a non-negative integer');
  }
}

function normalizeQueryCount(value: number | undefined): number {
  return value ?? 0;
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}
