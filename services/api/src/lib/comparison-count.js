/** Recorded account totals are comparable when the caller has sharing consent.
 * Legacy uploads still need their original coverage gate. Missing is never zero.
 * Values here are already bounded/validated by the usage upload contract.
 */
export function comparisonCount(day) {
  if (day.personalViews != null) return day.personalViews;
  return day.views != null && (day.coverage ?? 1) >= 0.8 ? day.views : null;
}

/** Personal backup and accounting are cumulative observations of the same device.
 * Use its larger known count once; distinct devices add. Do not use reserved grants.
 * Existing unknown personal-only measurements keep the board unavailable.
 */
export function reconciledComparisonCounts(rows, devices = {}) {
  const counts = new Map(rows.map((row) => [row.deviceId, comparisonCount(row)]));
  for (const [deviceId, device] of Object.entries(devices)) {
    const observed = device.used?.views;
    if (Number.isSafeInteger(observed) && observed >= 0)
      counts.set(deviceId, Math.max(counts.get(deviceId) ?? 0, observed));
  }
  return [...counts.values()];
}
