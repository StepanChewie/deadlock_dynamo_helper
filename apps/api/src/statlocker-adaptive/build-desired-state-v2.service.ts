import { Injectable } from '@nestjs/common';
import {
  BuildArchetypeFamilyV2,
  BuildArchetypeGroupV2,
  BuildArchetypeV2,
  BuildFamilyRequirementV2,
} from './build-archetype-v2';
import { STATLOCKER_BUILD_V2_CONFIG } from './statlocker-build-v2.config';
import { StatlockerVsHeroWpaAggregateSourceV1 } from './statlocker-vs-hero-wpa-repository-v1.service';
import {
  EnemyThreatWeightV1,
  ThreatWeightedMatchupScoreV1,
  ThreatWeightedMatchupV1Service,
} from './threat-weighted-matchup-v1.service';

export interface DesiredFamilySourceProfileV2 {
  accountId: string;
  playerName?: string;
}

export type DesiredFamilyGoalKindV2 =
  | 'REQUIRED'
  | 'CHOICE_SELECTED'
  | 'OPTIONAL'
  | 'SITUATIONAL_MATCHUP_SELECTED'
  | 'FLEX_PROVISIONAL';

export interface DesiredFamilyStateV2 {
  familyId: number;
  requirement: BuildFamilyRequirementV2 | 'CHOICE';
  goalKind: DesiredFamilyGoalKindV2;
  selectedTerminalItemId: number;
  selectedTerminalKind: 'DEFAULT_TERMINAL' | 'OPTIONAL_TERMINAL';
  groupId?: string;
  score: number;
  confidence: number;
  reasonCodes: readonly string[];
  sourceProfiles?: readonly DesiredFamilySourceProfileV2[];
}

export interface DesiredBuildStateV2 {
  families: readonly DesiredFamilyStateV2[];
  selectedChoiceFamilyIdsByGroup: Readonly<Record<string, readonly number[]>>;
  reasonCodes: readonly string[];
}

export interface ResolveDesiredBuildStateV2Input {
  heroId: number;
  archetype: BuildArchetypeV2;
  enemyHeroIds: readonly number[];
  enemyThreats: readonly EnemyThreatWeightV1[];
  vsHeroRows: readonly StatlockerVsHeroWpaAggregateSourceV1[];
  /**
   * Minimum number of visible goals the full build should present. When the
   * evidence-backed primary goals fall short, unselected SITUATIONAL families
   * (real captured evidence, no matchup advantage on this roster) are appended
   * as FLEX_PROVISIONAL goals in archetype purchase-time order. Never a cap:
   * primary goals are never truncated.
   */
  flexGoalCapacity?: number;
}

interface FamilyEvaluationV2 {
  state: DesiredFamilyStateV2;
  familyOrder: number;
}

@Injectable()
export class BuildDesiredStateV2Service {
  constructor(private readonly matchup: ThreatWeightedMatchupV1Service) {}

  resolve(input: ResolveDesiredBuildStateV2Input): DesiredBuildStateV2 {
    validateInput(input);
    const families = input.archetype.families ?? [];
    if (families.length === 0) {
      throw new Error('Build desired state v2: family-first archetype is required');
    }

    const familyById = new Map(families.map((family, index) => [family.familyId, { family, index }]));
    const itemToFamily = new Map(
      families.flatMap((family) => family.progressionNodes.map((node) => [node.itemId, family.familyId] as const)),
    );
    const choiceGroups = input.archetype.groups.filter((group) => group.type === 'CHOICE');
    const choiceFamilyIds = new Set(choiceGroups.flatMap((group) => resolveGroupFamilyIds(group, itemToFamily)));
    const selected: FamilyEvaluationV2[] = [];
    const selectedChoiceFamilyIdsByGroup: Record<string, readonly number[]> = {};

    for (const { family, index } of familyById.values()) {
      if (family.requirement !== 'REQUIRED' || choiceFamilyIds.has(family.familyId)) continue;
      selected.push({
        state: this.evaluateFamily(input, family, family.requirement, 'REQUIRED'),
        familyOrder: index,
      });
    }

    for (const group of choiceGroups) {
      const candidateFamilyIds = resolveGroupFamilyIds(group, itemToFamily);
      const candidates = candidateFamilyIds
        .map((familyId) => familyById.get(familyId))
        .filter((entry): entry is { family: BuildArchetypeFamilyV2; index: number } => entry !== undefined)
        .map(({ family, index }) => ({
          state: this.evaluateFamily(input, family, 'CHOICE', 'CHOICE_SELECTED', group.groupId),
          familyOrder: index,
        }))
        .sort(compareFamilyEvaluation);
      const count = Math.min(Math.max(0, group.minSelect), candidates.length);
      if (count < group.minSelect) {
        throw new Error(`Build desired state v2: CHOICE ${group.groupId} cannot satisfy minSelect`);
      }
      const chosen = candidates.slice(0, count);
      selected.push(...chosen);
      selectedChoiceFamilyIdsByGroup[group.groupId] = chosen
        .map((entry) => entry.state.familyId)
        .sort((a, b) => a - b);
    }

    const alreadySelected = new Set(selected.map((entry) => entry.state.familyId));
    for (const [index, family] of families.entries()) {
      if (alreadySelected.has(family.familyId) || choiceFamilyIds.has(family.familyId)) continue;

      if (family.requirement === 'OPTIONAL') {
        selected.push({
          state: this.evaluateFamily(input, family, 'OPTIONAL', 'OPTIONAL'),
          familyOrder: index,
        });
        continue;
      }

      if (family.requirement !== 'SITUATIONAL') continue;
      const evaluation = this.evaluateFamily(
        input,
        family,
        'SITUATIONAL',
        'SITUATIONAL_MATCHUP_SELECTED',
      );
      const config = STATLOCKER_BUILD_V2_CONFIG.outsideMatchupDiscovery;
      if (
        evaluation.confidence < config.minConfidence ||
        evaluation.score < config.minNormalizedSupport
      ) {
        continue;
      }
      selected.push({ state: evaluation, familyOrder: index });
    }

    const flexStates: DesiredFamilyStateV2[] = [];
    const flexGoalCapacity = input.flexGoalCapacity;
    if (flexGoalCapacity !== undefined && selected.length < flexGoalCapacity) {
      const primaryFamilyIds = new Set(selected.map((entry) => entry.state.familyId));
      const flexPool = families
        .map((family, index) => ({ family, index }))
        .filter(({ family }) =>
          !primaryFamilyIds.has(family.familyId) &&
          !choiceFamilyIds.has(family.familyId) &&
          family.requirement === 'SITUATIONAL',
        )
        .sort((left, right) =>
          firstFamilyTiming(left.family) - firstFamilyTiming(right.family) ||
          left.family.familyId - right.family.familyId,
        );
      for (const { family, index } of flexPool) {
        if (selected.length + flexStates.length >= flexGoalCapacity) break;
        const evaluation = this.evaluateFamily(input, family, 'SITUATIONAL', 'FLEX_PROVISIONAL');
        flexStates.push({
          ...evaluation,
          selectedTerminalItemId: evaluation.selectedTerminalKind === 'DEFAULT_TERMINAL'
            ? evaluation.selectedTerminalItemId
            : family.terminalCandidates.find((candidate) => candidate.kind === 'DEFAULT_TERMINAL')!.itemId,
          selectedTerminalKind: 'DEFAULT_TERMINAL',
          reasonCodes: ['FLEX_PROVISIONAL_FILL'],
        });
      }
    }

    return {
      families: [
        ...selected
          .sort((left, right) => left.familyOrder - right.familyOrder || left.state.familyId - right.state.familyId)
          .map((entry) => entry.state),
        ...flexStates,
      ],
      selectedChoiceFamilyIdsByGroup,
      reasonCodes: [],
    };
  }

  private evaluateFamily(
    input: ResolveDesiredBuildStateV2Input,
    family: BuildArchetypeFamilyV2,
    requirement: BuildFamilyRequirementV2 | 'CHOICE',
    goalKind: DesiredFamilyGoalKindV2,
    groupId?: string,
  ): DesiredFamilyStateV2 {
    const defaultTerminal = family.terminalCandidates.find((candidate) => candidate.kind === 'DEFAULT_TERMINAL');
    if (!defaultTerminal) {
      throw new Error(`Build desired state v2: family ${family.familyId} has no default terminal`);
    }

    const sourceProfiles = resolveFamilySourceProfiles(input.archetype, family);
    const defaultScore = this.scoreTerminal(input, defaultTerminal.itemId);
    const optionalCandidates = family.terminalCandidates
      .filter((candidate) => candidate.kind === 'OPTIONAL_TERMINAL')
      .map((candidate) => ({
        candidate,
        matchup: this.scoreTerminal(input, candidate.itemId),
      }))
      .map((entry) => ({
        ...entry,
        improvement: entry.matchup.normalized - defaultScore.normalized,
      }))
      .sort((left, right) =>
        right.improvement - left.improvement ||
        right.matchup.confidence - left.matchup.confidence ||
        left.candidate.itemId - right.candidate.itemId,
      );

    const promoted = optionalCandidates.find((entry) =>
      entry.improvement >= STATLOCKER_BUILD_V2_CONFIG.optionalTerminal.minImprovement &&
      entry.matchup.confidence >= STATLOCKER_BUILD_V2_CONFIG.optionalTerminal.minConfidence,
    );

    if (promoted) {
      return {
        familyId: family.familyId,
        requirement,
        goalKind,
        selectedTerminalItemId: promoted.candidate.itemId,
        selectedTerminalKind: 'OPTIONAL_TERMINAL',
        ...(groupId === undefined ? {} : { groupId }),
        score: promoted.matchup.normalized,
        confidence: promoted.matchup.confidence,
        reasonCodes: ['OPTIONAL_TERMINAL_WPA_SELECTED'],
        ...(sourceProfiles.length === 0 ? {} : { sourceProfiles }),
      };
    }

    const reasonCodes = optionalCandidates.length > 0
      ? ['DEFAULT_TERMINAL_SELECTED', 'OPTIONAL_TERMINAL_WPA_REJECTED']
      : ['DEFAULT_TERMINAL_SELECTED'];
    return {
      familyId: family.familyId,
      requirement,
      goalKind,
      selectedTerminalItemId: defaultTerminal.itemId,
      selectedTerminalKind: 'DEFAULT_TERMINAL',
      ...(groupId === undefined ? {} : { groupId }),
      score: defaultScore.normalized,
      confidence: defaultScore.confidence,
      reasonCodes,
      ...(sourceProfiles.length === 0 ? {} : { sourceProfiles }),
    };
  }

  private scoreTerminal(
    input: ResolveDesiredBuildStateV2Input,
    itemId: number,
  ): ThreatWeightedMatchupScoreV1 {
    return this.matchup.scoreItem({
      ourHeroId: input.heroId,
      itemId,
      enemyHeroIds: input.enemyHeroIds,
      rows: input.vsHeroRows,
      enemyThreats: input.enemyThreats,
    });
  }
}

function resolveFamilySourceProfiles(
  archetype: BuildArchetypeV2,
  family: BuildArchetypeFamilyV2,
): DesiredFamilySourceProfileV2[] {
  const accountIds = [...(family.sourceProfileAccountIds ?? [])].sort();
  if (accountIds.length === 0) return [];
  const byAccountId = new Map((archetype.sourceProfiles ?? []).map((profile) => [profile.accountId, profile]));
  return accountIds.map((accountId) => {
    const profile = byAccountId.get(accountId);
    return {
      accountId,
      ...(profile?.playerName ? { playerName: profile.playerName } : {}),
    };
  });
}

function resolveGroupFamilyIds(
  group: BuildArchetypeGroupV2,
  itemToFamily: ReadonlyMap<number, number>,
): number[] {
  if (group.candidateFamilyIds && group.candidateFamilyIds.length > 0) {
    return [...new Set(group.candidateFamilyIds)].sort((a, b) => a - b);
  }
  return [...new Set(
    group.candidateItemIds
      .map((itemId) => itemToFamily.get(itemId))
      .filter((familyId): familyId is number => familyId !== undefined),
  )].sort((a, b) => a - b);
}

function compareFamilyEvaluation(left: FamilyEvaluationV2, right: FamilyEvaluationV2): number {
  const leftHasEvidence = left.state.confidence > 0;
  const rightHasEvidence = right.state.confidence > 0;
  if (leftHasEvidence !== rightHasEvidence) return leftHasEvidence ? -1 : 1;
  return right.state.score - left.state.score ||
    right.state.confidence - left.state.confidence ||
    left.state.familyId - right.state.familyId;
}

function firstFamilyTiming(family: BuildArchetypeFamilyV2): number {
  return family.progressionNodes[0]?.timing.medianBuyTimeS ?? 0;
}

function validateInput(input: ResolveDesiredBuildStateV2Input): void {
  if (!Number.isInteger(input.heroId) || input.heroId <= 0 || input.archetype.heroId !== input.heroId) {
    throw new Error('Build desired state v2: hero identity is invalid');
  }
  if (input.enemyHeroIds.some((heroId) => !Number.isInteger(heroId) || heroId <= 0)) {
    throw new Error('Build desired state v2: enemyHeroIds are invalid');
  }
}
