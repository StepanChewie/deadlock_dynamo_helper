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
      --panel-3: #0d110e;
      --line: #2a332d;
      --text: #ece9df;
      --muted: #929a94;
      --accent: #e0b769;
      --good: #78ca96;
      --good-bg: rgba(120, 202, 150, .08);
      --bad: #dc837c;
      --bad-bg: rgba(220, 131, 124, .08);
      --suppressed: #b7a1d8;
      --suppressed-bg: rgba(183, 161, 216, .09);
      --info: #8fb6cc;
      --info-bg: rgba(143, 182, 204, .08);
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--text); }
    header { border-bottom: 1px solid var(--line); background: #0d100e; position: sticky; top: 0; z-index: 5; }
    .bar { max-width: 1560px; margin: 0 auto; padding: 16px 22px; display: flex; align-items: center; gap: 16px; }
    .brand { font-weight: 900; letter-spacing: -.02em; }
    .brand b { color: var(--accent); }
    #traceRevision { margin-left: auto; color: var(--muted); font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; text-align: right; }
    main { max-width: 1560px; margin: 0 auto; padding: 20px 22px 60px; }
    .login, .toolbar, .panel { border: 1px solid var(--line); background: var(--panel); }
    .login { padding: 16px; display: flex; gap: 10px; align-items: end; }
    label { color: var(--muted); font-size: 11px; display: grid; gap: 6px; flex: 1; text-transform: uppercase; letter-spacing: .05em; }
    input, select, button { font: inherit; color: var(--text); border: 1px solid #39433d; background: #0b0e0c; padding: 9px 11px; }
    input:focus, select:focus, button:focus, a:focus { outline: 2px solid rgba(224, 183, 105, .45); outline-offset: 1px; }
    button { background: var(--accent); color: #15110a; border-color: var(--accent); font-weight: 800; cursor: pointer; }
    button:disabled, select:disabled { opacity: .45; cursor: not-allowed; }
    .toolbar { margin-top: 12px; padding: 12px; display: grid; grid-template-columns: minmax(260px, 1fr) auto; gap: 10px; align-items: end; }
    .layout { margin-top: 12px; display: grid; grid-template-columns: 250px minmax(0, 1fr) 430px; gap: 12px; align-items: start; }
    .panel { min-width: 0; }
    .panel h2 { margin: 0; padding: 12px 14px; border-bottom: 1px solid var(--line); font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
    #stageNavigation { padding: 8px; display: grid; gap: 6px; position: sticky; top: 68px; }
    #traceStages, #fullBuildPanel { padding: 12px; min-height: 420px; }
    #fullBuildPanel { position: sticky; top: 68px; max-height: calc(100vh - 90px); overflow: auto; }
    #debugStatus { color: var(--muted); font-size: 12px; align-self: center; min-width: 180px; }
    .empty, .empty-inline { color: var(--muted); font-size: 12px; line-height: 1.6; }
    .stage-link { display: flex; justify-content: space-between; gap: 8px; color: var(--muted); text-decoration: none; padding: 8px 9px; border: 1px solid transparent; font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .stage-link:hover { color: var(--text); border-color: var(--line); background: var(--panel-2); }
    .stage-link span { min-width: 18px; text-align: center; border-radius: 999px; padding: 1px 5px; background: #2a302b; color: var(--accent); }
    .trace-stage { border: 1px solid var(--line); background: var(--panel-3); margin-bottom: 10px; scroll-margin-top: 78px; }
    .trace-stage > summary { cursor: pointer; list-style: none; display: flex; align-items: center; gap: 10px; padding: 11px 12px; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .trace-stage > summary::-webkit-details-marker { display: none; }
    .trace-stage > summary::before { content: '+'; color: var(--accent); font-weight: 800; width: 12px; }
    .trace-stage[open] > summary::before { content: '-'; }
    .trace-stage[open] > summary { border-bottom: 1px solid var(--line); background: #121712; }
    .summary-counts { margin-left: auto; color: var(--muted); font-size: 10px; }
    .stage-body { padding: 12px; }
    .stage-body h3 { margin: 16px 0 8px; color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .08em; }
    .stage-body h3:first-child { margin-top: 0; }
    .stage-reasons { margin-bottom: 10px; }
    .small-label, .section-caption { color: var(--muted); font-size: 10px; line-height: 1.5; text-transform: uppercase; letter-spacing: .05em; }
    .section-caption { margin-top: 12px; }
    .metric-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 7px; }
    .metric { border: 1px solid var(--line); background: var(--panel-2); padding: 9px; min-width: 0; }
    .metric span { display: block; color: var(--muted); font-size: 9px; text-transform: uppercase; letter-spacing: .05em; }
    .metric strong { display: block; margin-top: 5px; font-size: 12px; overflow-wrap: anywhere; }
    .candidate-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 8px; }
    .candidate, .score-card, .build-step { border: 1px solid var(--line); background: var(--panel-2); padding: 10px; min-width: 0; }
    .candidate.selected { border-color: rgba(120, 202, 150, .58); background: var(--good-bg); }
    .candidate.rejected { border-color: rgba(220, 131, 124, .5); background: var(--bad-bg); }
    .candidate.suppressed { border-color: rgba(183, 161, 216, .55); background: var(--suppressed-bg); }
    .candidate.info { border-color: rgba(143, 182, 204, .42); background: var(--info-bg); }
    .candidate-title { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; font-size: 12px; overflow-wrap: anywhere; }
    .badge { flex: none; border: 1px solid currentColor; border-radius: 999px; padding: 2px 6px; font-size: 8px; font-weight: 900; letter-spacing: .05em; }
    .badge.selected { color: var(--good); }
    .badge.rejected { color: var(--bad); }
    .badge.suppressed { color: var(--suppressed); }
    .badge.info { color: var(--info); }
    .kv { margin: 8px 0 0; display: grid; gap: 4px; }
    .kv > div { display: grid; grid-template-columns: minmax(90px, .8fr) minmax(0, 1.2fr); gap: 8px; padding-top: 4px; border-top: 1px solid rgba(42, 51, 45, .65); }
    .kv dt { color: var(--muted); font-size: 9px; text-transform: uppercase; }
    .kv dd { margin: 0; text-align: right; font-size: 10px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
    .reason-codes { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
    .reason-code, .chip { border: 1px solid #343d37; background: #0d110e; padding: 3px 5px; font: 9px ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
    .reason-code { color: #c8c5b9; }
    .muted-code { color: #646d66; }
    .chips { display: flex; flex-wrap: wrap; gap: 5px; }
    .chip.profile { color: var(--accent); }
    .choice-group { border-left: 2px solid var(--accent); padding-left: 10px; margin-top: 8px; }
    .lock-banner { border: 1px solid rgba(224, 183, 105, .45); background: rgba(224, 183, 105, .07); color: #ded5bd; padding: 9px 10px; margin-bottom: 9px; font-size: 11px; }
    .score-equation { margin-bottom: 9px; border: 1px solid var(--line); background: #0b0e0c; padding: 10px; font: 10px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); }
    .score-equation b { color: var(--text); }
    .score-card { margin-bottom: 8px; }
    .score-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 5px; margin-top: 9px; }
    .score-grid > div { border: 1px solid var(--line); background: #0e120f; padding: 7px; min-width: 0; }
    .score-grid span { display: block; color: var(--muted); font-size: 8px; }
    .score-grid strong { display: block; margin-top: 3px; font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .total-score { color: var(--accent); font: 10px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .build-summary { display: grid; gap: 4px; padding: 10px; border: 1px solid rgba(224, 183, 105, .42); background: rgba(224, 183, 105, .06); font-size: 11px; }
    .build-summary span { color: var(--muted); }
    .build-steps { display: grid; gap: 7px; margin-top: 9px; }
    .build-step-head { display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 7px; align-items: baseline; }
    .build-step-head span { color: var(--accent); font: 10px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .build-step-head strong { font-size: 11px; overflow-wrap: anywhere; }
    .inventory-diff { display: grid; gap: 3px; margin-top: 7px; color: var(--muted); font: 9px ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
    .validation { margin-top: 10px; padding: 10px; border: 1px solid var(--line); font-size: 11px; font-weight: 900; }
    .validation.pass { border-color: rgba(120, 202, 150, .58); color: var(--good); background: var(--good-bg); }
    .validation.fail { border-color: rgba(220, 131, 124, .58); color: var(--bad); background: var(--bad-bg); }
    pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 10px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); }
    @media (max-width: 1180px) {
      .layout { grid-template-columns: 210px minmax(0, 1fr); }
      .layout > aside { grid-column: 1 / -1; }
      #fullBuildPanel { position: static; max-height: none; min-height: 180px; }
    }
    @media (max-width: 820px) {
      .login { align-items: stretch; flex-direction: column; }
      .toolbar, .layout { grid-template-columns: 1fr; }
      #stageNavigation { position: static; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
      #traceStages, #fullBuildPanel { min-height: 180px; }
      .score-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      #traceRevision { display: none; }
    }
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
