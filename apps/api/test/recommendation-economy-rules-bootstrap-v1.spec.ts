import { RecommendationEconomyRulesBootstrapV1Service } from '../src/statlocker-adaptive/recommendation-economy-rules-bootstrap-v1.service';

/**
 * The operator-pinned entry covers one (rulesetKey, payloadSha256) pair. It must
 * not stop later catalog imports from receiving rules of their own: the live
 * decision state resolves rules exactly by that pair, so a catalog with no entry
 * silently loses the upgrade pricing policy, and with it every upgrade recipe.
 *
 * Observed 2026-09-17: catalog 6694 was imported on 2026-09-16, all four economy
 * snapshots were still pinned to the previous catalog, and the full build
 * stopped after four family entry purchases.
 */
describe('RecommendationEconomyRulesBootstrapV1Service', () => {
  const previousEnv = process.env.ADAPTIVE_ECONOMY_RULES_JSON;

  afterEach(() => {
    if (previousEnv === undefined) {
      delete process.env.ADAPTIVE_ECONOMY_RULES_JSON;
    } else {
      process.env.ADAPTIVE_ECONOMY_RULES_JSON = previousEnv;
    }
  });

  function createService(versions: unknown[], resolveExact: jest.Mock) {
    const versionRepo = { find: jest.fn().mockResolvedValue(versions) } as any;
    const economyRulesStore = {
      resolveExact,
      publish: jest.fn().mockResolvedValue(undefined),
    } as any;

    return {
      service: new RecommendationEconomyRulesBootstrapV1Service(versionRepo, economyRulesStore),
      economyRulesStore,
    };
  }

  it('still bootstraps a new catalog version when an operator entry exists', async () => {
    process.env.ADAPTIVE_ECONOMY_RULES_JSON = JSON.stringify({
      snapshotId: 'verified-shop-credit-policy:client-6686:old',
      source: 'operator-verified-deadlock-shop-full-component-credit',
      rules: { rulesetId: 'client-6686', baseSlots: 12 },
    });

    const resolveExact = jest.fn().mockResolvedValue(undefined);
    const { service, economyRulesStore } = createService(
      [{ rulesetKey: 'client-6694', payloadSha256: 'f5226f2e89233f2671b3ae041734e3679fa37acc' }],
      resolveExact,
    );

    await service.onModuleInit();

    expect(resolveExact).toHaveBeenCalledWith('client-6694', 'f5226f2e89233f2671b3ae041734e3679fa37acc');
    expect(economyRulesStore.publish).toHaveBeenCalledTimes(2);
    const published = economyRulesStore.publish.mock.calls.map((call: unknown[]) => call[0]);
    expect(published).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ snapshotId: 'verified-shop-credit-policy:client-6686:old' }),
        expect.objectContaining({ snapshotId: 'canonical:client-6694:f5226f2e89233f26' }),
      ]),
    );
  });

  it('publishes canonical rules that carry an upgrade pricing policy', async () => {
    // The two halves of the same failure. Publishing rules for the new catalog
    // is not enough on its own: without an upgrade pricing policy
    // `deriveUpgradeCost` returns undefined, and the compiler drops every recipe
    // whose soul cost is unknown - so the catalog would have no progression at
    // all and the build would stop after the family entry purchases.
    const resolveExact = jest.fn().mockResolvedValue(undefined);
    const { service, economyRulesStore } = createService(
      [{ rulesetKey: 'client-6694', payloadSha256: 'f5226f2e89233f2671b3ae041734e3679fa37acc' }],
      resolveExact,
    );

    await service.onModuleInit();

    const published = economyRulesStore.publish.mock.calls[0][0];
    expect(published.rules.upgradePricingPolicy).toEqual(
      expect.objectContaining({
        mode: 'TARGET_COST_MINUS_VERIFIED_COMPONENT_CREDIT',
        componentCreditRatio: 1,
      }),
    );
  });

  it('does not replace an entry a version already has', async () => {
    // Deliberate, and the reason is worth recording: an existing entry that
    // predates the pricing policy is unusable and does have to be removed, but
    // this service cannot decide that. resolveExact parses the payload column
    // and does not return `source`, which lives in its own column, so it cannot
    // tell its own canonical row from an operator's. Such a row is removed by
    // hand; the generator keeps the situation from recurring.
    for (const source of [
      'canonical-deadlock-universal-v1',
      'operator-verified-deadlock-shop-full-component-credit',
    ]) {
      const resolveExact = jest.fn().mockResolvedValue({ rulesetId: 'client-6694', source });
      const { service, economyRulesStore } = createService(
        [{ rulesetKey: 'client-6694', payloadSha256: 'f5226f2e89233f2671b3ae041734e3679fa37acc' }],
        resolveExact,
      );

      await service.onModuleInit();

      expect(economyRulesStore.publish).not.toHaveBeenCalled();
    }
  });

  it('skips versions that carry no ruleset key or payload hash', async () => {
    const resolveExact = jest.fn().mockResolvedValue(undefined);
    const { service, economyRulesStore } = createService(
      [
        { rulesetKey: undefined, payloadSha256: 'abc' },
        { rulesetKey: 'client-6694', payloadSha256: undefined },
      ],
      resolveExact,
    );

    await service.onModuleInit();

    expect(resolveExact).not.toHaveBeenCalled();
    expect(economyRulesStore.publish).not.toHaveBeenCalled();
  });
});
