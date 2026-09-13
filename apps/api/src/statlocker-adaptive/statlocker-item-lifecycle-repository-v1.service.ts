import { Injectable } from '@nestjs/common';
import { StatlockerHeroItemLifecycleV1 } from './statlocker-adaptive.types';
import { StatlockerSnapshotStoreService } from './statlocker-snapshot-store.service';

export interface LoadStatlockerItemLifecycleForHeroV1Input {
  heroId: number;
  rulesetVersion: string;
  catalogSha256: string;
}

@Injectable()
export class StatlockerItemLifecycleRepositoryV1Service {
  constructor(
    private readonly store: StatlockerSnapshotStoreService,
  ) {}

  async loadCurrentPatchForHero(
    input: LoadStatlockerItemLifecycleForHeroV1Input,
  ): Promise<readonly StatlockerHeroItemLifecycleV1[]> {
    const statlockerPatchId = this.resolveCurrentPatchId(input.rulesetVersion, input.catalogSha256);
    if (!statlockerPatchId) return [];

    const snapshot = this.store.getActive({
      dataset: 'WPA_FILTERED_ITEMS',
      rulesetVersion: input.rulesetVersion,
      catalogSha256: input.catalogSha256,
      statlockerPatchId,
      scopeKey: `hero:${input.heroId}`,
    });
    if (!snapshot) return [];
    return parseLifecyclePayload(snapshot.payload, input.heroId);
  }

  private resolveCurrentPatchId(rulesetVersion: string, catalogSha256: string): string | undefined {
    const rows = this.store.listActive().filter((row) =>
      (row.dataset === 'WPA_PATCH_DATA' || row.dataset === 'T4_CHAINS') &&
      row.rulesetVersion === rulesetVersion &&
      row.catalogSha256.toLowerCase() === catalogSha256.toLowerCase(),
    );
    return rows
      .sort((a, b) => b.fetchedAt.getTime() - a.fetchedAt.getTime())[0]
      ?.statlockerPatchId;
  }
}

function parseLifecyclePayload(
  payload: unknown,
  heroId: number,
): readonly StatlockerHeroItemLifecycleV1[] {
  if (!payload || typeof payload !== 'object') return [];
  const root = payload as Record<string, unknown>;
  if (root.heroId !== heroId || !Array.isArray(root.items)) return [];
  const evidence: StatlockerHeroItemLifecycleV1[] = [];
  for (const row of root.items) {
    if (!row || typeof row !== 'object') continue;
    const item = row as Record<string, unknown>;
    const itemId = item.itemId;
    const generalWpa = item.generalWpa;
    const averagePurchaseTimeS = item.averagePurchaseTimeS;
    if (typeof itemId !== 'number' || !Number.isInteger(itemId) || itemId <= 0) continue;
    if (typeof generalWpa !== 'number' || !Number.isFinite(generalWpa)) continue;
    if (typeof averagePurchaseTimeS !== 'number' || !Number.isFinite(averagePurchaseTimeS) || averagePurchaseTimeS < 0) continue;
    const sampleSize = item.sampleSize;
    evidence.push({
      heroId,
      itemId,
      generalWpa,
      averagePurchaseTimeS,
      ...(typeof sampleSize === 'number' && Number.isFinite(sampleSize)
        ? { sampleSize }
        : {}),
    });
  }
  return evidence;
}
