import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BuildArchetypeMatchLockV2Entity } from '../deadlock-live/entities/build-archetype-match-lock-v2.entity';
import { BuildArchetypeSelectionV2 } from './build-archetype-selector-v2.service';

export interface LockBuildArchetypeV2Input {
  heroId: number;
  snapshotId: string;
  enemyHeroIds: readonly number[];
  selection: BuildArchetypeSelectionV2;
  lockedGameTimeS?: number;
}

@Injectable()
export class BuildArchetypeSessionV2Service {
  constructor(
    @InjectRepository(BuildArchetypeMatchLockV2Entity)
    private readonly repository: Repository<BuildArchetypeMatchLockV2Entity>,
  ) {}

  async getOrLock(
    matchId: string,
    input: LockBuildArchetypeV2Input,
    lockedAt: Date = new Date(),
  ): Promise<BuildArchetypeMatchLockV2Entity> {
    validateLockInput(matchId, input, lockedAt);

    const existing = await this.repository.findOne({ where: { matchId } });
    if (existing) return existing;

    const enemyHeroIds = [...new Set(input.enemyHeroIds)].sort((a, b) => a - b);
    const row = this.repository.create({
      matchId,
      heroId: input.heroId,
      snapshotId: input.snapshotId,
      archetypeId: input.selection.archetypeId,
      enemyHeroIds,
      selection: clone(input.selection) as unknown as Record<string, unknown>,
      degradedReasons: [...input.selection.degradedReasons],
      lockedAt,
      ...(input.lockedGameTimeS === undefined ? {} : { lockedGameTimeS: input.lockedGameTimeS }),
    });

    try {
      return await this.repository.save(row);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const winner = await this.repository.findOne({ where: { matchId } });
      if (!winner) throw error;
      return winner;
    }
  }
}

function validateLockInput(matchId: string, input: LockBuildArchetypeV2Input, lockedAt: Date): void {
  if (matchId.trim() === '' || matchId.length > 128) {
    throw new Error('Build archetype v2 session: matchId is invalid');
  }
  if (!Number.isInteger(input.heroId) || input.heroId <= 0) {
    throw new Error('Build archetype v2 session: heroId must be a positive integer');
  }
  if (input.snapshotId.trim() === '' || input.snapshotId.length > 128) {
    throw new Error('Build archetype v2 session: snapshotId is invalid');
  }
  if (input.selection.archetypeId.trim() === '' || input.selection.archetypeId.length > 192) {
    throw new Error('Build archetype v2 session: archetypeId is invalid');
  }
  if (
    input.enemyHeroIds.length === 0 ||
    input.enemyHeroIds.some((heroId) => !Number.isInteger(heroId) || heroId <= 0)
  ) {
    throw new Error('Build archetype v2 session: enemy hero roster is required');
  }
  if (!input.selection.scores.some((score) => score.archetypeId === input.selection.archetypeId)) {
    throw new Error('Build archetype v2 session: selected archetype is missing from selection scores');
  }
  if (!(lockedAt instanceof Date) || !Number.isFinite(lockedAt.getTime())) {
    throw new Error('Build archetype v2 session: lockedAt is invalid');
  }
  if (
    input.lockedGameTimeS !== undefined &&
    (!Number.isFinite(input.lockedGameTimeS) || input.lockedGameTimeS < 0)
  ) {
    throw new Error('Build archetype v2 session: lockedGameTimeS is invalid');
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error as { code?: unknown }).code === '23505';
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
