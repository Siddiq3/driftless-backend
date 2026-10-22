/** Release policy: keep aligned with mobile config/access.ts and native FeatureAccess. */
export const SUBSCRIPTIONS_REQUIRED = false;
export const PHASE1_FLAGS = {
  androidVideoCounting: false,
  androidMinutes: false,
  androidBlocking: false,
  iosScreenTime: false,
  advancedAnalytics: false,
};
export function computeCapabilities(platform, entitlement, flags = PHASE1_FLAGS) {
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
