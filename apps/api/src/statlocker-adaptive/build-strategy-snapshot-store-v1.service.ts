import { createHash } from 'crypto';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  RecommendationItemDefinition,
  RecommendationItemGraph,
  RecommendationItemLineageEdge,
  createRecommendationItemGraph,
} from '@deadlock-live-probe/build-domain';
import { BuildStrategySnapshotV1Entity } from '../deadlock-live/entities/build-strategy-snapshot-v1.entity';
import { BuildStrategyRegistryV1Service } from './build-strategy-registry-v1.service';
import { BuildStrategySpecV1 } from './build-strategy-v1';

interface PersistedBuildStrategySnapshotPayloadV1 {
  schemaVersion: 1;
  specs: readonly BuildStrategySpecV1[];
  itemDefinitions: readonly RecommendationItemDefinition[];
  lineageEdges: readonly RecommendationItemLineageEdge[];
}

export interface PublishBuildStrategySnapshotV1Input {
  snapshotId: string;
  rulesetId: string;
  patchId: string;
  catalogSha256: string;
  sourceSha256: string;
  specs: readonly BuildStrategySpecV1[];
  itemGraph: RecommendationItemGraph;
  publishedAt?: Date;
}

@Injectable()
export class BuildStrategySnapshotStoreV1Service implements OnModuleInit {
  constructor(
    @InjectRepository(BuildStrategySnapshotV1Entity)
    private readonly repository: Repository<BuildStrategySnapshotV1Entity>,
    private readonly registry: BuildStrategyRegistryV1Service,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.hydrateActive();
  }

  async publish(input: PublishBuildStrategySnapshotV1Input): Promise<void> {
    const heroId = validatePublishIdentity(input);
    const payload = buildPayload(input.specs, input.itemGraph);
    const contentSha256 = contentHash(payload);

    const validationRegistry = new BuildStrategyRegistryV1Service();
    validationRegistry.replaceSnapshot({
      rulesetId: input.rulesetId,
      patchId: input.patchId,
      catalogSha256: input.catalogSha256,
      sourceSha256: input.sourceSha256,
      specs: payload.specs,
      itemGraph: createRecommendationItemGraph(payload.itemDefinitions, payload.lineageEdges),
    });

    const existing = await this.repository.find({
      where: {
        heroId,
        rulesetId: input.rulesetId,
        patchId: input.patchId,
        catalogSha256: input.catalogSha256.toLowerCase(),
        active: true,
      },
    });
    const row = this.repository.create({
      snapshotId: input.snapshotId,
      heroId,
      rulesetId: input.rulesetId,
      patchId: input.patchId,
      catalogSha256: input.catalogSha256.toLowerCase(),
      sourceSha256: input.sourceSha256.toLowerCase(),
      contentSha256,
      schemaVersion: 'build-strategy-v1',
      active: true,
      payload: clone(payload) as unknown as Record<string, unknown>,
      publishedAt: input.publishedAt ?? new Date(),
    });

    // Persist the new immutable artifact first. If old-row deactivation fails, startup hydration
    // deterministically selects the newest artifact for this exact hero/patch/catalog scope.
    await this.repository.save(row);
    for (const previous of existing) {
      if (previous.snapshotId === input.snapshotId || !previous.active) continue;
      previous.active = false;
      await this.repository.save(previous);
    }

    this.registry.replaceSnapshot({
      rulesetId: input.rulesetId,
      patchId: input.patchId,
      catalogSha256: input.catalogSha256,
      sourceSha256: input.sourceSha256,
      specs: payload.specs,
      itemGraph: createRecommendationItemGraph(payload.itemDefinitions, payload.lineageEdges),
    });
  }

  async hydrateActive(): Promise<number> {
    const rows = await this.repository.find({ where: { active: true } });
    const ordered = [...rows].sort((a, b) =>
      a.publishedAt.getTime() - b.publishedAt.getTime() || a.snapshotId.localeCompare(b.snapshotId),
    );
    let loaded = 0;
    for (const row of ordered) {
      const payload = parsePayload(row.payload);
      const actualHash = contentHash(payload);
      if (actualHash !== row.contentSha256.toLowerCase()) {
        throw new Error(`Build strategy snapshot content hash mismatch: ${row.snapshotId}`);
      }
      if (payload.specs.some((spec) => spec.heroId !== row.heroId)) {
        throw new Error(`Build strategy snapshot hero scope mismatch: ${row.snapshotId}`);
      }
      const validSpecs = payload.specs.filter((spec) => Array.isArray(spec.goals) && spec.goals.length > 0);
      if (validSpecs.length === 0) continue;
      const itemGraph = createRecommendationItemGraph(payload.itemDefinitions, payload.lineageEdges);
      this.registry.replaceSnapshot({
        rulesetId: row.rulesetId,
        patchId: row.patchId,
        catalogSha256: row.catalogSha256,
        sourceSha256: row.sourceSha256,
        specs: validSpecs,
        itemGraph,
      });
      loaded += 1;
    }
    return loaded;
  }
}

function buildPayload(
  specs: readonly BuildStrategySpecV1[],
  graph: RecommendationItemGraph,
): PersistedBuildStrategySnapshotPayloadV1 {
  const itemDefinitions = graph.getAllItems()
    .map((item) => clone(item))
    .sort((a, b) => a.itemId - b.itemId);
  const known = new Set(itemDefinitions.map((item) => item.itemId));
  const lineageEdges = itemDefinitions
    .flatMap((item) => graph.getDirectComponentIds(item.itemId)
      .filter((componentItemId) => known.has(componentItemId))
      .map((componentItemId) => ({ parentItemId: item.itemId, componentItemId })))
    .sort((a, b) => a.parentItemId - b.parentItemId || a.componentItemId - b.componentItemId);
  return {
    schemaVersion: 1,
    specs: clone([...specs]).sort((a, b) => a.strategyId.localeCompare(b.strategyId)),
    itemDefinitions,
    lineageEdges,
  };
}

function parsePayload(value: Record<string, unknown>): PersistedBuildStrategySnapshotPayloadV1 {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.specs) ||
    !Array.isArray(value.itemDefinitions) || !Array.isArray(value.lineageEdges)) {
    throw new Error('Build strategy snapshot payload is invalid');
  }
  return clone(value) as unknown as PersistedBuildStrategySnapshotPayloadV1;
}

function contentHash(payload: PersistedBuildStrategySnapshotPayloadV1): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function validatePublishIdentity(input: PublishBuildStrategySnapshotV1Input): number {
  if (!input.snapshotId || !input.rulesetId || !input.patchId) {
    throw new Error('Build strategy snapshot identity is incomplete');
  }
  if (!/^[a-f0-9]{64}$/i.test(input.catalogSha256) || !/^[a-f0-9]{64}$/i.test(input.sourceSha256)) {
    throw new Error('Build strategy snapshot SHA256 values are invalid');
  }
  const heroIds = [...new Set(input.specs.map((spec) => spec.heroId))].sort((a, b) => a - b);
  if (heroIds.length !== 1) {
    throw new Error('Build strategy snapshot must contain strategies for exactly one hero');
  }
  return heroIds[0];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
