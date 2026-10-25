import { localDateOf } from './dates.js';

/** UTC bounds of an account calendar day. Search instants rather than assuming 24 hours.
 * This includes zones whose offset changes at midnight and 23/25-hour DST days. */
export function accountPeriod(atMs: number, tz: string, incarnation: string) {
  if (!Number.isSafeInteger(atMs)) throw new RangeError('invalid instant');
  const date = localDateOf(atMs, tz);
  const edge = (before: boolean) => {
    let lo = before ? atMs - 48 * 3600_000 : atMs;
    let hi = before ? atMs : atMs + 48 * 3600_000;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      const same = localDateOf(mid, tz) === date;
      if (before ? same : !same) hi = mid;
      else lo = mid;
    }
    return hi;
  };
  return {
    periodId: `${incarnation}:${date}`,
    localDate: date,
    tz,
    startMs: edge(true),
    endMs: edge(false),
  };
}

/** Resolve a named calendar period without assuming its UTC offset. */
export function accountPeriodForDate(date: string, tz: string, incarnation: string) {
  let instant = Date.parse(`${date}T12:00:00Z`);
  let period = accountPeriod(instant, tz, incarnation);
  if (period.localDate !== date) {
    instant += period.localDate < date ? 86_400_000 : -86_400_000;
    period = accountPeriod(instant, tz, incarnation);
  }
  if (period.localDate !== date)
    throw new RangeError('calendar date does not exist in this timezone');
  return period;
}
