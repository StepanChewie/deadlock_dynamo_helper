import { Controller, Get, Header } from '@nestjs/common';

/**
 * The HTML shell stays public on purpose, matching BuildDebugV2Controller: a
 * guarded shell could not be loaded by a browser, so the key prompt below could
 * never run and the tool would be unusable. The shell contains no data -- it is
 * a static template. The two endpoints it reads, /deadlock/live/states and
 * /deadlock/live/events/recent, are themselves guarded in LiveIngestController.
 *
 * The page therefore asks for the internal key and forwards it as a header
 * rather than rendering "HTTP 401/401" forever.
 */
@Controller('deadlock/live')
export class DebugPageController {
  @Get('debug')
  @Header('Content-Type', 'text/html; charset=utf-8')
  getDebugPage(): string {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Deadlock Live Debug</title>
    <style>
      :root {
        color-scheme: dark;
        font-family: Inter, system-ui, sans-serif;
        background: #0b0b0e;
        color: #f3f4f6;
      }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; background: #0b0b0e; }
      header {
        position: sticky;
        top: 0;
        z-index: 2;
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 16px 24px;
        border-bottom: 1px solid #27272f;
        background: rgba(20, 20, 26, 0.96);
      }
      h1 { margin: 0; font-size: 18px; }
      .header-actions { display: flex; align-items: center; gap: 12px; }
      #key-button {
        padding: 5px 10px;
        border: 1px solid #3f3f49;
        border-radius: 7px;
        background: #202028;
        color: #d4d4d8;
        font-size: 12px;
        cursor: pointer;
      }
      #key-button:hover { border-color: #52525b; }
      .status { color: #34d399; font-size: 13px; }
      main {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(320px, 420px);
        gap: 20px;
        padding: 20px;
      }
      section { min-width: 0; }
      .section-title {
        margin-bottom: 10px;
        color: #a1a1aa;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .card, .event {
        margin-bottom: 12px;
        border: 1px solid #27272f;
        border-radius: 10px;
        background: #14141a;
      }
      .card { overflow: hidden; }
      .match-header {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        padding: 14px 16px;
        border-bottom: 1px solid #27272f;
      }
      .muted { color: #a1a1aa; }
      .clock { font-family: ui-monospace, monospace; font-size: 20px; }
      .table-wrap { overflow-x: auto; }
      table { width: 100%; border-collapse: collapse; font-size: 13px; }
      th, td { padding: 10px 12px; border-bottom: 1px solid #22222a; text-align: left; vertical-align: top; }
      th { color: #a1a1aa; font-size: 11px; text-transform: uppercase; }
      tr:last-child td { border-bottom: 0; }
      .items { display: flex; flex-wrap: wrap; gap: 5px; }
      .item {
        padding: 3px 7px;
        border: 1px solid #3f3f49;
        border-radius: 999px;
        background: #202028;
        white-space: nowrap;
      }
      .event { padding: 12px; }
      .event-header { display: flex; justify-content: space-between; gap: 12px; font-size: 12px; color: #a1a1aa; }
      .event-meta { margin-top: 7px; font-size: 12px; color: #d4d4d8; }
      pre {
        max-height: 280px;
        overflow: auto;
        margin: 10px 0 0;
        padding: 10px;
        border-radius: 7px;
        background: #0d0d11;
        color: #d4d4d8;
        font-size: 11px;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .empty {
        padding: 24px;
        border: 1px dashed #3f3f49;
        border-radius: 10px;
        color: #a1a1aa;
        text-align: center;
      }
      @media (max-width: 980px) {
        main { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <header>
      <h1>Deadlock Live Debug</h1>
      <div class="header-actions">
        <button id="key-button" type="button">Set key</button>
        <div class="status" id="status">Polling</div>
      </div>
    </header>
    <main>
      <section>
        <div class="section-title">Match states</div>
        <div id="states"><div class="empty">Waiting for live match state.</div></div>
      </section>
      <section>
        <div class="section-title">Recent events</div>
        <div id="events"><div class="empty">Waiting for events.</div></div>
      </section>
    </main>
    <script>
      function escapeHtml(value) {
        return String(value ?? '')
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;')
          .replaceAll("'", '&#039;');
      }

      function formatTime(seconds) {
        if (!Number.isFinite(seconds)) return '--:--';
        const total = Math.max(0, Math.floor(seconds));
        const hours = Math.floor(total / 3600);
        const minutes = Math.floor((total % 3600) / 60);
        const remainingSeconds = total % 60;
        const pad = (value) => String(value).padStart(2, '0');
        return hours > 0
          ? \`\${pad(hours)}:\${pad(minutes)}:\${pad(remainingSeconds)}\`
          : \`\${pad(minutes)}:\${pad(remainingSeconds)}\`;
      }

      function renderStates(states) {
        const container = document.getElementById('states');
        if (!Array.isArray(states) || states.length === 0) {
          container.innerHTML = '<div class="empty">Waiting for live match state.</div>';
          return;
        }

        container.innerHTML = states.map((match) => {
          const players = Object.values(match.playersBySteamId || {});
          const rows = players.length > 0
            ? players.map((player) => {
                const items = Array.isArray(player.items) && player.items.length > 0
                  ? player.items.map((item) => \`<span class="item">\${escapeHtml(item.name || item.id)}</span>\`).join('')
                  : '<span class="muted">No items</span>';
                const kda = \`\${player.kills ?? 0} / \${player.deaths ?? 0} / \${player.assists ?? 0}\`;
                return \`
                  <tr>
                    <td><strong>\${escapeHtml(player.playerName || 'Player')}</strong><br><span class="muted">\${escapeHtml(player.steamId)}</span></td>
                    <td>\${escapeHtml(player.heroName || player.heroId || 'unassigned')}</td>
                    <td>\${escapeHtml(player.teamId ?? 'unknown')}</td>
                    <td>\${escapeHtml(player.souls ?? '--')}</td>
                    <td>\${escapeHtml(kda)}</td>
                    <td><div class="items">\${items}</div></td>
                  </tr>
                \`;
              }).join('')
            : '<tr><td colspan="6" class="muted">Roster is not available yet.</td></tr>';

          return \`
            <div class="card">
              <div class="match-header">
                <div><strong>\${escapeHtml(match.matchId)}</strong><br><span class="muted">Updated \${escapeHtml(new Date(match.lastUpdatedAt).toLocaleTimeString())}</span></div>
                <div class="clock">\${formatTime(match.gameTimeSec)}</div>
              </div>
              <div class="table-wrap">
                <table>
                  <thead><tr><th>Player</th><th>Hero</th><th>Team</th><th>Souls</th><th>KDA</th><th>Items</th></tr></thead>
                  <tbody>\${rows}</tbody>
                </table>
              </div>
            </div>
          \`;
        }).join('');
      }

      function renderEvents(events) {
        const container = document.getElementById('events');
        if (!Array.isArray(events) || events.length === 0) {
          container.innerHTML = '<div class="empty">Waiting for events.</div>';
          return;
        }

        container.innerHTML = events.slice().reverse().map((event) => {
          let payload;
          try {
            payload = typeof event.payload === 'object'
              ? JSON.stringify(event.payload, null, 2)
              : String(event.payload ?? '');
          } catch {
            payload = String(event.payload ?? '');
          }
          const metadata = [event.feature, event.category, event.key, event.matchId]
            .filter((value) => value !== undefined && value !== null && value !== '')
            .map(escapeHtml)
            .join(' | ');
          return \`
            <div class="event">
              <div class="event-header"><strong>\${escapeHtml(event.source || 'unknown')}</strong><span>\${escapeHtml(new Date(event.receivedAt).toLocaleTimeString())}</span></div>
              <div class="event-meta">\${metadata}</div>
              <pre>\${escapeHtml(payload)}</pre>
            </div>
          \`;
        }).join('');
      }

      const KEY_STORAGE = 'dynamo-internal-key';

      function internalKey() {
        return sessionStorage.getItem(KEY_STORAGE) || '';
      }

      function requestKey() {
        const entered = window.prompt('Internal API key (sent as x-dynamo-internal-key)');
        if (entered === null) return;
        sessionStorage.setItem(KEY_STORAGE, entered.trim());
        void refresh();
      }

      document.getElementById('key-button').addEventListener('click', requestKey);

      async function refresh() {
        const status = document.getElementById('status');
        try {
          const headers = { 'x-dynamo-internal-key': internalKey() };
          const [statesResponse, eventsResponse] = await Promise.all([
            fetch('/deadlock/live/states', { cache: 'no-store', headers }),
            fetch('/deadlock/live/events/recent', { cache: 'no-store', headers }),
          ]);
          if (statesResponse.status === 401 || eventsResponse.status === 401) {
            status.textContent = 'Unauthorized - press "Set key"';
            return;
          }
          if (!statesResponse.ok || !eventsResponse.ok) {
            throw new Error(\`HTTP \${statesResponse.status}/\${eventsResponse.status}\`);
          }
          renderStates(await statesResponse.json());
          renderEvents(await eventsResponse.json());
          status.textContent = 'Polling';
        } catch (error) {
          status.textContent = \`Error: \${error instanceof Error ? error.message : String(error)}\`;
        }
      }

      setInterval(refresh, 1000);
      void refresh();
    </script>
  </body>
</html>`;
  }
}
