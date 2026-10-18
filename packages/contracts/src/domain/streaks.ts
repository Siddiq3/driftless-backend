import { addDays } from './dates.js';
import type { DayOutcome } from './goals.js';

export type StreakPolicy = {
  /**
   * How many 'unknown' days may sit inside a streak without breaking it (e.g. phone off,
   * service killed). Unknown days never add to the streak length.
   */
  maxUnknownGap: number;
};

export const DEFAULT_STREAK_POLICY: StreakPolicy = { maxUnknownGap: 1 };

export type StreakResult = {
  /** Consecutive kept days ending at `today` (or yesterday if today is still in progress). */
  current: number;
  best: number;
};

/**
 * Compute streaks from per-day outcomes. Missing dates are treated as 'unknown'.
 * `today` is excluded unless it is already 'breached' (the day isn't over yet).
 */
export function computeStreaks(
  outcomes: ReadonlyMap<string, DayOutcome>,
  today: string,
  policy: StreakPolicy = DEFAULT_STREAK_POLICY,
): StreakResult {
  const dates = [...outcomes.keys()].sort();
  if (dates.length === 0) return { current: 0, best: 0 };

  let best = 0;
  let run = 0;
  let gap = 0;
  const end = outcomes.get(today) === 'breached' ? today : addDays(today, -1);

  for (let d = dates[0]!; d <= end; d = addDays(d, 1)) {
    const o = outcomes.get(d) ?? 'unknown';
    if (o === 'kept') {
      run += 1;
      gap = 0;
    } else if (o === 'breached') {
      run = 0;
      gap = 0;
    } else {
      gap += 1;
      if (gap > policy.maxUnknownGap) run = 0;
    }
    best = Math.max(best, run);
  }
  // A trailing gap longer than allowed has already reset `run`.
  return { current: run, best };
}
