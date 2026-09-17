import { MinimalMatchState } from '@dynamo-lab/shared';
import { AdaptiveDecisionStateV1Service } from '../src/statlocker-adaptive/adaptive-decision-state-v1.service';

const catalogSha256 = 'a'.repeat(64);
const matchState: MinimalMatchState = {
  matchId: 'match-1',
  gameTimeSec: 600,
  lastUpdatedAt: '2026-08-31T12:00:00.000Z',
  playersBySteamId: {
    local: {
      steamId: 'local',
      playerName: 'Local',
      isLocal: true,
      heroId: 10,
      heroName: 'Local Hero',
      teamId: 1,
      souls: 2000,
      items: [{ id: 1, name: 'Owned', className: 'owned', enhanced: false }],
    },
    ally: {
      steamId: 'ally',
      playerName: 'Ally',
      heroId: 11,
      heroName: 'Ally Hero',
      teamId: 1,
      souls: 3000,
      items: [],
    },
    enemyB: {
      steamId: 'enemy-b',
      playerName: 'Enemy B',
      heroId: 30,
      heroName: 'Enemy Thirty',
      teamId: 2,
      level: 12,
      souls: 5000,
      kills: 7,
      deaths: 2,
      assists: 8,
      heroDamage: 24000,
      items: [],
    },
    enemyA: {
      steamId: 'enemy-a',
      playerName: 'Enemy A',
      heroId: 20,
      heroName: 'Enemy Twenty',
      teamId: 2,
      level: 9,
      souls: 4000,
      kills: 1,
      items: [],
    },
  },
};

const version = {
  catalogVersionId: 'catalog-1',
  rulesetKey: 'ruleset-a',
  source: 'TEST',
  payloadSha256: catalogSha256,
  importedAt: new Date('2026-08-31T11:00:00.000Z'),
};

const items = [
  {
    catalogVersionId: 'catalog-1',
    itemId: 1,
    name: 'Owned',
    className: 'owned',
    slotType: 'weapon',
    cost: 500,
    rawPayload: {
      type: 'upgrade',
      shopable: true,
      disabled: false,
      is_active_item: false,
      activation: 'passive',
    },
  },
  {
    catalogVersionId: 'catalog-1',
    itemId: 2,
    name: 'Target',
    className: 'target',
    slotType: 'vitality',
    cost: 1250,
    rawPayload: {
      type: 'upgrade',
      shopable: true,
      disabled: false,
      is_active_item: false,
      activation: 'passive',
    },
  },
];

const exactRules = {
  rulesetId: 'ruleset-a',
  catalogSha256,
  baseSlots: 12,
  baseSlotsByType: { weapon: 4, vitality: 4, spirit: 4 },
  maxFlexSlots: 4,
  maxActiveItems: 4,
  investmentBreakpoints: {
    weapon: [500, 1600, 3200],
    vitality: [800, 1600, 3200],
    spirit: [800, 1600, 3200],
  },
} as const;

function createService(
  scopeVerified: boolean,
  state: MinimalMatchState = matchState,
  economyRules: typeof exactRules | undefined = undefined,
) {
  const liveState = { getState: jest.fn().mockReturnValue(state) } as any;
  const soulsEvidence = { canVerifyScope: jest.fn().mockResolvedValue(scopeVerified) } as any;
  const versionRepo = { find: jest.fn().mockResolvedValue([version]) } as any;
  const itemRepo = { find: jest.fn().mockResolvedValue(items) } as any;
  const recipeRepo = { find: jest.fn().mockResolvedValue([]) } as any;
  const economyRulesStore = {
    resolveExact: jest.fn().mockResolvedValue(economyRules),
  } as any;
  return {
    service: new AdaptiveDecisionStateV1Service(
      liveState,
      soulsEvidence,
      versionRepo,
      itemRepo,
      recipeRepo,
      economyRulesStore,
    ),
    versionRepo,
    economyRulesStore,
  };
}

describe('AdaptiveDecisionStateV1Service', () => {
  it('builds an ML-neutral deterministic decision state from live state and catalog rows', async () => {
    const { service, versionRepo, economyRulesStore } = createService(true);
    const first = await service.build('match-1');
    const second = await service.build('match-1');

    expect(versionRepo.find).toHaveBeenCalledWith({
      order: { importedAt: 'DESC', catalogVersionId: 'DESC' },
      take: 1,
    });
    expect(economyRulesStore.resolveExact).toHaveBeenCalledWith('ruleset-a', catalogSha256);
    expect(first.localSteamId).toBe('local');
    expect(first.state.heroId).toBe(10);
    expect([...first.state.inventory.heldByItemId.keys()]).toEqual([1]);
    expect(first.itemGraph.getItem(2)?.itemId).toBe(2);
    expect(first.rulesetId).toBe('ruleset-a');
    expect(first.catalogSha256).toBe(catalogSha256);
    expect(first.state.gameTimeSec).toBe(600);
    expect(first.enemyHeroIds).toEqual([20, 30]);
    expect(first.enemyHeroes).toEqual([
      { heroId: 20, heroName: 'Enemy Twenty' },
      { heroId: 30, heroName: 'Enemy Thirty' },
    ]);
    expect(first.ourTeamSouls).toBe(5000);
    expect(first.enemyTeamSouls).toBe(9000);
    expect(first.slots.baseSlotsByType).toEqual({ weapon: 0, vitality: 0, spirit: 0 });
    expect(first.slots.usedFlexSlots).toBe(1);
    expect(first.slots.unlockedFlexSlots).toBe(12);
    expect(first.slots.totalCapacity).toBe(12);
    expect(first.slots.evidence).toBe('RECONSTRUCTED');
    expect(first.economyRules).toBeUndefined();
    expect(first.economyRulesEvidence).toBe('UNKNOWN');
    expect(first.investment.evidence).toBe('UNKNOWN');
    expect(first.stateRevision).toBe(second.stateRevision);
  });

  it('counts bot-match enemies, which all arrive with steam_id "0"', async () => {
    // A bot match reports every slot except yours with `steam_id: "0"`, so the
    // live state names all of them `bot:<slot>`. They are still the players, and
    // their heroes are real, so they must be counted.
    //
    // This is the counterweight to the phantom-slot bug fixed alongside it, and
    // it is not hypothetical: on 2026-09-17 match 106173851, a bot match, the
    // local player was on team 3 and team 2 held six bots with heroes
    // 6/11/27/35/17/18. Excluding `bot:` keys emptied the enemy roster and the
    // app showed nothing. The two cases are distinguished by whether the slot's
    // `bot:` entry was superseded by a real steam id - not by the key prefix.
    const botMatchState: MinimalMatchState = {
      ...matchState,
      playersBySteamId: {
        local: {
          steamId: 'local',
          playerName: 'Local',
          isLocal: true,
          heroId: 14,
          heroName: 'HOLLIDAY',
          teamId: 3,
          souls: 2000,
          items: [{ id: 1, name: 'Owned', className: 'owned', enhanced: false }],
        },
        // A team-mate, also a bot.
        'bot:roster_7': {
          steamId: 'bot:roster_7',
          playerName: 'UNKNOWN',
          heroId: 7,
          heroName: 'WRAITH',
          teamId: 3,
          souls: 1000,
          items: [],
        },
        'bot:roster_0': {
          steamId: 'bot:roster_0',
          playerName: 'UNKNOWN',
          heroId: 6,
          heroName: 'ABRAMS',
          teamId: 2,
          souls: 1500,
          items: [],
        },
        'bot:roster_1': {
          steamId: 'bot:roster_1',
          playerName: 'UNKNOWN',
          heroId: 11,
          heroName: 'DYNAMO',
          teamId: 2,
          souls: 1500,
          items: [],
        },
        'bot:roster_2': {
          steamId: 'bot:roster_2',
          playerName: 'UNKNOWN',
          heroId: 77,
          heroName: 'APOLLO',
          teamId: 2,
          souls: 1500,
          items: [],
        },
        'bot:roster_3': {
          steamId: 'bot:roster_3',
          playerName: 'UNKNOWN',
          heroId: 27,
          heroName: 'YAMATO',
          teamId: 2,
          souls: 1500,
          items: [],
        },
        'bot:roster_4': {
          steamId: 'bot:roster_4',
          playerName: 'UNKNOWN',
          heroId: 35,
          heroName: 'VISCOUS',
          teamId: 2,
          souls: 1500,
          items: [],
        },
        'bot:roster_5': {
          steamId: 'bot:roster_5',
          playerName: 'UNKNOWN',
          heroId: 17,
          heroName: 'GREY TALON',
          teamId: 2,
          souls: 1500,
          items: [],
        },
        // The observer slot: its own team, and hero id 0, which is not a hero.
        // Dropped by the hero-id validity rule, not by its identity.
        'bot:roster_11': {
          steamId: 'bot:roster_11',
          playerName: 'UNKNOWN',
          heroId: 0,
          heroName: 'UNKNOWN',
          teamId: 1,
          souls: 0,
          items: [],
        },
      },
    };

    const { service } = createService(true, botMatchState);
    const built = await service.build('match-1');

    expect(built.enemyHeroIds).toEqual([6, 11, 17, 27, 35, 77]);
    expect(built.enemyHeroIds).toHaveLength(6);
    expect((built.enemyHeroes ?? []).map((hero) => hero.heroId)).toEqual([6, 11, 17, 27, 35, 77]);
    expect((built.enemyLiveStates ?? []).map((enemy) => enemy.heroId)).toEqual([6, 11, 17, 27, 35, 77]);
  });

  it('carries deterministic per-enemy live state without inventing missing metrics', async () => {
    const result = await createService(true).service.build('match-1');

    expect(result.enemyLiveStates).toEqual([
      {
        steamId: 'enemy-a',
        playerName: 'Enemy A',
        heroId: 20,
        heroName: 'Enemy Twenty',
        level: 9,
        souls: 4000,
        kills: 1,
      },
      {
        steamId: 'enemy-b',
        playerName: 'Enemy B',
        heroId: 30,
        heroName: 'Enemy Thirty',
        level: 12,
        souls: 5000,
        kills: 7,
        deaths: 2,
        assists: 8,
        heroDamage: 24000,
      },
    ]);
    expect(result.enemyLiveStates.map((enemy) => enemy.steamId)).not.toContain('local');
    expect(result.enemyLiveStates.map((enemy) => enemy.steamId)).not.toContain('ally');
  });

  it('uses persisted economy rules for investment while slot capacity remains canonical', async () => {
    const { service, economyRulesStore } = createService(true, matchState, exactRules);

    const result = await service.build('match-1');

    expect(economyRulesStore.resolveExact).toHaveBeenCalledWith('ruleset-a', catalogSha256);
    expect(result.economyRules).toEqual(exactRules);
    expect(result.economyRulesEvidence).toBe('RECONSTRUCTED');
    expect(result.slots.baseSlotsByType).toEqual({ weapon: 0, vitality: 0, spirit: 0 });
    expect(result.slots.maxFlexSlots).toBe(12);
    expect(result.slots.unlockedFlexSlots).toBe(12);
    expect(result.slots.totalCapacity).toBe(12);
    expect(result.investment.evidence).toBe('RECONSTRUCTED');
    expect(result.investment.tracks.weapon.currentValue).toBe(500);
    expect(result.investment.tracks.weapon.achievedBreakpoint).toBe(500);
    expect(result.investment.tracks.weapon.nextBreakpoint).toBe(1600);
  });

  it('promotes roster souls to spendable only for an exact verified scope', async () => {
    const verified = await createService(true).service.build('match-1');
    expect(verified.state.economy.spendableSouls.value).toBe(2000);
    expect(verified.state.economy.spendableSouls.evidence).toBe('OBSERVED');

    const unverified = await createService(false).service.build('match-1');
    expect(unverified.state.economy.spendableSouls.value).toBeUndefined();
    expect(unverified.state.economy.spendableSouls.evidence).toBe('UNKNOWN');
  });

  it('keeps shop opportunity unknown, keeps slot capacity canonical, and refuses partial team soul totals', async () => {
    const state = structuredClone(matchState);
    delete state.playersBySteamId.ally.souls;
    const result = await createService(true, state).service.build('match-1');

    expect(result.state.economy.shopOpportunity.value).toBeUndefined();
    expect(result.state.economy.shopOpportunity.evidence).toBe('UNKNOWN');
    expect(result.slots.evidence).toBe('RECONSTRUCTED');
    expect(result.slots.unlockedFlexSlots).toBe(12);
    expect(result.slots.totalCapacity).toBe(12);
    expect(result.ourTeamSouls).toBeUndefined();
    expect(result.enemyTeamSouls).toBe(9000);
  });
});