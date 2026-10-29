import { createMatchesView, enrichmentOutcome, formatMatchRow, MatchRowInput } from './matches-view';

describe('matches view presentation', () => {
  it('formats a row: hero, date, K/D/A, souls, duration', () => {
    const row = formatMatchRow({
      matchId: 'm1', localHeroId: 5, kills: 11, deaths: 3, assists: 9,
      souls: '48000', durationSec: 2360, startedAt: '2026-10-25T18:00:00Z',
      players: [], enrichmentStatus: 'PENDING', enrichmentAttempts: 0,
      createdAt: '', updatedAt: '', localSteamId: '765',
    });
    expect(row.title).toContain('11/3/9');
    expect(row.title).toContain('39 мин');
    expect(row.badge).toBe('pending');
  });

  it('derives win when the local team matches winning_team', () => {
    expect(enrichmentOutcome({ winning_team: 'Team1' }, [{ isLocal: true, team: 1 }])).toBe('win');
    expect(enrichmentOutcome({ winning_team: 'Team2' }, [{ isLocal: true, team: 2 }])).toBe('win');
  });

  it('derives loss when winning_team is the opposite team', () => {
    expect(enrichmentOutcome({ winning_team: 'Team2' }, [{ isLocal: true, team: 1 }])).toBe('loss');
    expect(enrichmentOutcome({ winning_team: 'Team1' }, [{ isLocal: true, team: 2 }])).toBe('loss');
  });

  it('stays undefined without a derivable outcome', () => {
    const local = [{ isLocal: true, team: 1 }];
    expect(enrichmentOutcome(null, local)).toBeUndefined();
    expect(enrichmentOutcome(undefined, local)).toBeUndefined();
    // DONE rows can carry metadata without a trustworthy winning_team.
    expect(enrichmentOutcome({}, local)).toBeUndefined();
    expect(enrichmentOutcome({ winning_team: 'Team1', not_scored: true }, local)).toBeUndefined();
    // Missing or out-of-range local team is not enough to call the game.
    expect(enrichmentOutcome({ winning_team: 'Team1' }, [])).toBeUndefined();
    expect(enrichmentOutcome({ winning_team: 'Team1' }, [{ isLocal: true }])).toBeUndefined();
    expect(enrichmentOutcome({ winning_team: 'Team1' }, [{ isLocal: true, team: 5 }])).toBeUndefined();
  });

  it('shows the win/loss badge on DONE rows when the outcome is derivable', () => {
    const base = {
      matchId: 'm1', kills: 11, deaths: 3, assists: 9, startedAt: '2026-10-25T18:00:00Z',
      enrichmentStatus: 'DONE' as const, enrichmentAttempts: 0,
      createdAt: '', updatedAt: '', localSteamId: '765',
    };
    expect(formatMatchRow({
      ...base, players: [{ isLocal: true, team: 1 }], enrichment: { winning_team: 'Team1' },
    }).badge).toBe('win');
    expect(formatMatchRow({
      ...base, players: [{ isLocal: true, team: 1 }], enrichment: { winning_team: 'Team2' },
    }).badge).toBe('loss');
    // DONE without a derivable outcome keeps the neutral marker.
    expect(formatMatchRow({
      ...base, players: [{ isLocal: true, team: 1 }], enrichment: {},
    }).badge).toBe('done');
  });
});

describe('matches view default user', () => {
  class FakeElement {
    textContent = '';
    value = '';
    selected = false;
    children: FakeElement[] = [];

    append(...children: FakeElement[]): void {
      this.children.push(...children);
    }

    replaceChildren(...children: FakeElement[]): void {
      this.children = children;
    }

    addEventListener(): void {
      // Only change/click handlers are registered here; neither fires in this suite.
    }
  }

  const originalDocument = globalThis.document;

  afterEach(() => {
    globalThis.document = originalDocument;
  });

  it('resolves the default user through the getter on every render', async () => {
    // A string captured at boot stays empty forever: the client only learns
    // its local steam id once a match starts, so the view has to re-read the
    // getter per render instead of freezing the value createMatchesView saw.
    let defaultSteamId: string | undefined;
    globalThis.document = {
      createElement: () => new FakeElement(),
    } as unknown as Document;

    const fetchImpl = jest.fn(async (input: RequestInfo | URL): Promise<Response> => {
      if (String(input).endsWith('/users')) {
        return {
          json: async () => ({ users: [{ steamId: '765-first' }, { steamId: '765-second' }] }),
        } as Response;
      }
      return { json: async () => ({ matches: [] }) } as Response;
    });

    const view = createMatchesView({
      apiBaseUrl: 'https://api.test',
      defaultSteamId: () => defaultSteamId,
      fetchImpl,
    });

    await view.render();
    defaultSteamId = '765-second';
    await view.render();

    const matchUrls = fetchImpl.mock.calls
      .map(([input]) => String(input))
      .filter((url) => url.endsWith('/matches'));
    expect(matchUrls).toEqual([
      'https://api.test/deadlock/match-history/users/765-first/matches',
      'https://api.test/deadlock/match-history/users/765-second/matches',
    ]);
  });

  it('renders win/loss markers on list rows, neutral otherwise', async () => {
    globalThis.document = {
      createElement: () => new FakeElement(),
    } as unknown as Document;

    const matches: MatchRowInput[] = [
      {
        matchId: 'w1', localSteamId: '765', enrichmentStatus: 'DONE',
        enrichment: { winning_team: 'Team1' }, players: [{ isLocal: true, team: 1 }],
        startedAt: '2026-10-25T18:00:00Z',
      },
      {
        matchId: 'l1', localSteamId: '765', enrichmentStatus: 'DONE',
        enrichment: { winning_team: 'Team2' }, players: [{ isLocal: true, team: 1 }],
        startedAt: '2026-10-25T19:00:00Z',
      },
      {
        matchId: 'n1', localSteamId: '765', enrichmentStatus: 'DONE',
        players: [{ isLocal: true, team: 1 }],
        startedAt: '2026-10-25T20:00:00Z',
      },
    ];
    const fetchImpl = jest.fn(async (input: RequestInfo | URL): Promise<Response> => {
      if (String(input).endsWith('/users')) {
        return { json: async () => ({ users: [{ steamId: '765' }] }) } as Response;
      }
      return { json: async () => ({ matches }) } as Response;
    });

    const view = createMatchesView({ apiBaseUrl: 'https://api.test', fetchImpl });
    await view.render();

    const list = (view.root as unknown as FakeElement).children[1];
    const buttons = list.children.map((li) => li.children[0].textContent);
    expect(buttons[0]).toContain('✓ победа');
    expect(buttons[1]).toContain('✗ поражение');
    // DONE without a derivable outcome keeps the existing neutral marker.
    expect(buttons[2]?.endsWith('✓')).toBe(true);
    expect(buttons[2]).not.toContain('победа');
  });
});
