import type { DayOutcome } from './goals.js';

/**
 * Wick — the original lantern-brain mascot. Glow is driven by goal adherence, never by raw
 * usage alone, and never "rots": the lowest state is a dim but intact flame.
 */
export const WICK_STAGES = ['ember', 'spark', 'flicker', 'glow', 'beacon', 'aurora'] as const;
export type WickStage = (typeof WICK_STAGES)[number];

/** Points needed to reach each stage index (cumulative). */
export const STAGE_THRESHOLDS = [0, 3, 10, 25, 50, 100] as const;

export type WickState = {
  /** Lifetime kept-day points; never decreases. */
  points: number;
  stage: WickStage;
  /** 0..1 current brightness, reflects the last 7 days. */
  glow: number;
};

export function stageFor(points: number): WickStage {
  let idx = 0;
  for (let i = 0; i < STAGE_THRESHOLDS.length; i++) if (points >= STAGE_THRESHOLDS[i]!) idx = i;
  return WICK_STAGES[idx]!;
}

/**
 * @param history outcomes ordered oldest → newest (the last element is the most recent day)
 */
export function wickState(history: readonly DayOutcome[]): WickState {
  const points = history.filter((o) => o === 'kept').length;
  const recent = history.slice(-7);
  const known = recent.filter((o) => o !== 'unknown');
  // With no evidence, rest at a neutral glow rather than punishing missing data.
  const glow =
    known.length === 0
      ? 0.5
      : 0.2 + 0.8 * (known.filter((o) => o === 'kept').length / known.length);
  return { points, stage: stageFor(points), glow: Math.round(glow * 100) / 100 };
}
