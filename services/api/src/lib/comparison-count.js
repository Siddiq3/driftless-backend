/** Recorded account totals are comparable when the caller has sharing consent.
 * Legacy uploads still need their original coverage gate. Missing is never zero.
 * Values here are already bounded/validated by the usage upload contract.
 */
export function comparisonCount(day) {
  if (day.personalViews != null) return day.personalViews;
  return day.views != null && day.coverage >= 0.8 ? day.views : null;
}
