export type Metric = 'views' | 'minutes';

export type DayUsage = {
  localDate: string;
  views: number | null;
  minutes: number | null;
  /** 0..1 fraction of the day with healthy tracking. */
  coverage: number;
};

export type GoalSpec = { metric: Metric; dailyLimit: number };

/**
 * kept     – usage ≤ limit and coverage sufficient to trust it
 * breached – usage > limit (a breach is trusted even at low coverage: we saw at least that much)
 * unknown  – not tracked, or coverage too low to claim the goal was kept
 */
export type DayOutcome = 'kept' | 'breached' | 'unknown';

/** Minimum coverage required before a day can count as "kept". */
export const MIN_COVERAGE_FOR_KEPT = 0.8;

export function evaluateDay(day: DayUsage, goal: GoalSpec): DayOutcome {
  const used = goal.metric === 'views' ? day.views : day.minutes;
  if (used === null) return 'unknown';
  if (used > goal.dailyLimit) return 'breached';
  return day.coverage >= MIN_COVERAGE_FOR_KEPT ? 'kept' : 'unknown';
}
