import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InventorySlotType } from '@deadlock-live-probe/build-domain';
import { RecommendationEconomyRulesSnapshotV1Entity } from '../deadlock-live/entities/recommendation-economy-rules-snapshot-v1.entity';
import { RecommendationEconomyRulesV1 } from './adaptive-economy-v1';

export interface PublishRecommendationEconomyRulesV1Input {
  snapshotId: string;
  source: string;
  rules: RecommendationEconomyRulesV1;
  verifiedAt?: Date;
}

@Injectable()
export class RecommendationEconomyRulesStoreV1Service {
  constructor(
    @InjectRepository(RecommendationEconomyRulesSnapshotV1Entity)
    private readonly repository: Repository<RecommendationEconomyRulesSnapshotV1Entity>,
  ) {}

  async publish(input: PublishRecommendationEconomyRulesV1Input): Promise<void> {
    validateRules(input.rules);
    if (!input.snapshotId || !input.source) throw new Error('Recommendation economy rules snapshot identity is incomplete');
    const normalized = normalizeRules(input.rules);
    const contentSha256 = hashRules(normalized);
    const activeRows = await this.repository.find({
      where: {
        rulesetId: normalized.rulesetId,
        catalogSha256: normalized.catalogSha256,
        active: true,
      },
    });
    const row = this.repository.create({
      snapshotId: input.snapshotId,
      rulesetId: normalized.rulesetId,
      catalogSha256: normalized.catalogSha256,
      source: input.source,
      contentSha256,
      active: true,
      payload: clone(normalized) as unknown as Record<string, unknown>,
      verifiedAt: input.verifiedAt ?? new Date(),
    });
    await this.repository.save(row);
    for (const previous of activeRows) {
      if (previous.snapshotId === row.snapshotId || !previous.active) continue;
      previous.active = false;
      await this.repository.save(previous);
    }
  }

  async resolveExact(rulesetId: string, catalogSha256: string): Promise<RecommendationEconomyRulesV1 | undefined> {
    if (!rulesetId || !/^[a-f0-9]{64}$/i.test(catalogSha256)) return undefined;
    const row = await this.repository.findOne({
      where: {
        rulesetId,
        catalogSha256: catalogSha256.toLowerCase(),
        active: true,
      },
      order: { verifiedAt: 'DESC', snapshotId: 'ASC' },
    });
    if (!row) return undefined;
    const rules = parseRules(row.payload);
    if (!rules || rules.rulesetId !== rulesetId || rules.catalogSha256 !== catalogSha256.toLowerCase()) return undefined;
    if (hashRules(rules) !== row.contentSha256.toLowerCase()) return undefined;
    return rules;
  }
}

function parseRules(payload: Record<string, unknown>): RecommendationEconomyRulesV1 | undefined {
  try {
    const rules = clone(payload) as unknown as RecommendationEconomyRulesV1;
    validateRules(rules);
    return normalizeRules(rules);
  } catch {
    return undefined;
  }
}

function validateRules(rules: RecommendationEconomyRulesV1): void {
  if (!rules || !rules.rulesetId || !/^[a-f0-9]{64}$/i.test(rules.catalogSha256)) {
    throw new Error('Recommendation economy rules identity is invalid');
  }
  if (!isNonNegativeInteger(rules.baseSlots) || !isNonNegativeInteger(rules.maxFlexSlots) || !isNonNegativeInteger(rules.maxActiveItems)) {
    throw new Error('Recommendation economy rules slot limits are invalid');
  }
  const baseTotal = SLOT_TYPES.reduce((sum, type) => {
    const value = rules.baseSlotsByType?.[type];
    if (!isNonNegativeInteger(value)) throw new Error(`Recommendation economy rules base slot count is invalid: ${type}`);
    return sum + value;
  }, 0);
  if (baseTotal !== rules.baseSlots) throw new Error('Recommendation economy rules base slot total does not match baseSlots');
  for (const type of SLOT_TYPES) {
    const values = rules.investmentBreakpoints?.[type];
    if (!Array.isArray(values) || values.some((value) => !Number.isFinite(value) || value <= 0)) {
      throw new Error(`Recommendation economy rules investment breakpoints are invalid: ${type}`);
    }
  }

  const policy = rules.upgradePricingPolicy;
  if (!policy) return;
  if (policy.mode !== 'TARGET_COST_MINUS_VERIFIED_COMPONENT_CREDIT') {
    throw new Error('Recommendation economy rules upgrade pricing mode is invalid');
  }
  if (!Number.isFinite(policy.componentCreditRatio) || policy.componentCreditRatio < 0 || policy.componentCreditRatio > 1) {
    throw new Error('Recommendation economy rules upgrade pricing component credit ratio is invalid');
  }
  if (policy.evidence !== 'OBSERVED' && policy.evidence !== 'RECONSTRUCTED') {
    throw new Error('Recommendation economy rules upgrade pricing evidence is invalid');
  }
  if (!policy.source?.trim()) {
    throw new Error('Recommendation economy rules upgrade pricing source is invalid');
  }
}

function normalizeRules(rules: RecommendationEconomyRulesV1): RecommendationEconomyRulesV1 {
  return {
    rulesetId: rules.rulesetId,
    catalogSha256: rules.catalogSha256.toLowerCase(),
    baseSlots: rules.baseSlots,
    baseSlotsByType: {
      weapon: rules.baseSlotsByType.weapon,
      vitality: rules.baseSlotsByType.vitality,
      spirit: rules.baseSlotsByType.spirit,
    },
    maxFlexSlots: rules.maxFlexSlots,
    maxActiveItems: rules.maxActiveItems,
    investmentBreakpoints: {
      weapon: normalizeBreakpoints(rules.investmentBreakpoints.weapon),
      vitality: normalizeBreakpoints(rules.investmentBreakpoints.vitality),
      spirit: normalizeBreakpoints(rules.investmentBreakpoints.spirit),
    },
    ...(rules.upgradePricingPolicy ? {
      upgradePricingPolicy: {
        ...rules.upgradePricingPolicy,
        source: rules.upgradePricingPolicy.source.trim(),
      },
    } : {}),
    ...(rules.source?.trim() ? { source: rules.source.trim() } : {}),
  };
}

function normalizeBreakpoints(values: readonly number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function hashRules(rules: RecommendationEconomyRulesV1): string {
  return createHash('sha256').update(JSON.stringify(rules)).digest('hex');
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

const SLOT_TYPES: readonly InventorySlotType[] = ['weapon', 'vitality', 'spirit'];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
