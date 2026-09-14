export const BUILD_DEBUG_V2_CLIENT_JS = String.raw`(() => {
  'use strict';

  const form = document.getElementById('debugLoginForm');
  const password = document.getElementById('debugPassword');
  const status = document.getElementById('debugStatus');
  const matchSelect = document.getElementById('activeMatchSelect');
  const refreshButton = document.getElementById('refreshMatches');
  const stageNavigation = document.getElementById('stageNavigation');
  const traceStages = document.getElementById('traceStages');
  const fullBuildPanel = document.getElementById('fullBuildPanel');
  const traceRevision = document.getElementById('traceRevision');

  const MAX_SSE_RECONNECT_ATTEMPTS = 5;
  const SSE_RECONNECT_BASE_DELAY_MS = 500;
  const SSE_RECONNECT_MAX_DELAY_MS = 8000;

  let stream;
  let reconnectTimer;
  let reconnectAttempts = 0;
  let currentMatchId = '';
  let currentSteamId = '';

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    status.textContent = 'Authenticating...';
    const response = await fetch('/debug/build-v2/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: password.value }),
    });
    password.value = '';
    if (!response.ok) {
      status.textContent = 'Authentication failed';
      return;
    }
    status.textContent = 'Authenticated';
    matchSelect.disabled = false;
    refreshButton.disabled = false;
    await refreshMatches();
  });

  refreshButton?.addEventListener('click', refreshMatches);
  matchSelect?.addEventListener('change', async () => {
    const selection = parseMatchSelection(matchSelect.value);
    if (!selection.matchId) {
      closeStream();
      currentMatchId = '';
      currentSteamId = '';
      clearTrace();
      return;
    }
    await selectMatch(selection.matchId, selection.steamId);
  });

  async function refreshMatches() {
    const previousSelection = matchSelect.value;
    const response = await fetch('/debug/build-v2/matches');
    if (response.status === 401) {
      status.textContent = 'Session expired. Authenticate again.';
      matchSelect.disabled = true;
      refreshButton.disabled = true;
      closeStream();
      return;
    }
    if (!response.ok) {
      status.textContent = 'Failed to load active matches';
      return;
    }
    const matches = await response.json();
    matchSelect.innerHTML = '<option value="">Select match</option>';
    for (const match of matches) {
      const steamId = typeof match.steamId === 'string' ? match.steamId : '';
      const option = document.createElement('option');
      option.value = formatMatchSelection(match.matchId, steamId);
      option.textContent = match.matchId + ' - player ' + (steamId || 'unknown') + ' - revision ' + match.revision;
      matchSelect.appendChild(option);
    }
    if (previousSelection && matches.some((match) =>
      formatMatchSelection(match.matchId, typeof match.steamId === 'string' ? match.steamId : '') === previousSelection)) {
      matchSelect.value = previousSelection;
    }
    status.textContent = matches.length ? 'Active matches loaded: ' + matches.length : 'No active matches';
  }

  async function selectMatch(matchId, steamId) {
    closeStream();
    currentMatchId = matchId;
    currentSteamId = steamId || '';
    reconnectAttempts = 0;
    status.textContent = 'Loading snapshot for ' + matchId + '...';
    const loaded = await loadSnapshot(matchId, steamId);
    if (!loaded || !isCurrentSelection(matchId, steamId)) return;
    connectStream(matchId, steamId);
  }

  async function loadSnapshot(matchId, steamId) {
    const response = await fetch('/debug/build-v2/matches/' + encodeURIComponent(matchId) +
      '?steamId=' + encodeURIComponent(steamId || ''));
    if (response.status === 401) {
      status.textContent = 'Session expired. Authenticate again.';
      return false;
    }
    if (!response.ok) {
      status.textContent = 'Failed to load snapshot for ' + matchId;
      return false;
    }
    const trace = await response.json();
    if (!isCurrentSelection(matchId, steamId)) return false;
    renderTrace(trace);
    status.textContent = 'Snapshot loaded. Opening realtime stream...';
    return true;
  }

  function connectStream(matchId, steamId) {
    if (!isCurrentSelection(matchId, steamId)) return;
    const source = new EventSource('/debug/build-v2/matches/' + encodeURIComponent(matchId) +
      '/stream?steamId=' + encodeURIComponent(steamId || ''));
    stream = source;

    source.onopen = () => {
      if (stream !== source || !isCurrentSelection(matchId, steamId)) return;
      status.textContent = 'Realtime trace connected';
    };

    source.addEventListener('trace', (event) => {
      if (stream !== source || !isCurrentSelection(matchId, steamId)) return;
      try {
        const trace = JSON.parse(event.data);
        if (!trace || trace.matchId !== matchId) return;
        reconnectAttempts = 0;
        renderTrace(trace);
        status.textContent = 'Realtime revision ' + trace.revision;
      } catch (_error) {
        status.textContent = 'Received invalid trace payload';
      }
    });

    source.onerror = () => {
      if (stream !== source || !isCurrentSelection(matchId, steamId)) return;
      source.close();
      if (stream === source) stream = undefined;
      if (reconnectAttempts >= MAX_SSE_RECONNECT_ATTEMPTS) {
        status.textContent = 'SSE reconnect limit reached. Re-select the match or refresh.';
        return;
      }
      const delay = Math.min(
        SSE_RECONNECT_BASE_DELAY_MS * Math.pow(2, reconnectAttempts),
        SSE_RECONNECT_MAX_DELAY_MS,
      );
      reconnectAttempts += 1;
      status.textContent = 'SSE disconnected. Reconnecting ' + reconnectAttempts + '/' + MAX_SSE_RECONNECT_ATTEMPTS + '...';
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        if (isCurrentSelection(matchId, steamId)) connectStream(matchId, steamId);
      }, delay);
    };
  }

  function closeStream() {
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    stream?.close();
    stream = undefined;
  }

  function clearTrace() {
    traceRevision.textContent = 'revision: -';
    stageNavigation.innerHTML = 'Select a match to inspect its pipeline.';
    traceStages.innerHTML = 'No trace selected.';
    fullBuildPanel.innerHTML = 'No full build selected.';
  }

  function renderTrace(trace) {
    const openSections = captureOpenSections();
    traceRevision.textContent = 'revision: ' + trace.revision + ' | state: ' + trace.stateRevision + ' | ' + trace.generatedAt;
    stageNavigation.innerHTML = trace.stages.map(renderNavigationEntry).join('');
    traceStages.innerHTML = trace.stages.map(renderStage).join('');
    fullBuildPanel.innerHTML = renderFullBuild(trace);
    restoreOpenSections(openSections);
  }

  function captureOpenSections() {
    const openSections = [];
    const details = document.querySelectorAll('details[data-debug-section][open]');
    for (const detail of details) {
      const key = detail.getAttribute('data-debug-section');
      if (key) openSections.push(key);
    }
    return openSections;
  }

  function restoreOpenSections(openSections) {
    for (const key of openSections) {
      const detail = document.getElementById('trace-section-' + key);
      if (detail) detail.open = true;
    }
  }

  function renderNavigationEntry(entry) {
    return '<a class="stage-link" href="#trace-section-' + escapeHtml(entry.stage) + '">' +
      escapeHtml(entry.stage) + reasonCount(entry) + '</a>';
  }

  function reasonCount(entry) {
    const count = Array.isArray(entry.reasonCodes) ? entry.reasonCodes.length : 0;
    return count ? '<span>' + count + '</span>' : '';
  }

  function renderStage(entry) {
    const defaultOpen = entry.stage === 'ARCHETYPE_SELECTION' || entry.stage === 'CHOICE_RESOLUTION' ||
      entry.stage === 'DESIRED_STATE' || entry.stage === 'SEMANTIC_VALIDATION' ||
      entry.stage === 'ITEM_SCORING' || entry.stage === 'FINAL_PLAN';
    return '<details id="trace-section-' + escapeHtml(entry.stage) + '" data-debug-section="' +
      escapeHtml(entry.stage) + '" class="trace-stage"' + (defaultOpen ? ' open' : '') + '>' +
      '<summary><strong>' + escapeHtml(entry.stage) + '</strong>' + dispositionSummary(entry.payload) + '</summary>' +
      '<div class="stage-body">' + renderStageReasonCodes(entry.reasonCodes) + renderStagePayload(entry) + '</div>' +
      '</details>';
  }

  function dispositionSummary(payload) {
    const candidates = payload && Array.isArray(payload.candidates) ? payload.candidates : [];
    const selected = candidates.filter((candidate) => candidate.disposition === 'SELECTED').length;
    const rejected = candidates.filter((candidate) => candidate.disposition === 'REJECTED').length;
    const suppressed = candidates.filter((candidate) => candidate.disposition === 'SUPPRESSED_BY_HYSTERESIS').length;
    if (!selected && !rejected && !suppressed) return '';
    return '<span class="summary-counts">selected ' + selected + ' / rejected ' + rejected + ' / suppressed ' + suppressed + '</span>';
  }

  function renderStagePayload(entry) {
    const payload = entry.payload || {};
    switch (entry.stage) {
      case 'SOURCE':
        return renderSource(payload);
      case 'ARCHETYPE_MINING':
        return renderArchetypeMining(payload);
      case 'ARCHETYPE_QUALITY_GATE':
        return renderQualityGate(payload);
      case 'ARCHETYPE_SELECTION':
        return renderArchetypeSelection(payload);
      case 'LIVE_CONTEXT':
        return renderLiveContext(payload);
      case 'CANDIDATE_DISCOVERY':
        return renderCandidateDiscovery(payload);
      case 'CHOICE_RESOLUTION':
        return renderChoiceResolution(payload);
      case 'DESIRED_STATE':
        return renderDesiredState(payload);
      case 'ITEM_SCORING':
        return renderItemScoring(payload);
      case 'PLAN_SEARCH':
        return renderPlanSearch(payload);
      case 'REPLACEMENT_SEARCH':
        return renderReplacementSearch(payload);
      case 'SEMANTIC_VALIDATION':
        return renderSemanticValidation(payload);
      case 'FINAL_PLAN':
        return renderFinalPlan(payload);
      default:
        return '<pre>' + escapeHtml(JSON.stringify(payload, null, 2)) + '</pre>';
    }
  }

  function renderSource(payload) {
    return '<div class="metric-grid">' +
      metric('Hero', payload.heroId) +
      metric('Statlocker patch', payload.statlockerPatchId || 'unknown') +
      metric('Top profiles', payload.profileCount) +
      metric('VS_HERO_WPA rows', valueOrDash(payload.wpaRowCount)) +
      metric('T4 chains', payload.t4Available === undefined ? 'unknown' : payload.t4Available ? 'available' : 'unavailable') +
      '</div>' +
      '<h3>Statlocker top-10 profiles</h3>' + chipList(payload.profileAccountIds || [], 'profile');
  }

  function renderArchetypeMining(payload) {
    return '<h3>Accepted and rejected archetype candidates</h3>' + cards(
      payload.candidates || [],
      (candidate) => renderCandidateCard(candidate, [
        ['profiles', (candidate.profileAccountIds || []).join(', ')],
        ['support', formatNumber(candidate.support)],
        ['coherence', formatNumber(candidate.coherence)],
        ['separation', formatNumber(candidate.separation)],
      ]),
    );
  }

  function renderQualityGate(payload) {
    return '<h3>Semantic quality gate</h3>' + cards(
      payload.results || [],
      (result) => '<article class="candidate ' + (result.accepted ? 'selected' : 'rejected') + '">' +
        '<div class="candidate-title"><strong>' + escapeHtml(result.archetypeId) + '</strong>' +
        dispositionBadge(result.accepted ? 'SELECTED' : 'REJECTED') + '</div>' +
        '<div class="small-label">quality gate: ' + (result.accepted ? 'PASS' : 'REJECTED') + '</div>' +
        reasonCodes(result.reasonCodes) + '</article>',
    );
  }

  function renderArchetypeSelection(payload) {
    return '<div class="lock-banner">Selected / locked archetype: <strong>' +
      escapeHtml(payload.selectedArchetypeId || 'none') + '</strong></div>' +
      '<div class="metric-grid">' +
      metric('Enemy roster', (payload.enemyHeroIds || []).join(', ')) +
      metric('WPA query count', payload.wpaQueryCount) +
      metric('Fallback used', payload.fallbackUsed ? 'yes' : 'no') +
      '</div>' +
      '<h3>WPA archetype selection</h3>' + cards(payload.candidates || [], renderCandidateCard);
  }

  function renderLiveContext(payload) {
    const threats = payload.enemyThreats || [];
    return '<div class="metric-grid">' +
      metric('Game time', formatDuration(payload.gameTimeSec)) +
      metric('Inventory', (payload.inventoryItemIds || []).join(', ') || 'empty') +
      metric('Capacity', payload.capacity) +
      '</div>' +
      '<h3>Live enemy threat</h3>' + cards(threats, (threat) =>
        '<article class="candidate info"><div class="candidate-title"><strong>Hero ' + escapeHtml(threat.heroId) + '</strong></div>' +
        keyValueRows([
          ['threat multiplier', formatNumber(threat.threatMultiplier)],
          ['completeness', formatPercent(threat.completeness)],
        ]) + reasonCodes(threat.reasonCodes) + '</article>');
  }

  function renderCandidateDiscovery(payload) {
    return '<h3>Locked and outside-archetype candidates</h3>' + cards(
      payload.candidates || [],
      (candidate) => renderCandidateCard(candidate, [
        ['source', candidate.insideLockedArchetype ? 'LOCKED ARCHETYPE' : 'OUTSIDE ARCHETYPE'],
      ]),
    );
  }

  function renderChoiceResolution(payload) {
    const groups = payload.groups || [];
    if (!groups.length) return '<div class="empty-inline">No CHOICE/OR groups in this revision.</div>';
    return groups.map((group) => {
      const candidateLabels = (group.candidates || []).map((candidate) => candidate.candidateId || ('item ' + candidate.itemId));
      const choiceLabel = candidateLabels.length ? candidateLabels.join(' OR ') : humanize(group.groupId);
      return '<section class="choice-group"><h3>' + escapeHtml(choiceLabel) + '</h3>' +
        '<div class="small-label">group ' + escapeHtml(humanize(group.groupId)) +
        ' | select ' + escapeHtml(group.minSelect) + '..' + escapeHtml(group.maxSelect) +
        ' | selected items ' + escapeHtml((group.selectedItemIds || []).join(', ') || 'none') + '</div>' +
        cards(group.candidates || [], renderCandidateCard) + '</section>';
    }).join('');
  }

  function renderDesiredState(payload) {
    const families = payload.families || [];
    const choiceGroups = payload.selectedChoiceFamilyIdsByGroup || {};
    return '<div class="score-equation">Desired build state | REQUIRED / CHOICE / OPTIONAL / SITUATIONAL</div>' +
      '<h3>Family progression</h3>' + cards(families, (family) => {
        const terminalDecision = family.selectedTerminalKind === 'OPTIONAL_TERMINAL'
          ? 'Optional terminal WPA decision'
          : 'Default terminal';
        return '<article class="candidate selected">' +
          '<div class="candidate-title"><strong>Family ' + escapeHtml(family.familyId) + '</strong>' +
          '<span class="badge selected">' + escapeHtml(family.requirement) + '</span></div>' +
          keyValueRows([
            ['group', family.groupId],
            [terminalDecision, family.selectedTerminalItemId],
            ['terminal kind', family.selectedTerminalKind],
            ['score', formatNumber(family.score)],
            ['confidence', formatPercent(family.confidence)],
          ]) + reasonCodes(family.reasonCodes) + '</article>';
      }) +
      '<h3>Selected CHOICE families</h3>' + renderChoiceFamilyMap(choiceGroups) +
      '<h3>Desired-state reason codes</h3>' + reasonCodes(payload.reasonCodes);
  }

  function renderChoiceFamilyMap(choiceGroups) {
    const entries = Object.entries(choiceGroups || {});
    if (!entries.length) return '<div class="empty-inline">No selected CHOICE families.</div>';
    return cards(entries, ([groupId, familyIds]) =>
      '<article class="candidate info"><div class="candidate-title"><strong>' + escapeHtml(groupId) + '</strong></div>' +
      keyValueRows([['selected family IDs', (familyIds || []).join(', ')]]) + '</article>');
  }

  function renderItemScoring(payload) {
    const items = payload.items || [];
    if (!items.length) return '<div class="empty-inline">No item score rows.</div>';
    return '<div class="score-equation">ITEM UTILITY = <b>STRUCTURE</b> + <b>MATCHUP</b> + <b>PROGRESSION</b> - <b>TRANSITION</b></div>' +
      items.map((item) => '<article class="score-card">' +
        '<div class="candidate-title"><strong>Item ' + escapeHtml(item.itemId) + '</strong><span class="total-score">total ' +
        escapeHtml(formatNumber(item.total)) + '</span></div>' +
        '<div class="score-grid">' +
        scoreLayer('STRUCTURE', item.layers?.structure) +
        scoreLayer('MATCHUP', item.layers?.matchup) +
        scoreLayer('PROGRESSION', item.layers?.progression) +
        scoreLayer('TRANSITION', item.layers?.transition) +
        '</div>' +
        keyValueRows([['confidence', formatPercent(item.confidence)]]) +
        reasonCodes(item.reasonCodes) + '</article>').join('');
  }

  function renderPlanSearch(payload) {
    const branches = payload.branches || [];
    const hysteresis = payload.hysteresis;
    return '<h3>Plan-search branches</h3>' + cards(branches, (branch) =>
      '<article class="candidate ' + dispositionClass(branch.disposition) + '">' +
      '<div class="candidate-title"><strong>#' + escapeHtml(branch.sequence) + ' ' + escapeHtml(branch.action || 'ACTION') +
      ' item ' + escapeHtml(branch.targetItemId) + '</strong>' + dispositionBadge(branch.disposition) + '</div>' +
      keyValueRows([['score', valueOrDash(branch.score)]]) + reasonCodes(branch.reasonCodes) + '</article>') +
      (hysteresis ? '<h3>Hysteresis</h3><article class="candidate ' +
        (hysteresis.action === 'KEEP_PREVIOUS' ? 'suppressed' : 'selected') + '">' +
        '<div class="candidate-title"><strong>' + escapeHtml(hysteresis.action) + '</strong>' +
        dispositionBadge(hysteresis.action === 'KEEP_PREVIOUS' ? 'SUPPRESSED_BY_HYSTERESIS' : 'SELECTED') + '</div>' +
        keyValueRows([
          ['improvement', formatNumber(hysteresis.improvement)],
          ['required improvement', formatNumber(hysteresis.requiredImprovement)],
        ]) + reasonCodes(hysteresis.reasonCodes) + '</article>' : '');
  }

  function renderReplacementSearch(payload) {
    const candidates = payload.candidates || [];
    return '<div class="lock-banner">Replacement target: BUY ' + escapeHtml(payload.targetItemId) + '</div>' +
      '<h3>Replacement candidates</h3>' + cards(candidates, (candidate) =>
        '<article class="candidate ' + dispositionClass(candidate.disposition) + '">' +
        '<div class="candidate-title"><strong>SELL ' + escapeHtml(candidate.sellItemId) + ' -> BUY ' +
        escapeHtml(candidate.buyItemId) + '</strong>' + dispositionBadge(candidate.disposition) + '</div>' +
        keyValueRows([
          ['marginal gain', formatNumber(candidate.marginalGain)],
          ['required improvement', formatNumber(candidate.requiredImprovement)],
        ]) + reasonCodes(candidate.reasonCodes) + '</article>');
  }

  function renderSemanticValidation(payload) {
    const states = payload.finalFamilyStates || [];
    return '<div class="validation ' + (payload.valid ? 'pass' : 'fail') + '">Semantic validation: ' +
      (payload.valid ? 'PASS' : 'FAIL') + '</div>' +
      '<h3>Family progression</h3>' + cards(states, (state) =>
        '<article class="candidate ' + (state.status === 'UNSATISFIED' ? 'rejected' : 'selected') + '">' +
        '<div class="candidate-title"><strong>Family ' + escapeHtml(state.familyId) + '</strong>' +
        '<span class="badge ' + (state.status === 'UNSATISFIED' ? 'rejected' : 'selected') + '">' + escapeHtml(state.status) + '</span></div>' +
        keyValueRows([
          ['current items', (state.currentItemIds || []).join(', ') || 'none'],
          ['terminal item', state.terminalItemId],
        ]) + '</article>') +
      '<h3>Anti-churn / family-regression rejection</h3>' + reasonCodes(payload.reasonCodes);
  }

  function renderFinalPlan(payload) {
    return '<div class="metric-grid">' +
      metric('Plan revision', payload.planRevision) +
      metric('Lifetime steps', payload.stepCount) +
      metric('Inventory validation', payload.valid ? 'PASS' : 'FAIL') +
      '</div>' +
      '<h3>Degraded evidence</h3>' + reasonCodes(payload.degradedReasons) +
      '<h3>Validation reason codes</h3>' + reasonCodes(payload.validationReasonCodes);
  }

  function renderCandidateCard(candidate, extraRows) {
    const rows = [
      ['item', candidate.itemId === undefined ? undefined : candidate.itemId],
      ['archetype', candidate.archetypeId],
      ['score', candidate.score === undefined ? undefined : formatNumber(candidate.score)],
      ['confidence', candidate.confidence === undefined ? undefined : formatPercent(candidate.confidence)],
      ['coverage', candidate.coverage === undefined ? undefined : formatPercent(candidate.coverage)],
      ['sample count', candidate.sampleCount],
    ];
    if (Array.isArray(extraRows)) rows.push(...extraRows);
    return '<article class="candidate ' + dispositionClass(candidate.disposition) + '">' +
      '<div class="candidate-title"><strong>' + escapeHtml(candidate.candidateId || 'candidate') + '</strong>' +
      dispositionBadge(candidate.disposition) + '</div>' +
      keyValueRows(rows) + reasonCodes(candidate.reasonCodes) + '</article>';
  }

  function renderFullBuild(trace) {
    const plan = trace.finalPlan;
    if (!plan) return '<div class="empty-inline">This trace has no resolved full plan.</div>';
    const steps = plan.steps || [];
    const mechanicalValidation = plan.mechanicalValidation || plan.validation || { valid: false, reasonCodes: [] };
    const semanticValidation = plan.semanticValidation;
    return '<div class="build-summary">' +
      '<strong>' + escapeHtml(plan.planRevision) + '</strong>' +
      '<span>archetype ' + escapeHtml(plan.archetypeId) + '</span>' +
      '<span>' + escapeHtml(steps.length) + ' lifetime steps</span>' +
      '</div>' +
      '<div class="build-steps">' + steps.map(renderBuildStep).join('') + '</div>' +
      (plan.desiredState ? '<div class="section-caption">Desired build state</div>' + renderDesiredState(plan.desiredState) : '') +
      '<div class="validation ' + (mechanicalValidation.valid ? 'pass' : 'fail') + '">Inventory simulation: ' +
      (mechanicalValidation.valid ? 'PASS' : 'FAIL') + '</div>' +
      '<div class="section-caption">Mechanical validation reason codes</div>' + reasonCodes(mechanicalValidation.reasonCodes || []) +
      (semanticValidation ? '<div class="section-caption">Semantic validation</div>' + renderSemanticValidation(semanticValidation) : '') +
      '<div class="validation ' + (plan.validation?.valid ? 'pass' : 'fail') + '">Combined validation: ' +
      (plan.validation?.valid ? 'PASS' : 'FAIL') + '</div>' +
      '<div class="section-caption">Validation reason codes</div>' + reasonCodes(plan.validation?.reasonCodes || []) +
      '<div class="section-caption">Degraded evidence</div>' + reasonCodes(plan.degradedReasons || []);
  }

  function renderBuildStep(step) {
    let actionText = step.action + ' ' + step.buyItemId;
    if (step.action === 'REPLACE') actionText = 'REPLACE | SELL ' + step.sellItemId + ' -> BUY ' + step.buyItemId;
    if (step.action === 'UPGRADE') actionText = 'UPGRADE | BUY ' + step.buyItemId + ' | recipe ' + (step.recipeId || 'unknown');
    return '<article class="build-step">' +
      '<div class="build-step-head"><span>#' + escapeHtml(step.sequence) + '</span><strong>' + escapeHtml(actionText) + '</strong></div>' +
      (step.consumedItemIds?.length ? '<div class="small-label">consumes: ' + escapeHtml(step.consumedItemIds.join(', ')) + '</div>' : '') +
      '<div class="inventory-diff"><span>before [' + escapeHtml((step.inventoryBefore || []).join(', ')) + ']</span>' +
      '<span>after [' + escapeHtml((step.inventoryAfter || []).join(', ')) + ']</span></div>' +
      reasonCodes(step.reasonCodes) + '</article>';
  }

  function renderStageReasonCodes(codes) {
    if (!codes || !codes.length) return '';
    return '<div class="stage-reasons"><span class="small-label">Stage reason codes</span>' + reasonCodes(codes) + '</div>';
  }

  function cards(values, renderer) {
    if (!values || !values.length) return '<div class="empty-inline">No entries.</div>';
    return '<div class="candidate-grid">' + values.map(renderer).join('') + '</div>';
  }

  function metric(label, value) {
    return '<div class="metric"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(valueOrDash(value)) + '</strong></div>';
  }

  function keyValueRows(rows) {
    const visibleRows = rows.filter((row) => row[1] !== undefined && row[1] !== null && row[1] !== '');
    if (!visibleRows.length) return '';
    return '<dl class="kv">' + visibleRows.map((row) => '<div><dt>' + escapeHtml(row[0]) + '</dt><dd>' +
      escapeHtml(valueOrDash(row[1])) + '</dd></div>').join('') + '</dl>';
  }

  function scoreLayer(label, value) {
    return '<div><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(formatNumber(value)) + '</strong></div>';
  }

  function chipList(values, className) {
    if (!values || !values.length) return '<div class="empty-inline">none</div>';
    return '<div class="chips">' + values.map((value) => '<span class="chip ' + escapeHtml(className || '') + '">' +
      escapeHtml(value) + '</span>').join('') + '</div>';
  }

  function reasonCodes(codes) {
    if (!codes || !codes.length) return '<div class="reason-codes"><span class="reason-code muted-code">NO_REASON_CODES</span></div>';
    return '<div class="reason-codes">' + codes.map((code) => '<span class="reason-code">' + escapeHtml(code) + '</span>').join('') + '</div>';
  }

  function dispositionBadge(disposition) {
    const normalized = disposition || 'INFO';
    return '<span class="badge ' + dispositionClass(normalized) + '">' + escapeHtml(normalized) + '</span>';
  }

  function dispositionClass(disposition) {
    if (disposition === 'SELECTED') return 'selected';
    if (disposition === 'REJECTED') return 'rejected';
    if (disposition === 'SUPPRESSED_BY_HYSTERESIS') return 'suppressed';
    return 'info';
  }

  function formatNumber(value) {
    if (value === undefined || value === null || value === '') return '-';
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(3) : String(value);
  }

  function formatPercent(value) {
    if (value === undefined || value === null || value === '') return '-';
    const number = Number(value);
    return Number.isFinite(number) ? (number * 100).toFixed(1) + '%' : String(value);
  }

  function formatDuration(seconds) {
    const value = Number(seconds);
    if (!Number.isFinite(value)) return valueOrDash(seconds);
    const minutes = Math.floor(value / 60);
    const remainder = Math.floor(value % 60);
    return minutes + ':' + String(remainder).padStart(2, '0');
  }

  function valueOrDash(value) {
    return value === undefined || value === null || value === '' ? '-' : String(value);
  }

  function humanize(value) {
    return String(value || '').replace(/_/g, ' ');
  }

  function formatMatchSelection(matchId, steamId) {
    return JSON.stringify([matchId, steamId || '']);
  }

  function isCurrentSelection(matchId, steamId) {
    return currentMatchId === matchId && currentSteamId === (steamId || '');
  }

  function parseMatchSelection(value) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed) && typeof parsed[0] === 'string') {
        return { matchId: parsed[0], steamId: typeof parsed[1] === 'string' ? parsed[1] : '' };
      }
    } catch (_error) {
      // Fall through to legacy bare matchId values.
    }
    return { matchId: value, steamId: '' };
  }

  function escapeHtml(value) {
    return valueOrDash(value).replace(/[&<>"']/g, (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[character]);
  }
})();`;