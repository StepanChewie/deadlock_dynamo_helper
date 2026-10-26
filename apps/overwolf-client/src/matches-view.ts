/**
 * Client-side structural copy of the match-history player shape.
 *
 * The client never imports server code; like the other server-facing types in
 * this workspace, the entity fields it actually renders are re-declared here.
 */
export interface MatchHistoryPlayer {
  steamId?: string;
  name?: string;
  heroId?: number;
  heroName?: string;
  team?: number;
  lane?: number;
  level?: number;
  kills?: number;
  deaths?: number;
  assists?: number;
  souls?: number;
  heroDamage?: number;
  objectDamage?: number;
  healing?: number;
  isLocal?: boolean;
}

export interface MatchRowInput {
  matchId: string;
  localSteamId: string;
  localHeroId?: number | null;
  kills?: number | null;
  deaths?: number | null;
  assists?: number | null;
  souls?: string | null;
  durationSec?: number | null;
  startedAt: string;
  enrichmentStatus: 'PENDING' | 'DONE' | 'NOT_FOUND' | 'FAILED';
  players: MatchHistoryPlayer[];
  enrichment?: Record<string, unknown> | null;
  /** Present on the API entity so a fetched row can be passed through as-is. */
  enrichmentAttempts?: number;
  createdAt?: string;
  updatedAt?: string;
}

export function enrichmentOutcome(enrichment: unknown): 'win' | 'loss' | undefined {
  if (typeof enrichment !== 'object' || enrichment === null) return undefined;
  const result = (enrichment as Record<string, unknown>).match_result;
  if (result === 'VICTORY' || result === 'WIN') return 'win';
  if (result === 'DEFEAT' || result === 'LOSS') return 'loss';
  return undefined;
}

function formatDuration(sec: number): string {
  if (sec < 3600) return `${Math.round(sec / 60)} мин`;
  return `${Math.floor(sec / 3600)} ч ${Math.round((sec % 3600) / 60)} мин`;
}

export function formatMatchRow(match: MatchRowInput): { title: string; badge: string } {
  const kda = `${match.kills ?? 0}/${match.deaths ?? 0}/${match.assists ?? 0}`;
  const duration = match.durationSec ? formatDuration(match.durationSec) : '—';
  const date = new Date(match.startedAt).toLocaleString('ru-RU');
  const title = `${date} — ${kda} — ${duration}`;
  const badge = match.enrichmentStatus === 'DONE' ? 'done' : match.enrichmentStatus === 'PENDING' ? 'pending' : 'waiting';
  return { title, badge };
}

export function createMatchesView(options: {
  apiBaseUrl: string;
  defaultSteamId?: string;
  fetchImpl?: typeof fetch;
}): { render: (steamId?: string) => Promise<void>; root: HTMLElement } {
  const fetchImpl = options.fetchImpl ?? ((input: string) => fetch(input));
  const root = document.createElement('div');

  async function render(steamId?: string): Promise<void> {
    root.textContent = 'Загрузка…';
    try {
      const usersResponse = await fetchImpl(`${options.apiBaseUrl}/deadlock/match-history/users`);
      const users = (await usersResponse.json()).users ?? [];
      const selected = steamId ?? options.defaultSteamId ?? users[0]?.steamId;
      const matchesResponse = selected
        ? await fetchImpl(`${options.apiBaseUrl}/deadlock/match-history/users/${selected}/matches`)
        : { json: async () => ({ matches: [] }) } as Response;
      const matches = (await matchesResponse.json()).matches ?? [];

      root.replaceChildren(...buildDom(users, selected, matches));
    } catch {
      root.textContent = 'Не удалось загрузить матчи';
    }
  }

  function buildDom(users: Array<{ steamId: string; playerName?: string }>, selected: string | undefined, matches: MatchRowInput[]): HTMLElement[] {
    const select = document.createElement('select');
    for (const user of users) {
      const option = document.createElement('option');
      option.value = user.steamId;
      option.textContent = user.playerName || user.steamId;
      if (user.steamId === selected) option.selected = true;
      select.append(option);
    }
    select.addEventListener('change', () => { void render(select.value); });

    const list = document.createElement('ul');
    for (const match of matches) {
      const row = formatMatchRow(match);
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.textContent = row.title + (row.badge === 'done' ? ' ✓' : row.badge === 'pending' ? ' …' : '');
      button.addEventListener('click', () => { void showDetail(match); });
      item.append(button);
      list.append(item);
    }
    if (matches.length === 0) {
      const empty = document.createElement('li');
      empty.textContent = 'Матчей пока нет';
      list.append(empty);
    }
    return [select, list];
  }

  async function showDetail(match: MatchRowInput): Promise<void> {
    const back = document.createElement('button');
    back.textContent = '← назад';
    back.addEventListener('click', () => { void render(); });
    const table = document.createElement('table');
    const head = document.createElement('tr');
    for (const label of ['Игрок', 'Герой', 'K/D/A', 'Дамаг', 'Лечение']) {
      const th = document.createElement('th');
      th.textContent = label;
      head.append(th);
    }
    table.append(head);
    for (const player of match.players) {
      const tr = document.createElement('tr');
      const cells = [
        (player.isLocal ? '★ ' : '') + (player.name ?? player.steamId ?? ''),
        player.heroName ?? String(player.heroId ?? '—'),
        `${player.kills ?? 0}/${player.deaths ?? 0}/${player.assists ?? 0}`,
        String(player.heroDamage ?? '—'),
        String(player.healing ?? '—'),
      ];
      for (const cell of cells) {
        const td = document.createElement('td');
        td.textContent = cell;
        tr.append(td);
      }
      table.append(tr);
    }
    root.replaceChildren(back, table);
  }

  return { render, root };
}
