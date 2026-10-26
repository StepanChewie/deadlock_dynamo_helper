import { formatMatchRow, enrichmentOutcome } from './matches-view';

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
