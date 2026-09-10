export const BUILD_DEBUG_V2_CLIENT_JS = String.raw`(() => {
  'use strict';

  const form = document.getElementById('debugLoginForm');
  const password = document.getElementById('debugPassword');
  const status = document.getElementById('debugStatus');
  const matchSelect = document.getElementById('activeMatchSelect');
  const refreshButton = document.getElementById('refreshMatches');
  let stream;

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
  matchSelect?.addEventListener('change', () => {
    const matchId = matchSelect.value;
    if (!matchId) return;
    openStream(matchId);
  });

  async function refreshMatches() {
    const response = await fetch('/debug/build-v2/matches');
    if (!response.ok) return;
    const matches = await response.json();
    matchSelect.innerHTML = '<option value="">Select matchId</option>';
    for (const match of matches) {
      const option = document.createElement('option');
      option.value = match.matchId;
      option.textContent = match.matchId;
      matchSelect.appendChild(option);
    }
  }

  function openStream(matchId) {
    stream?.close();
    stream = new EventSource('/debug/build-v2/matches/' + encodeURIComponent(matchId) + '/stream');
  }
})();`;
