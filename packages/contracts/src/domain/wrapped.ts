import { addDays } from './dates.js';

export type WrapPeriod = 'daily' | 'weekly';
export type WrapDay = {
  localDate: string;
  deviceId: string;
  views: number | null;
  minutes: number | null;
};
export function wrapBounds(period: WrapPeriod, end: string) {
  const days = period === 'daily' ? 1 : 7;
  const from = addDays(end, 1 - days);
  return {
    period,
    from,
    to: end,
    previousFrom: addDays(from, -days),
    previousTo: addDays(from, -1),
    expectedDays: days,
  };
}
/** The last completed local day or Monday–Sunday week. */
export function latestWrapEnd(period: WrapPeriod, today: string) {
  if (period === 'daily') return addDays(today, -1);
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  return addDays(today, -(weekday || 7));
}

/** Missing data is never zero. Device-days add; one unknown device makes that day's metric unknown. */
export function summarizeWrap(period: WrapPeriod, end: string, rows: WrapDay[]) {
  const bounds = wrapBounds(period, end);
  const metric = (from: string, to: string, key: 'views' | 'minutes') => {
    let total = 0;
    let trackedDays = 0;
    for (let date = from; date <= to; date = addDays(date, 1)) {
      const devices = new Map(rows.filter((r) => r.localDate === date).map((r) => [r.deviceId, r]));
      if (devices.size === 0 || [...devices.values()].some((r) => r[key] === null)) continue;
      total += [...devices.values()].reduce((n, r) => n + r[key]!, 0);
      trackedDays++;
    }
    return { value: trackedDays ? total : null, trackedDays };
  };
  const views = metric(bounds.from, bounds.to, 'views');
  const minutes = metric(bounds.from, bounds.to, 'minutes');
  const previousViews = metric(bounds.previousFrom, bounds.previousTo, 'views');
  const comparable =
    views.trackedDays === bounds.expectedDays && previousViews.trackedDays === bounds.expectedDays;
  return {
    ...bounds,
    views,
    minutes,
    previousViews,
    changePercent:
      comparable && previousViews.value! > 0
        ? Math.round(((views.value! - previousViews.value!) / previousViews.value!) * 100)
        : null,
  };
}
