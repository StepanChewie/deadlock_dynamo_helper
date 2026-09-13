import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  createInitialSkillBuildState,
  createSkillBuildStateKey,
  findBestSkillBuildPath,
  getSkillBuildSpentPoints,
  SkillBuildDiagnostic,
  SkillBuildGraph,
  SkillBuildGraphAccumulator,
  SkillBuildPathStep,
  SkillBuildState,
  SkillLevel,
  SkillSlot,
  SkillUpgradeObservation,
} from '@deadlock-live-probe/build-domain';
import { In, Repository } from 'typeorm';
import { MatchPlayerSkillUpgrade } from './entities/match-player-skill-upgrade.entity';
import { MatchPlayer } from './entities/match-player.entity';
import { HERO_ABILITY_MAP } from './hero-abilities';
import {
  chunkValues,
  getRecentMatchCutoff,
  RECENT_MATCH_QUERY_BATCH_SIZE,
  RECENT_MATCH_TARGET_COUNT,
  RECENT_MATCH_WINDOW_DAYS,
} from './recent-matches-window.service';

export const SKILL_BUILD_MAX_POINT_BUDGET = 36;

const HERO_SKILL_GRAPH_TTL_MS = 5 * 60_000;
const HERO_SKILL_GRAPH_YIELD_INTERVAL = 100;

export type HeroSkillLevels = Readonly<Record<SkillSlot, SkillLevel>>;

export interface HeroSkillBuildOptions {
  maxPointBudget?: number;
  currentLevels?: HeroSkillLevels;
}

export interface HeroSkillBuildDiagnosticSummary {
  code: SkillBuildDiagnostic['code'];
  count: number;
}

export interface HeroSkillBuildResponse {
  heroId: number;
  windowDays: number;
  sourcePlayerCount: number;
  validPlayerCount: number;
  partialPlayerCount: number;
  rejectedPlayerCount: number;
  diagnostics: HeroSkillBuildDiagnosticSummary[];
  abilityIdsBySlot: Readonly<Record<SkillSlot, number>>;
  currentLevels: HeroSkillLevels;
  currentPointCost: number;
  totalPointCost: number;
  nextAction?: SkillBuildPathStep;
  actions: SkillBuildPathStep[];
}

interface CachedHeroSkillGraph {
  graph: SkillBuildGraph;
  abilityIdsBySlot: Readonly<Record<SkillSlot, number>>;
  sourcePlayerCount: number;
  validPlayerCount: number;
  partialPlayerCount: number;
  rejectedPlayerCount: number;
  diagnostics: HeroSkillBuildDiagnosticSummary[];
  builtAt: Date;
}

@Injectable()
export class SkillBuildAnalysisService {
  private readonly logger = new Logger(SkillBuildAnalysisService.name);
  private readonly cacheByHeroId = new Map<number, CachedHeroSkillGraph>();
  private readonly refreshPromisesByHeroId = new Map<
    number,
    Promise<CachedHeroSkillGraph>
  >();

  constructor(
    @InjectRepository(MatchPlayer)
    private readonly matchPlayerRepository: Repository<MatchPlayer>,
    @InjectRepository(MatchPlayerSkillUpgrade)
    private readonly skillUpgradeRepository: Repository<MatchPlayerSkillUpgrade>,
  ) {}

  async getHeroSkillBuild(
    heroId: number,
    options: HeroSkillBuildOptions = {},
  ): Promise<HeroSkillBuildResponse> {
    const abilitySlotById = HERO_ABILITY_MAP[heroId] as
      | Readonly<Record<number, SkillSlot>>
      | undefined;
    if (!abilitySlotById) {
      throw new NotFoundException(`No ability mapping exists for hero ${heroId}.`);
    }

    const cached = await this.ensureHeroGraph(heroId, abilitySlotById);
    const currentState = createCurrentState(options.currentLevels);
    const currentPointCost = getSkillBuildSpentPoints(currentState);
    const maxPointBudget = options.maxPointBudget ?? SKILL_BUILD_MAX_POINT_BUDGET;
    const remainingPointBudget = Math.max(0, maxPointBudget - currentPointCost);
    const actions = findBestSkillBuildPath(cached.graph, {
      startStateKey: createSkillBuildStateKey(currentState),
      maxPointBudget: remainingPointBudget,
      initialPointCost: currentPointCost,
    });

    if (
      actions.length === 0 &&
      remainingPointBudget > 0 &&
      !isCompleteSkillState(currentState)
    ) {
      throw new NotFoundException(
        `No valid skill upgrade path exists for hero ${heroId} from state ` +
          `${createSkillBuildStateKey(currentState)}.`,
      );
    }

    return {
      heroId,
      windowDays: RECENT_MATCH_WINDOW_DAYS,
      sourcePlayerCount: cached.sourcePlayerCount,
      validPlayerCount: cached.validPlayerCount,
      partialPlayerCount: cached.partialPlayerCount,
      rejectedPlayerCount: cached.rejectedPlayerCount,
      diagnostics: cached.diagnostics.map((diagnostic) => ({ ...diagnostic })),
      abilityIdsBySlot: { ...cached.abilityIdsBySlot },
      currentLevels: { ...currentState.levels },
      currentPointCost,
      totalPointCost:
        actions[actions.length - 1]?.cumulativePointCost ?? currentPointCost,
      nextAction: actions[0] ? { ...actions[0] } : undefined,
      actions,
    };
  }

  private async ensureHeroGraph(
    heroId: number,
    abilitySlotById: Readonly<Record<number, SkillSlot>>,
  ): Promise<CachedHeroSkillGraph> {
    const cached = this.cacheByHeroId.get(heroId);
    const isFresh =
      cached !== undefined &&
      Date.now() - cached.builtAt.getTime() < HERO_SKILL_GRAPH_TTL_MS;
    if (isFresh) {
      return cached;
    }

    const refreshPromise = this.startRefresh(heroId, abilitySlotById);
    if (cached) {
      void refreshPromise.catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Failed to refresh cached skill graph for hero ${heroId}: ${message}`,
        );
      });
      return cached;
    }

    return refreshPromise;
  }

  private startRefresh(
    heroId: number,
    abilitySlotById: Readonly<Record<number, SkillSlot>>,
  ): Promise<CachedHeroSkillGraph> {
    const existing = this.refreshPromisesByHeroId.get(heroId);
    if (existing) {
      return existing;
    }

    const refreshPromise = this.buildHeroGraph(heroId, abilitySlotById).finally(
      () => {
        this.refreshPromisesByHeroId.delete(heroId);
      },
    );
    this.refreshPromisesByHeroId.set(heroId, refreshPromise);
    return refreshPromise;
  }

  private async buildHeroGraph(
    heroId: number,
    abilitySlotById: Readonly<Record<number, SkillSlot>>,
  ): Promise<CachedHeroSkillGraph> {
    const startedAt = Date.now();
    const players = await this.matchPlayerRepository
      .createQueryBuilder('player')
      .innerJoinAndSelect('player.match', 'match')
      .where('player.heroId = :heroId', { heroId })
      .andWhere('match.startTime >= :cutoff', {
        cutoff: getRecentMatchCutoff(new Date()),
      })
      .orderBy('match.startTime', 'DESC')
      .addOrderBy('match.matchId', 'DESC')
      .take(RECENT_MATCH_TARGET_COUNT)
      .getMany();

    if (players.length === 0) {
      throw new NotFoundException(
        `No recent match data exists for hero ${heroId} in the last ` +
          `${RECENT_MATCH_WINDOW_DAYS} days.`,
      );
    }

    const skillUpgradesByPlayerId = await this.loadSkillUpgrades(players);
    const abilityIdsBySlot = createAbilityIdByStoredSlot(abilitySlotById);
    const accumulator = new SkillBuildGraphAccumulator();
    const diagnosticCounts = new Map<SkillBuildDiagnostic['code'], number>();
    let validPlayerCount = 0;
    let partialPlayerCount = 0;
    let rejectedPlayerCount = 0;

    for (let index = 0; index < players.length; index += 1) {
      const player = players[index];
      const skillUpgrades = skillUpgradesByPlayerId.get(Number(player.id)) ?? [];
      if (skillUpgrades.length === 0) {
        rejectedPlayerCount += 1;
        continue;
      }

      const replay = accumulator.addPath(
        [...skillUpgrades]
          .sort((left, right) => left.upgradeOrder - right.upgradeOrder)
          .map((upgrade) =>
            normalizePersistedSkillUpgrade(upgrade, abilityIdsBySlot),
          ),
        abilitySlotById,
      );

      for (const diagnostic of replay.diagnostics) {
        diagnosticCounts.set(
          diagnostic.code,
          (diagnosticCounts.get(diagnostic.code) ?? 0) + 1,
        );
      }

      if (replay.valid) {
        validPlayerCount += 1;
      } else if (replay.actions.length > 0) {
        partialPlayerCount += 1;
      } else {
        rejectedPlayerCount += 1;
      }

      if ((index + 1) % HERO_SKILL_GRAPH_YIELD_INTERVAL === 0) {
        await yieldToEventLoop();
      }
    }

    const graph = accumulator.build();
    if (graph.statesByKey.get(graph.rootStateKey)?.outgoingTransitions.length === 0) {
      throw new NotFoundException(
        `No valid skill upgrade path exists for hero ${heroId} in the last ` +
          `${RECENT_MATCH_WINDOW_DAYS} days.`,
      );
    }

    const cached: CachedHeroSkillGraph = {
      graph,
      abilityIdsBySlot,
      sourcePlayerCount: players.length,
      validPlayerCount,
      partialPlayerCount,
      rejectedPlayerCount,
      diagnostics: [...diagnosticCounts.entries()]
        .map(([code, count]) => ({ code, count }))
        .sort(
          (left, right) =>
            right.count - left.count || left.code.localeCompare(right.code),
        ),
      builtAt: new Date(),
    };
    this.cacheByHeroId.set(heroId, cached);
    this.logger.log(
      `Built skill graph for hero ${heroId} from ${players.length} players in ` +
        `${Date.now() - startedAt} ms.`,
    );
    return cached;
  }

  private async loadSkillUpgrades(
    players: MatchPlayer[],
  ): Promise<Map<number, MatchPlayerSkillUpgrade[]>> {
    const result = new Map<number, MatchPlayerSkillUpgrade[]>();
    const playerIds = players.map((player) => Number(player.id));

    for (const batch of chunkValues(playerIds, RECENT_MATCH_QUERY_BATCH_SIZE)) {
      const skillUpgrades = await this.skillUpgradeRepository.find({
        where: { matchPlayerId: In(batch) },
      });
      for (const upgrade of skillUpgrades) {
        const playerId = Number(upgrade.matchPlayerId);
        const playerUpgrades = result.get(playerId) ?? [];
        playerUpgrades.push(upgrade);
        result.set(playerId, playerUpgrades);
      }
    }

    return result;
  }
}

function createAbilityIdByStoredSlot(
  abilitySlotById: Readonly<Record<number, SkillSlot>>,
): Readonly<Record<SkillSlot, number>> {
  return Object.fromEntries(
    Object.entries(abilitySlotById).map(([abilityId, skillSlot]) => [
      skillSlot,
      Number(abilityId),
    ]),
  ) as Readonly<Record<SkillSlot, number>>;
}

function createCurrentState(currentLevels?: HeroSkillLevels): SkillBuildState {
  if (!currentLevels) {
    return createInitialSkillBuildState();
  }

  return {
    levels: {
      1: currentLevels[1],
      2: currentLevels[2],
      3: currentLevels[3],
      4: currentLevels[4],
    },
  };
}

function isCompleteSkillState(state: SkillBuildState): boolean {
  return (
    state.levels[1] === 4 &&
    state.levels[2] === 4 &&
    state.levels[3] === 4 &&
    state.levels[4] === 4
  );
}

function normalizePersistedSkillUpgrade(
  upgrade: MatchPlayerSkillUpgrade,
  abilityIdByStoredSlot: Readonly<Record<SkillSlot, number>>,
): SkillUpgradeObservation {
  return {
    abilityId:
      abilityIdByStoredSlot[Number(upgrade.abilityId) as SkillSlot] ??
      Number(upgrade.abilityId),
    upgradeOrder: Number(upgrade.upgradeOrder),
    upgradeTimeS:
      upgrade.upgradeTimeS === undefined || upgrade.upgradeTimeS === null
        ? undefined
        : Number(upgrade.upgradeTimeS),
  };
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
