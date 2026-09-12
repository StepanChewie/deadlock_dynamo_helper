export const statlockerV1Fixtures = {
  patches: {
    current_minor_patch_id: '15-1',
    patches: [{ minor_patch_id: '15-1' }, { minor_patch_id: '15-0' }],
  },
  patchData: {
    patch: '15-1',
    items: [{
      hero_id: 10,
      item_id: 100,
      mean_wpa: 0.12,
      sample_size: 1000,
      wpa_confidence: 0.8,
      ahead_wpa: 0.10,
      even_wpa: 0.14,
      behind_wpa: 0.18,
      median_purchase_time_s: 720,
      lane_wpa: 0.05,
      post_lane_wpa: 0.11,
      enemy_composition: { spirit: 0.07 },
      build_breakdown: { burst: 0.09 },
    }],
  },
  vsHero: {
    data: [{
      hero_id: 10,
      vs_hero_id: 20,
      items: [{ item_id: 100, delta_wpa: 0.20, count: 600 }],
    }],
  },
  t4Chains: {
    by_hero: {
      '10': [
        { item_ids: [100, 101], sample_size: 500, mean_wpa: 0.08 },
        { item_ids: [100, 101, 102], sample_size: 300, mean_wpa: 0.11 },
      ],
    },
  },
  leaderboard: {
    hero_id: 10,
    leaderboard: [
      { account_id: '101', rank: 1, player_name: 'One' },
      { account_id: '102', rank: 2, player_name: 'Two' },
    ],
  },
  proBuild: {
    account_id: '101',
    hero_id: 10,
    items: [{
      item_id: 100,
      purchaseRate: 0.9,
      medianBuyTimeS: 630,
      frequencyTier: 'core',
      phase: 'mid',
      relationships: [{ itemId: 101, strength: 0.7 }],
    }],
  },
  // WPA_FILTERED_ITEMS raw contract: hero/item names joined against the reference
  // seeds; values mirror the captured Paradox "Weapon Shielding" lifecycle row.
  filteredItems: {
    hero_id: 10,
    items: [{
      item: 'Weapon Shielding',
      heroName: 'Paradox',
      wpaValue: 0.04934861681731036,
      sampleSize: 3651,
      mean_purchase_time_min: 12.241265406737883,
    }],
  },
} as const;
