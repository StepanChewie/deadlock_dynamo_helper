import { Injectable } from '@nestjs/common';

export interface AdaptiveAvailabilityV1 {
  recommendationsEnabled: boolean;
  maintenanceMessage?: string;
  minimumClientVersion?: string;
  disabledHeroIds: readonly string[];
  disabledRulesetIds: readonly string[];
  disabledCatalogSha: readonly string[];
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }

  return TRUTHY.has(value.trim().toLowerCase());
}

function readList(value: string | undefined): readonly string[] {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function readOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Reads the remote kill switch state.
 *
 * Deadlock patches can invalidate item data without warning, so recommendations
 * must be switchable off faster than a code change. Everything here comes from
 * the process environment and is re-read on every call, so flipping a flag needs
 * only a restart — never a new build or a deploy of new code.
 *
 * Defaults are permissive: an unset environment serves recommendations exactly
 * as before this service existed.
 */
@Injectable()
export class AdaptiveAvailabilityV1Service {
  getAvailability(env: NodeJS.ProcessEnv = process.env): AdaptiveAvailabilityV1 {
    return {
      recommendationsEnabled: readBoolean(env.ADAPTIVE_RECOMMENDATIONS_ENABLED, true),
      maintenanceMessage: readOptional(env.ADAPTIVE_MAINTENANCE_MESSAGE),
      minimumClientVersion: readOptional(env.ADAPTIVE_MINIMUM_CLIENT_VERSION),
      disabledHeroIds: readList(env.ADAPTIVE_DISABLED_HERO_IDS),
      disabledRulesetIds: readList(env.ADAPTIVE_DISABLED_RULESET_IDS),
      disabledCatalogSha: readList(env.ADAPTIVE_DISABLED_CATALOG_SHA),
    };
  }
}
