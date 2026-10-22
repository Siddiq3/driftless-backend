import type { Platform, v1 } from '@siddiq3/driftless-contracts';

/** Release policy: keep aligned with mobile config/access.ts and native FeatureAccess. */
export const SUBSCRIPTIONS_REQUIRED: boolean = false;

/**
 * Server-side feature switches. A capability is only advertised once it has been implemented
 * AND verified (PRODUCT_SPEC: "do not claim functionality works until verified").
 * These are backend rollout/verification gates, NOT observations of device permissions or
 * a running service. Unverified releases remain disabled; clients must combine eligibility
 * with live native support, permission, service, consent and entitlement observations.
 * Defaults intentionally do not certify Android accuracy or unverified feature rollouts.
 */
export type FeatureFlags = {
  androidVideoCounting: boolean; // gated by G-2 (Phase 2 accuracy report)
  androidMinutes: boolean; // Phase 3
  androidBlocking: boolean; // Phase 5
  iosScreenTime: boolean; // deferred (D-015)
  advancedAnalytics: boolean; // Phase 4
};

export const PHASE1_FLAGS: FeatureFlags = {
  androidVideoCounting: false,
  androidMinutes: false,
  androidBlocking: false,
  iosScreenTime: false,
  advancedAnalytics: false,
};

export function computeCapabilities(
  platform: Platform | null,
  entitlement: v1.Entitlement,
  flags: FeatureFlags = PHASE1_FLAGS,
): v1.Capabilities {
  const accessAllowed =
    !SUBSCRIPTIONS_REQUIRED ||
    (entitlement.tier === 'pro' &&
      (entitlement.state === 'active' || entitlement.state === 'grace'));
  const android = platform === 'android';
  const ios = platform === 'ios' && flags.iosScreenTime;
  return {
    videoCounting: android && flags.androidVideoCounting, // never on iOS (D-006)
    minutesTracking: (android && flags.androidMinutes) || ios,
    blocking: accessAllowed && ((android && flags.androidBlocking) || ios),
    schedules: accessAllowed && ((android && flags.androidBlocking) || ios),
    advancedAnalytics: accessAllowed && flags.advancedAnalytics,
    socialSharingOfUsage: android, // iOS Screen Time data never leaves the device (D-009)
  };
}
