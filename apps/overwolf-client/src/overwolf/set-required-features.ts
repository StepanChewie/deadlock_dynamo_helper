/**
 * GEP feature registration.
 *
 * Overwolf only delivers game data for features the app explicitly asks for,
 * and the registration call is documented to fail intermittently — especially
 * when it races the game launch — so the caller retries it.
 */

/** Features the recommendation pipeline cannot run without. */
const CORE_FEATURES = ['game_info', 'match_info'];

/**
 * Diagnostics-only. `gep_internal` carries `version_info`, the sole source for
 * `readGepVersion()`. It is requested alongside the core features but never at
 * their expense: a GEP that does not expose it must not cost us game data.
 */
const OPTIONAL_FEATURES = ['gep_internal'];

export const REQUIRED_FEATURES = [...CORE_FEATURES, ...OPTIONAL_FEATURES];

export interface RequiredFeaturesResult {
  /** Features this call asked Overwolf for. */
  requested: string[];
  /** Requested features the GEP bound for the running game. */
  registered: string[];
  /** Requested features the GEP did not bind. */
  rejected: string[];
  /**
   * Overwolf's own `supportedFeatures`, unmodified. `registered` is an
   * interpretation of this list, so the ground truth is kept alongside it for
   * the diagnostics block to show when the two disagree.
   */
  supported: string[];
  /** True when at least one requested feature was not bound. */
  degraded: boolean;
  /** Overwolf's reason for the first attempt, present only after a retry. */
  degradedReason?: string;
}

function overwolfApiUnavailable(): boolean {
  return typeof overwolf === 'undefined' || !overwolf.games || !overwolf.games.events;
}

/**
 * Calls `setRequiredFeatures` once and resolves with what was actually bound.
 *
 * `supportedFeatures` is documented as "all available features for the
 * registered games", which is not necessarily the requested subset, so it is
 * intersected with what was asked for instead of being trusted verbatim. An
 * absent or empty list means the running build does not report it — most often
 * because no game is running yet, which is a normal state at app start. In that
 * case the success flag is the only signal available, and reading it as
 * "nothing was registered" would turn a healthy start into a false failure.
 */
function registerFeatures(features: string[]): Promise<RequiredFeaturesResult> {
  return new Promise((resolve, reject) => {
    if (overwolfApiUnavailable()) {
      reject(new Error('Overwolf API is not available in this environment'));
      return;
    }

    overwolf.games.events.setRequiredFeatures(features, (result) => {
      if (!result.success) {
        reject(new Error(result.error ?? 'Failed to set required features'));
        return;
      }

      const supported = Array.isArray(result.supportedFeatures) ? result.supportedFeatures : [];
      const registered = supported.length > 0
        ? features.filter((feature) => supported.includes(feature))
        : [...features];
      const rejected = features.filter((feature) => !registered.includes(feature));

      resolve({
        requested: [...features],
        registered,
        rejected,
        supported,
        degraded: rejected.length > 0,
      });
    });
  });
}

/**
 * Requests the full feature set, degrading to the core set on failure.
 *
 * The previous implementation rejected the whole promise on any failure, so
 * asking for an optional feature a game's GEP does not expose would have taken
 * `game_info` and `match_info` down with it — the entire app, in exchange for
 * one diagnostics line. A retry with the core set keeps the app working and
 * reports the shortfall instead.
 *
 * A failed fallback still rejects, so the caller's existing retry loop remains
 * the single owner of "registration keeps failing" — which is the state
 * Overwolf's own documentation says to retry through.
 */
export async function setRequiredFeatures(): Promise<RequiredFeaturesResult> {
  try {
    return await registerFeatures(REQUIRED_FEATURES);
  } catch (error) {
    const fallback = await registerFeatures(CORE_FEATURES);
    const rejected = [
      ...fallback.rejected,
      ...OPTIONAL_FEATURES.filter((feature) => !fallback.registered.includes(feature)),
    ];

    return {
      ...fallback,
      rejected,
      degraded: rejected.length > 0,
      degradedReason: error instanceof Error ? error.message : String(error),
    };
  }
}
