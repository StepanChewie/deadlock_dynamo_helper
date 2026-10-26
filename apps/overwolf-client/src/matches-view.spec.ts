import { createMatchesView, enrichmentOutcome, formatMatchRow } from './matches-view';

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

  it('derives win/loss only from enrichment', () => {
    expect(enrichmentOutcome({ match_id: 'm1', match_result: 'VICTORY' } as never)).toBe('win');
    expect(enrichmentOutcome(null)).toBeUndefined();
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
});
