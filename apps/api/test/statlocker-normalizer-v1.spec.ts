import {
  StatlockerDatasetValidationError,
  StatlockerNormalizerService,
} from '../src/statlocker-adaptive/statlocker-normalizer.service';
import { statlockerV1Fixtures } from './fixtures/statlocker-v1';

describe('StatlockerNormalizerService', () => {
  const service = new StatlockerNormalizerService();

  it('normalizes the required aggregate evidence families deterministically', () => {
    const patches = service.normalizePatches(statlockerV1Fixtures.patches);
    expect(patches.currentMinorPatchId).toBe('15-1');

    const wpa = service.normalizeWpaPatchData(statlockerV1Fixtures.patchData, '15-1');
    expect(wpa.payload.items[0]).toMatchObject({
      heroId: 10,
      itemId: 100,
      meanWpa: 0.12,
      sampleSize: 1000,
      wpaConfidence: 0.8,
      laneWpa: 0.05,
      postLaneWpa: 0.11,
    });
    expect(wpa.payload.items[0].gameState).toEqual({ ahead: 0.10, even: 0.14, behind: 0.18 });
    expect(wpa.payload.items[0].purchaseTiming.medianPurchaseSec).toBe(720);
    expect(wpa.payload.items[0].enemyComposition).toEqual({ spirit: 0.07 });
    expect(wpa.payload.items[0].ownBuild).toEqual({ burst: 0.09 });

    const vs = service.normalizeVsHeroWpa(statlockerV1Fixtures.vsHero, '15-1');
    expect(vs.payload.slices[0]).toEqual({
      heroId: 10,
      enemyHeroId: 20,
      items: [{ itemId: 100, deltaWpa: 0.20, count: 600 }],
    });

    const chains = service.normalizeT4Chains(statlockerV1Fixtures.t4Chains, '15-1');
    expect(chains.payload.chains.map((chain) => chain.itemIds)).toEqual([[100, 101], [100, 101, 102]]);

    const leaderboard = service.normalizeHeroLeaderboard(statlockerV1Fixtures.leaderboard, '15-1', 10);
    expect(leaderboard.payload.profiles[0].accountId).toBe('101');

    const pro = service.normalizeProBuildAnalysis(statlockerV1Fixtures.proBuild, '15-1', '101', 10);
    expect(pro.payload.items[0]).toMatchObject({
      purchaseRate: 0.9,
      medianBuyTimeS: 630,
      frequencyTier: 'CORE',
      phase: 'MID',
    });
    expect(pro.payload.items[0].relationships).toEqual([{ itemId: 101, strength: 0.7 }]);

    const filtered = service.normalizeWpaFilteredItems(statlockerV1Fixtures.filteredItems, '15-1', 10);
    // Lifecycle rows resolve names to reference ids and convert purchase timing
    // from minutes to seconds via the x60 product.
    expect(filtered.payload.items[0]).toEqual({
      heroId: 10,
      itemId: 805079544,
      generalWpa: 0.04934861681731036,
      averagePurchaseTimeS: 12.241265406737883 * 60,
      sampleSize: 3651,
    });
    expect(wpa.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(service.normalizeWpaPatchData({ ...statlockerV1Fixtures.patchData }, '15-1').contentSha256)
      .toBe(wpa.contentSha256);
  });

  it('normalizes explicit pro-build choice metadata without inferring from relationships', () => {
    const result = service.normalizeProBuildAnalysis({
      accountId: 101,
      heroId: 10,
      items: [{
        itemId: 100,
        purchaseRate: 0.8,
        medianBuyTimeS: 280,
        frequencyTier: 'frequent',
        phase: 'early_game',
        group: 'defense',
        pick: 1,
        relationships: [{ itemId: 200, strength: 0.9 }],
      }, {
        itemId: 101,
        purchaseRate: 0.4,
        medianBuyTimeS: 300,
        frequencyTier: 'sometimes',
        phase: 'early',
        relationships: [{ itemId: 100, strength: 0.95 }],
      }],
    }, '15-1', '101', 10);

    expect(result.payload.items[0]).toEqual(expect.objectContaining({
      phase: 'EARLY',
      explicitGroup: { type: 'CHOICE', groupKey: 'defense', minSelect: 1, maxSelect: 1 },
    }));
    expect(result.payload.items[1].explicitGroup).toBeUndefined();
  });

  it('normalizes the live nested Statlocker aggregate contracts', () => {
    const patchId = '676255623445218601';

    const patches = service.normalizePatches([
      { minorPatchId: patchId, majorPatchDate: '2026-03-11' },
      { minorPatchId: '146261', majorPatchDate: '2026-03-11' },
    ]);
    expect(patches).toEqual({
      currentMinorPatchId: patchId,
      availableMinorPatchIds: ['146261', patchId],
    });

    const wpa = service.normalizeWpaPatchData({
      metadata: { minor_patches: { patches_included: [patchId] } },
      by_patch: {
        [`patch_${patchId}`]: {
          by_rank: {
            rank_8: {
              by_tier: {
                tier_1: {
                  top_by_hero: {
                    Victor: [{
                      item: 'Mystic Expansion',
                      sample_size: 125,
                      mean_wpa: 0.0125,
                      std_wpa: 0.1,
                    }],
                  },
                  tier_stats: { total_heroes: 1, total_items_in_tier: 1 },
                },
              },
            },
          },
        },
      },
    }, patchId);
    expect(wpa.payload).toEqual({
      patchId,
      items: [{
        heroId: 66,
        itemId: 754480263,
        meanWpa: 0.0125,
        sampleSize: 125,
        gameState: {},
        purchaseTiming: {},
      }],
    });

    const vs = service.normalizeVsHeroWpa({
      metadata: { minor_patches: { patches_included: [patchId] } },
      by_patch: {
        [`patch_${patchId}`]: {
          by_rank: {
            rank_8: {
              by_hero: {
                Abrams: {
                  'Arcane Surge': {
                    _baseline: { mean_wpa: -0.00237, count: 915 },
                    Apollo: { mean_wpa: -0.001782, count: 100, delta_wpa: 0.000588 },
                  },
                },
              },
            },
          },
        },
      },
    }, patchId);
    expect(vs.payload.slices).toEqual([{
      heroId: 6,
      enemyHeroId: 77,
      items: [{ itemId: 1150006784, deltaWpa: 0.000588, count: 100 }],
    }]);

    const chains = service.normalizeT4Chains({
      metadata: { unique_heroes_with_chains: 1 },
      by_hero: {
        Billy: {
          total_t4_chains: 1,
          two_item_chains: [{
            chain: 'Mystic Expansion -> Close Quarters',
            items: ['Mystic Expansion', 'Close Quarters'],
            sample_size: 42,
            wpa_metrics: { chain_total: { mean_wpa: 0.12 } },
          }],
          three_item_chains: [],
        },
      },
    }, patchId);
    expect(chains.payload.chains).toEqual([{
      heroId: 72,
      itemIds: [754480263, 1342610602],
      sampleSize: 42,
      meanWpa: 0.12,
    }]);

    const leaderboard = service.normalizeHeroLeaderboard({
      data: [{ accountId: 1893890487, heroId: 6, rank: 1, steamProfile: { name: 'Player One' } }],
    }, patchId, 6);
    expect(leaderboard.payload.profiles).toEqual([{
      accountId: '1893890487',
      heroId: 6,
      rank: 1,
      playerName: 'Player One',
    }]);

    const pro = service.normalizeProBuildAnalysis({
      accountId: 1893890487,
      heroId: 6,
      items: [{
        itemId: 754480263,
        purchaseRate: 0.9,
        medianBuyTimeS: 630,
        frequencyTier: 'core',
        phase: 'mid',
      }],
    }, patchId, '1893890487', 6);
    expect(pro.payload).toMatchObject({
      accountId: '1893890487',
      heroId: 6,
      items: [{ itemId: 754480263, frequencyTier: 'CORE', phase: 'MID' }],
    });
  });

  it('rejects structurally incomplete, invalid-phase or non-finite primary evidence', () => {
    expect(() => service.normalizeWpaPatchData({ patch: '15-1', items: [] }, '15-1'))
      .toThrow(StatlockerDatasetValidationError);
    expect(() => service.normalizeWpaPatchData({
      patch: '15-1',
      items: [{ hero_id: 10, item_id: 100, mean_wpa: Number.NaN, sample_size: 1 }],
    }, '15-1')).toThrow(StatlockerDatasetValidationError);
    expect(() => service.normalizeVsHeroWpa({ data: [] }, '15-1'))
      .toThrow(StatlockerDatasetValidationError);
    expect(() => service.normalizeProBuildAnalysis({ account_id: '101', hero_id: 10, items: [{}] }, '15-1', '101', 10))
      .toThrow(StatlockerDatasetValidationError);
    expect(() => service.normalizeProBuildAnalysis({
      account_id: '101',
      hero_id: 10,
      items: [{
        item_id: 100,
        purchase_rate: 0.5,
        median_buy_time_s: 400,
        frequency_tier: 'CORE',
        phase: 'someday',
      }],
    }, '15-1', '101', 10)).toThrow(StatlockerDatasetValidationError);
  });

  it('rejects live leaderboard rows whose hero scope is inconsistent', () => {
    expect(() => service.normalizeHeroLeaderboard({
      data: [{ accountId: 101, heroId: 13, rank: 1 }],
    }, '676255623445218601', 6)).toThrow(StatlockerDatasetValidationError);
  });

  it('rejects live T4 chains whose family cardinality is inconsistent', () => {
    expect(() => service.normalizeT4Chains({
      by_hero: {
        Abrams: {
          two_item_chains: [{
            items: ['Mystic Expansion', 'Close Quarters', 'Arcane Surge'],
            sample_size: 42,
            wpa_metrics: { chain_total: { mean_wpa: 0.12 } },
          }],
          three_item_chains: [],
        },
      },
    }, '676255623445218601')).toThrow(StatlockerDatasetValidationError);
  });
});
