import type { Platform, v1 } from '@siddiq3/driftless-contracts';

/**
 * Server-side feature switches. A capability is only advertised once it has been implemented
 * AND verified (PRODUCT_SPEC: "do not claim functionality works until verified").
 * Phase 1: nothing user-facing has shipped yet, so everything is off.
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
  const pro =
    entitlement.tier === 'pro' && (entitlement.state === 'active' || entitlement.state === 'grace');
  const android = platform === 'android';
  const ios = platform === 'ios' && flags.iosScreenTime;
  return {
    videoCounting: android && flags.androidVideoCounting, // never on iOS (D-006)
    minutesTracking: (android && flags.androidMinutes) || ios,
    blocking: pro && ((android && flags.androidBlocking) || ios),
    schedules: pro && ((android && flags.androidBlocking) || ios),
    advancedAnalytics: pro && flags.advancedAnalytics,
    socialSharingOfUsage: android, // iOS Screen Time data never leaves the device (D-009)
  };
}
