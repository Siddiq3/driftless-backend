import { describe, expect, it } from 'vitest';
import {
  computeStreaks,
  evaluateDay,
  stageFor,
  wickState,
  type DayOutcome,
} from '../../src/domain/index.js';

describe('evaluateDay', () => {
  const g = { metric: 'views' as const, dailyLimit: 20 };
  it('kept when under limit with good coverage', () => {
    expect(evaluateDay({ localDate: 'x', views: 20, minutes: 5, coverage: 0.9 }, g)).toBe('kept');
  });
  it('unknown when under limit but coverage is low', () => {
    expect(evaluateDay({ localDate: 'x', views: 3, minutes: 5, coverage: 0.5 }, g)).toBe('unknown');
  });
  it('breached even at low coverage', () => {
    expect(evaluateDay({ localDate: 'x', views: 21, minutes: 5, coverage: 0.1 }, g)).toBe(
      'breached',
    );
  });
  it('unknown when not tracked (null), never treated as zero', () => {
    expect(evaluateDay({ localDate: 'x', views: null, minutes: 5, coverage: 1 }, g)).toBe(
      'unknown',
    );
  });
  it('minutes goals read minutes', () => {
    const m = { metric: 'minutes' as const, dailyLimit: 30 };
    expect(evaluateDay({ localDate: 'x', views: 999, minutes: 31, coverage: 1 }, m)).toBe(
      'breached',
    );
  });
});

const outcomes = (start: string, seq: DayOutcome[]) => {
  const m = new Map<string, DayOutcome>();
  const [y, mo, d] = start.split('-').map(Number) as [number, number, number];
  seq.forEach((o, i) => m.set(new Date(Date.UTC(y, mo - 1, d + i)).toISOString().slice(0, 10), o));
  return m;
};

describe('computeStreaks', () => {
  it('empty history', () => {
    expect(computeStreaks(new Map(), '2026-10-18')).toEqual({ current: 0, best: 0 });
  });
  it('counts kept days up to yesterday; today in progress is ignored', () => {
    const m = outcomes('2026-10-14', ['kept', 'kept', 'kept', 'kept', 'kept']); // 14..18
    expect(computeStreaks(m, '2026-10-18')).toEqual({ current: 4, best: 4 });
  });
  it('a breach today ends the streak immediately', () => {
    const m = outcomes('2026-10-15', ['kept', 'kept', 'kept', 'breached']);
    expect(computeStreaks(m, '2026-10-18')).toEqual({ current: 0, best: 3 });
  });
  it('tolerates one unknown day without adding to length', () => {
    const m = outcomes('2026-10-12', ['kept', 'kept', 'unknown', 'kept', 'kept', 'kept']);
    expect(computeStreaks(m, '2026-10-18')).toEqual({ current: 5, best: 5 });
  });
  it('two unknown days in a row break it', () => {
    const m = outcomes('2026-10-11', [
      'kept',
      'kept',
      'unknown',
      'unknown',
      'kept',
      'kept',
      'kept',
    ]);
    expect(computeStreaks(m, '2026-10-18')).toEqual({ current: 3, best: 3 });
  });
  it('missing dates count as unknown', () => {
    const m = outcomes('2026-10-10', ['kept', 'kept']);
    expect(computeStreaks(m, '2026-10-18').current).toBe(0);
  });
  it('remembers the best run', () => {
    const m = outcomes('2026-10-01', ['kept', 'kept', 'kept', 'kept', 'breached', 'kept']);
    expect(computeStreaks(m, '2026-10-07')).toEqual({ current: 1, best: 4 });
  });
});

describe('Wick', () => {
  it('stages climb with lifetime points', () => {
    expect(stageFor(0)).toBe('ember');
    expect(stageFor(3)).toBe('spark');
    expect(stageFor(24)).toBe('flicker');
    expect(stageFor(1000)).toBe('aurora');
  });
  it('neutral glow with no evidence; never below 0.2', () => {
    expect(wickState([]).glow).toBe(0.5);
    expect(wickState(['unknown', 'unknown']).glow).toBe(0.5);
    expect(wickState(Array(7).fill('breached')).glow).toBe(0.2);
    expect(wickState(Array(7).fill('kept')).glow).toBe(1);
  });
  it('points never decrease with breaches', () => {
    const s = wickState(['kept', 'kept', 'kept', 'breached', 'breached']);
    expect(s.points).toBe(3);
    expect(s.stage).toBe('spark');
  });
});
