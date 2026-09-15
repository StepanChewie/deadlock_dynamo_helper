import { buildDiagnosticSummary } from './diagnostic-summary';

const fullInput = {
  appVersion: '0.1.15',
  backendStatus: 'READY',
  gepStatus: 'REGISTERED',
  matchId: 'match-1',
  heroId: '7',
  recommendationStatus: 'READY',
  archetype: 'weapon-spirit',
  rulesetVersion: '2026-09-14',
  catalogSha256: 'abc',
  lastRequestId: 'req-1',
  lastError: undefined,
};

it('summarises identity and status without raw telemetry', () => {
  const summary = buildDiagnosticSummary(fullInput);

  expect(summary).toContain('App version: 0.1.15');
  expect(summary).toContain('Recommendation status: READY');
  expect(summary).not.toContain('rawPayload');
});

it('renders one line per populated field', () => {
  const summary = buildDiagnosticSummary(fullInput);

  expect(summary.split('\n')).toHaveLength(10);
  expect(summary).toContain('GEP status: REGISTERED');
  expect(summary).toContain('Archetype: weapon-spirit');
});

it('drops fields that are absent or blank', () => {
  const summary = buildDiagnosticSummary({
    appVersion: '0.1.15',
    recommendationStatus: 'NOT_READY',
    matchId: '   ',
    lastError: undefined,
  });

  expect(summary).toBe('App version: 0.1.15\nRecommendation status: NOT_READY');
  expect(summary).not.toContain('Match id');
});

it('never echoes properties it was not asked for', () => {
  const summary = buildDiagnosticSummary({
    appVersion: '0.1.15',
    recommendationStatus: 'READY',
    rawPayload: { items: [1, 2, 3] },
    steamId: '76561198000000000',
  } as never);

  expect(summary).not.toContain('rawPayload');
  expect(summary).not.toContain('items');
  expect(summary).not.toContain('76561198000000000');
});

it('bounds a long error message', () => {
  const summary = buildDiagnosticSummary({
    appVersion: '0.1.15',
    recommendationStatus: 'NOT_READY',
    lastError: 'x'.repeat(500),
  });

  const errorLine = summary.split('\n').find((line) => line.startsWith('Last error: '));
  expect(errorLine).toBeDefined();
  expect(errorLine!.length).toBeLessThan(200);
  expect(errorLine).toContain('…');
});
