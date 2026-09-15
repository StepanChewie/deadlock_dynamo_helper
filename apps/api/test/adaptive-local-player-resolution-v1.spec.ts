import { MinimalMatchState } from '@dynamo-lab/shared';
import { AdaptiveDecisionStateV1Service } from '../src/statlocker-adaptive/adaptive-decision-state-v1.service';

it('resolves the sole real Steam player when GEP omits the local marker', async () => {
  const state: MinimalMatchState = {
    matchId: 'match-1',
    lastUpdatedAt: '2026-09-01T19:00:00.000Z',
    playersBySteamId: {
      '76561198000000001': {
        steamId: '76561198000000001',
        playerName: 'Local',
        heroId: 10,
        teamId: 1,
        souls: 2000,
        items: [],
      },
      'bot:roster_1': {
        steamId: 'bot:roster_1',
        playerName: 'Bot',
        heroId: 20,
        teamId: 2,
        souls: 2000,
        items: [],
      },
    },
  };
  const version = {
    catalogVersionId: 'catalog-1',
    rulesetKey: 'ruleset-a',
    source: 'TEST',
    payloadSha256: 'a'.repeat(64),
    importedAt: new Date('2026-09-01T18:00:00.000Z'),
  };
  const items = [{
    catalogVersionId: 'catalog-1',
    itemId: 2,
    name: 'Target',
    className: 'target',
    slotType: 'vitality',
    cost: 1250,
    shopable: true,
    disabled: false,
    active: true,
    isActiveItem: false,
    rawPayload: {},
  }];
  const service = new AdaptiveDecisionStateV1Service(
    { getState: jest.fn().mockReturnValue(state) } as any,
    { canVerifyScope: jest.fn().mockResolvedValue(true) } as any,
    { find: jest.fn().mockResolvedValue([version]) } as any,
    { find: jest.fn().mockResolvedValue(items) } as any,
    { find: jest.fn().mockResolvedValue([]) } as any,
    { getRules: jest.fn().mockResolvedValue(undefined) } as any,
  );

  const result = await service.build('match-1');

  expect(result.localSteamId).toBe('76561198000000001');
  expect(result.state.heroId).toBe(10);
});
