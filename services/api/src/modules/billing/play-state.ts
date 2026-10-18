import { createHash } from 'node:crypto';
import type { v1 } from '@siddiq3/driftless-contracts';

/** Subset of Google Play `SubscriptionPurchaseV2` (androidpublisher v3) that we rely on. */
export type PlaySubscriptionV2 = {
  subscriptionState:
    | 'SUBSCRIPTION_STATE_UNSPECIFIED'
    | 'SUBSCRIPTION_STATE_PENDING'
    | 'SUBSCRIPTION_STATE_ACTIVE'
    | 'SUBSCRIPTION_STATE_PAUSED'
    | 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD'
    | 'SUBSCRIPTION_STATE_ON_HOLD'
    | 'SUBSCRIPTION_STATE_CANCELED'
    | 'SUBSCRIPTION_STATE_EXPIRED'
    | 'SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED';
  lineItems?: Array<{ productId: string; expiryTime?: string }>;
  linkedPurchaseToken?: string;
  acknowledgementState?:
    | 'ACKNOWLEDGEMENT_STATE_UNSPECIFIED'
    | 'ACKNOWLEDGEMENT_STATE_PENDING'
    | 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';
  externalAccountIdentifiers?: { obfuscatedExternalAccountId?: string };
  testPurchase?: Record<string, never>;
};

/**
 * The opaque account id the app passes to Play Billing (`setObfuscatedAccountId`). Binds a
 * purchase to the Driftless user without sending Google the user's id.
 */
export function obfuscatedAccountId(sub: string): string {
  return createHash('sha256').update(`driftless:${sub}`).digest('hex').slice(0, 64);
}

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Latest expiry among line items for the Pro products. */
export function proExpiry(s: PlaySubscriptionV2, proProducts: ReadonlySet<string>): string | null {
  const times = (s.lineItems ?? [])
    .filter((l) => proProducts.has(l.productId) && l.expiryTime)
    .map((l) => Date.parse(l.expiryTime!))
    .filter(Number.isFinite);
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

/**
 * Maps Play's state to our entitlement. Server-side only: the app never decides this (T5).
 * CANCELED means "won't renew" — access continues until expiry.
 */
export function entitlementFromPlay(
  s: PlaySubscriptionV2,
  proProducts: ReadonlySet<string>,
  nowMs: number,
): v1.Entitlement {
  const expiresAt = proExpiry(s, proProducts);
  const verifiedAt = new Date(nowMs).toISOString();
  const notExpired = expiresAt !== null && Date.parse(expiresAt) > nowMs;
  const base = { source: 'play' as const, expiresAt, verifiedAt };
  switch (s.subscriptionState) {
    case 'SUBSCRIPTION_STATE_ACTIVE':
      return notExpired
        ? { ...base, tier: 'pro', state: 'active' }
        : { ...base, tier: 'free', state: 'expired' };
    case 'SUBSCRIPTION_STATE_CANCELED':
      return notExpired
        ? { ...base, tier: 'pro', state: 'active' }
        : { ...base, tier: 'free', state: 'expired' };
    case 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD':
      return { ...base, tier: 'pro', state: 'grace' };
    case 'SUBSCRIPTION_STATE_ON_HOLD':
      return { ...base, tier: 'free', state: 'on_hold' };
    case 'SUBSCRIPTION_STATE_PAUSED':
      return { ...base, tier: 'free', state: 'paused' };
    case 'SUBSCRIPTION_STATE_EXPIRED':
      return { ...base, tier: 'free', state: 'expired' };
    default:
      // PENDING, PENDING_PURCHASE_CANCELED, UNSPECIFIED: payment not complete — no access.
      return { ...base, tier: 'free', state: 'none' };
  }
}

export const REVOKED = (nowMs: number): v1.Entitlement => ({
  tier: 'free',
  source: 'play',
  state: 'revoked',
  expiresAt: null,
  verifiedAt: new Date(nowMs).toISOString(),
});
