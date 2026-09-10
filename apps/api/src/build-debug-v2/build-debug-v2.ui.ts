export const BUILD_DEBUG_V2_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Deadlock Build V2 Debugger</title>
  <style>
    :root {
      color-scheme: dark;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --bg: #090b0a;
      --panel: #111512;
      --panel-2: #171c18;
      --line: #2a332d;
      --text: #ece9df;
      --muted: #929a94;
      --accent: #e0b769;
      --good: #78ca96;
      --bad: #dc837c;
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--text); }
    header { border-bottom: 1px solid var(--line); background: #0d100e; }
    .bar { max-width: 1500px; margin: 0 auto; padding: 16px 22px; display: flex; align-items: center; gap: 16px; }
    .brand { font-weight: 900; letter-spacing: -.02em; }
    .brand b { color: var(--accent); }
    #traceRevision { margin-left: auto; color: var(--muted); font: 12px ui-monospace, monospace; }
    main { max-width: 1500px; margin: 0 auto; padding: 20px 22px 60px; }
    .login, .toolbar, .panel { border: 1px solid var(--line); background: var(--panel); }
    .login { padding: 16px; display: flex; gap: 10px; align-items: end; }
    label { color: var(--muted); font-size: 11px; display: grid; gap: 6px; flex: 1; }
    input, select, button { font: inherit; color: var(--text); border: 1px solid #39433d; background: #0b0e0c; padding: 9px 11px; }
    button { background: var(--accent); color: #15110a; border-color: var(--accent); font-weight: 800; cursor: pointer; }
    .toolbar { margin-top: 12px; padding: 12px; display: grid; grid-template-columns: minmax(260px, 1fr) auto; gap: 10px; align-items: end; }
    .layout { margin-top: 12px; display: grid; grid-template-columns: 260px minmax(0, 1fr) 390px; gap: 12px; }
    .panel h2 { margin: 0; padding: 12px 14px; border-bottom: 1px solid var(--line); font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
    #traceStages, #fullBuildPanel { padding: 12px; min-height: 420px; }
    #stageNavigation { padding: 8px; display: grid; gap: 6px; }
    .empty { color: var(--muted); font-size: 12px; line-height: 1.6; }
    #debugStatus { color: var(--muted); font-size: 12px; align-self: center; }
    @media (max-width: 1050px) { .layout { grid-template-columns: 1fr; } #traceStages, #fullBuildPanel { min-height: 180px; } }
  </style>
  <script src="/debug/build-v2/client.js" defer></script>
</head>
<body>
  <header>
    <div class="bar">
      <div class="brand">DEADLOCK BUILD <b>V2</b> DEBUGGER</div>
      <div id="traceRevision">revision: -</div>
    </div>
  </header>
  <main>
    <form id="debugLoginForm" class="login" autocomplete="off">
      <label>Production debug password
        <input id="debugPassword" type="password" autocomplete="current-password" required />
      </label>
      <button type="submit">Unlock debugger</button>
      <div id="debugStatus">Not authenticated</div>
    </form>

    <section class="toolbar">
      <label>Active match
        <select id="activeMatchSelect" disabled>
          <option value="">Select matchId</option>
        </select>
      </label>
      <button id="refreshMatches" type="button" disabled>Refresh</button>
    </section>

    <section class="layout">
      <nav class="panel" aria-label="Decision trace stages">
        <h2>Pipeline stages</h2>
        <div id="stageNavigation" class="empty">Authenticate and select a match.</div>
      </nav>
      <section class="panel">
        <h2>Decision trace</h2>
        <div id="traceStages" class="empty">No trace selected.</div>
      </section>
      <aside class="panel">
        <h2>Full lifetime build</h2>
        <div id="fullBuildPanel" class="empty">No full build selected.</div>
      </aside>
    </section>
  </main>
</body>
</html>`;
