import { RecommendationEconomyRulesStoreV1Service } from '../src/statlocker-adaptive/recommendation-economy-rules-store-v1.service';

const catalogSha256 = 'a'.repeat(64);
const rules = {
  rulesetId: 'r1',
  catalogSha256,
  baseSlots: 12,
  baseSlotsByType: { weapon: 4, vitality: 4, spirit: 4 },
  maxFlexSlots: 4,
  maxActiveItems: 4,
  investmentBreakpoints: {
    weapon: [1600, 3200, 6400],
    vitality: [1600, 3200, 6400],
    spirit: [1600, 3200, 6400],
  },
} as const;

function repository(initial: any[] = []) {
  const rows = [...initial];
  return {
    rows,
    create: jest.fn((value: any) => ({ ...value })),
    save: jest.fn(async (value: any) => {
      const index = rows.findIndex((row) => row.snapshotId === value.snapshotId);
      if (index >= 0) rows[index] = { ...value };
      else rows.push({ ...value });
      return value;
    }),
    find: jest.fn(async (options: any) => rows
      .filter((row) => options?.where?.active === undefined || row.active === options.where.active)
      .sort((a, b) => b.verifiedAt.getTime() - a.verifiedAt.getTime() || a.snapshotId.localeCompare(b.snapshotId))),
    findOne: jest.fn(async (options: any) => rows
      .filter((row) => Object.entries(options.where).every(([key, value]) => row[key] === value))
      .sort((a, b) => b.verifiedAt.getTime() - a.verifiedAt.getTime())[0]),
  } as any;
}

describe('recommendation economy rules store v1', () => {
  it('publishes and resolves only the exact ruleset plus catalog identity', async () => {
    const repo = repository();
    const store = new RecommendationEconomyRulesStoreV1Service(repo);

    await store.publish({
      snapshotId: 'economy-r1-a',
      source: 'manual-verified-game-rules',
      verifiedAt: new Date('2026-09-05T00:00:00.000Z'),
      rules,
    });

    await expect(store.resolveExact('r1', catalogSha256)).resolves.toEqual(rules);
    await expect(store.resolveExact('r2', catalogSha256)).resolves.toBeUndefined();
    await expect(store.resolveExact('r1', 'b'.repeat(64))).resolves.toBeUndefined();
    expect(repo.rows[0].contentSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('preserves verified upgrade pricing policy and rules source through persistence', async () => {
    const repo = repository();
    const store = new RecommendationEconomyRulesStoreV1Service(repo);
    const rulesWithUpgradePricing = {
      ...rules,
      source: 'verified-ruleset-snapshot',
      upgradePricingPolicy: {
        mode: 'TARGET_COST_MINUS_VERIFIED_COMPONENT_CREDIT' as const,
        componentCreditRatio: 1,
        evidence: 'RECONSTRUCTED' as const,
        source: 'verified-item-recipe-pricing',
      },
    };

    await store.publish({
      snapshotId: 'economy-r1-upgrade-pricing',
      source: 'manual-verified-game-rules',
      verifiedAt: new Date('2026-09-05T00:00:00.000Z'),
      rules: rulesWithUpgradePricing,
    });

    expect(repo.rows[0].payload).toMatchObject({
      source: 'verified-ruleset-snapshot',
      upgradePricingPolicy: rulesWithUpgradePricing.upgradePricingPolicy,
    });
    await expect(store.resolveExact('r1', catalogSha256)).resolves.toEqual(rulesWithUpgradePricing);
  });

  it('fails closed on malformed or identity-mismatched persisted rules', async () => {
    const repo = repository([{
      snapshotId: 'bad',
      rulesetId: 'r1',
      catalogSha256,
      source: 'bad',
      contentSha256: '0'.repeat(64),
      active: true,
      payload: { ...rules, rulesetId: 'r2' },
      verifiedAt: new Date('2026-09-05T00:00:00.000Z'),
    }]);
    const store = new RecommendationEconomyRulesStoreV1Service(repo);

    await expect(store.resolveExact('r1', catalogSha256)).resolves.toBeUndefined();
  });

  it('rejects category slot totals that disagree with baseSlots', async () => {
    const store = new RecommendationEconomyRulesStoreV1Service(repository());

    await expect(store.publish({
      snapshotId: 'invalid-slots',
      source: 'test',
      rules: {
        ...rules,
        baseSlots: 9,
      },
    })).rejects.toThrow('base slot total');
  });
});
