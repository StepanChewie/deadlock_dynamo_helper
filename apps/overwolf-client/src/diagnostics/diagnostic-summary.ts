/**
 * Builds the player-safe diagnostic block used by the "Copy diagnostics" action.
 *
 * The summary is deliberately built from an explicit field allowlist rather than
 * by serialising whatever state happens to be in scope. Raw match events, item
 * payloads and account identifiers must never reach the clipboard, and an
 * allowlist makes that structural instead of a matter of discipline.
 */
export interface DiagnosticSummaryInput {
  readonly appVersion?: string;
  readonly backendStatus?: string;
  readonly gepStatus?: string;
  readonly matchId?: string;
  readonly heroId?: string;
  readonly recommendationStatus?: string;
  readonly archetype?: string;
  readonly rulesetVersion?: string;
  readonly catalogSha256?: string;
  readonly lastRequestId?: string;
  readonly lastError?: string;
  /**
   * Key NAMES only — never values. These two lines exist because the GEP
   * snapshot is the only place that shows whether `match_info` is being
   * delivered at all, and a missing `match_info` silently disables both the
   * overlay and the recommendation without any error anywhere.
   */
  readonly gepPhase?: string;
  readonly gepSnapshot?: string;
  /**
   * Overwolf's own GEP version, reported by `gep_internal.version_info`. Worth
   * surfacing because a game can require a newer GEP than the client ships,
   * and the mismatch shows up only as silently missing features.
   */
  readonly gepVersion?: string;
  /**
   * Feature names the GEP actually bound, as reported by `supportedFeatures`.
   * Recorded because a successful registration call is not proof that every
   * requested feature bound — a feature the game does not expose is simply
   * absent, and the app would otherwise keep reporting the set it asked for.
   */
  readonly gepFeatures?: string;
}

const MAX_VALUE_LENGTH = 160;

const FIELDS: ReadonlyArray<readonly [string, keyof DiagnosticSummaryInput]> = [
  ['App version', 'appVersion'],
  ['Backend status', 'backendStatus'],
  ['GEP status', 'gepStatus'],
  ['Match id', 'matchId'],
  ['Hero id', 'heroId'],
  ['Recommendation status', 'recommendationStatus'],
  ['Archetype', 'archetype'],
  ['Ruleset version', 'rulesetVersion'],
  ['Catalog sha256', 'catalogSha256'],
  ['Last request id', 'lastRequestId'],
  ['Last error', 'lastError'],
  ['GEP phase', 'gepPhase'],
  ['GEP snapshot', 'gepSnapshot'],
  ['GEP version', 'gepVersion'],
  ['GEP features', 'gepFeatures'],
];

function normalize(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  return trimmed.length > MAX_VALUE_LENGTH
    ? `${trimmed.slice(0, MAX_VALUE_LENGTH - 1)}…`
    : trimmed;
}

export function buildDiagnosticSummary(input: DiagnosticSummaryInput): string {
  const lines: string[] = [];

  for (const [label, key] of FIELDS) {
    const value = normalize(input?.[key]);
    if (value !== null) {
      lines.push(`${label}: ${value}`);
    }
  }

  return lines.join('\n');
}
