import { PlayerStatePayloadV8 } from '@deadlock-live-probe/shared';

export const DIRECT_SHOP_SOURCE_ALLOWLIST_ENV = 'RECOMMENDATION_DIRECT_SHOP_SOURCE_ALLOWLIST' as const;

export type ApprovedDirectShopOpportunityV8 = 'AVAILABLE' | 'UNAVAILABLE' | 'UNKNOWN';

export function directShopSourceApprovalKey(source: string, sourceField: string): string {
  return `${source.trim()}:${sourceField.trim()}`;
}

export function parseDirectShopSourceAllowlist(value: string | undefined): ReadonlySet<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

export function configuredDirectShopSourceAllowlist(): readonly string[] {
  return [...parseDirectShopSourceAllowlist(process.env[DIRECT_SHOP_SOURCE_ALLOWLIST_ENV])].sort();
}

export function approvedDirectShopOpportunityV8(
  payload: PlayerStatePayloadV8,
  source: string,
  approvedSourceKeys: ReadonlySet<string> = new Set(configuredDirectShopSourceAllowlist()),
): ApprovedDirectShopOpportunityV8 {
  const sourceField = payload.shopOpportunityProvenance?.sourceField?.trim();
  if (
    (payload.shopOpportunity === 'AVAILABLE' || payload.shopOpportunity === 'UNAVAILABLE')
    && payload.shopOpportunityProvenance?.type === 'DIRECT_SOURCE_SIGNAL'
    && sourceField
    && approvedSourceKeys.has(directShopSourceApprovalKey(source, sourceField))
  ) {
    return payload.shopOpportunity;
  }
  return 'UNKNOWN';
}

export function sanitizePlayerStateDirectShopV8(
  payload: PlayerStatePayloadV8,
  source: string,
  approvedSourceKeys: ReadonlySet<string> = new Set(configuredDirectShopSourceAllowlist()),
): PlayerStatePayloadV8 {
  const shopOpportunity = approvedDirectShopOpportunityV8(payload, source, approvedSourceKeys);
  return {
    ...payload,
    shopOpportunity,
    shopOpportunityProvenance: shopOpportunity === 'UNKNOWN'
      ? undefined
      : payload.shopOpportunityProvenance,
  };
}
