import { Controller, Get, Header } from '@nestjs/common';
import { IngestStatusService } from './ingest-status.service';

@Controller('deadlock/admin/ingest')
export class IngestStatusController {
  constructor(private readonly ingestStatusService: IngestStatusService) {}

  @Get('status')
  async getStatus() {
    return this.ingestStatusService.getStatus();
  }

  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  getStatusPage(): string {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Deadlock Ingest Status</title>
    <style>
      body { font-family: sans-serif; margin: 24px; background: #111827; color: #f9fafb; }
      h1, h2 { margin: 0 0 12px; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-bottom: 24px; }
      .card { background: #1f2937; border: 1px solid #374151; border-radius: 10px; padding: 16px; }
      .metric { font-size: 2rem; font-weight: 700; margin-top: 8px; }
      table { width: 100%; border-collapse: collapse; margin-top: 8px; }
      td, th { border-bottom: 1px solid #374151; padding: 8px; text-align: left; vertical-align: top; }
      code { color: #fbbf24; }
    </style>
  </head>
  <body>
    <h1>Deadlock Ingest Status</h1>
    <p>Auto-refresh every 5 seconds.</p>
    <div class="grid" id="metrics"></div>
    <h2>Crawler State</h2>
    <div id="crawler-states"></div>
    <h2>Latest Runs</h2>
    <div id="latest-runs"></div>
    <script>
      async function refresh() {
        const data = await fetch('/deadlock/admin/ingest/status').then((r) => r.json());
        const metrics = [
          ['Matches', data.matchesTotal],
          ['Match Players', data.matchPlayersTotal],
          ['Heroes', data.heroesTotal],
          ['Items', data.itemsTotal],
        ];
        document.getElementById('metrics').innerHTML = metrics.map(([label, value]) =>
          '<div class="card"><div>' + label + '</div><div class="metric">' + value + '</div></div>'
        ).join('');

        document.getElementById('crawler-states').innerHTML = '<table><thead><tr><th>Type</th><th>Running</th><th>Current</th><th>Total</th><th>Current Match</th><th>Status</th><th>Last Success</th><th>Last Error</th></tr></thead><tbody>' +
          data.crawlerStates.map((state) =>
            '<tr><td>' + state.crawlerType + '</td><td>' + state.isCrawling + '</td><td>' + state.current + '</td><td>' + state.total + '</td><td>' + (state.currentMatchId ?? '') + '</td><td>' + state.status + '</td><td>' + (state.lastSuccessAt ?? '') + '</td><td><code>' + (state.lastError ?? '') + '</code></td></tr>'
          ).join('') + '</tbody></table>';

        document.getElementById('latest-runs').innerHTML = '<table><thead><tr><th>Type</th><th>Status</th><th>Discovered</th><th>Processed</th><th>Current Match</th><th>Started</th><th>Finished</th><th>Error</th></tr></thead><tbody>' +
          data.latestRuns.map((run) =>
            '<tr><td>' + run.crawlerType + '</td><td>' + run.status + '</td><td>' + run.discoveredMatches + '</td><td>' + run.processedMatches + '</td><td>' + (run.currentMatchId ?? '') + '</td><td>' + run.startedAt + '</td><td>' + (run.finishedAt ?? '') + '</td><td><code>' + (run.lastError ?? '') + '</code></td></tr>'
          ).join('') + '</tbody></table>';
      }
      refresh();
      setInterval(refresh, 5000);
    </script>
  </body>
</html>`;
  }
}
