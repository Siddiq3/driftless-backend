import { describe, it, expect } from 'vitest';
import { latestWrapEnd, summarizeWrap, wrapBounds } from '../../src/domain/wrapped.js';
const day = (
  localDate: string,
  views: number | null,
  deviceId = 'phone',
  minutes: number | null = views,
) => ({ localDate, deviceId, views, minutes });
describe('Wrapped calendar and aggregation', () => {
  it('uses completed local periods across year and week boundaries', () => {
    expect(latestWrapEnd('daily', '2026-01-01')).toBe('2025-12-31');
    expect(latestWrapEnd('weekly', '2026-10-19')).toBe('2026-10-18');
    expect(latestWrapEnd('weekly', '2026-10-18')).toBe('2026-10-11');
    expect(wrapBounds('weekly', '2026-10-18')).toEqual({
      period: 'weekly',
      from: '2026-10-12',
      to: '2026-10-18',
      previousFrom: '2026-10-05',
      previousTo: '2026-10-11',
      expectedDays: 7,
    });
  });
  it('distinguishes unknown from zero and avoids partial comparisons', () => {
    expect(summarizeWrap('daily', '2026-10-18', []).views.value).toBeNull();
    const result = summarizeWrap('weekly', '2026-10-18', [
      day('2026-10-18', 0),
      day('2026-10-17', null),
    ]);
    expect(result.views).toEqual({ value: 0, trackedDays: 1 });
    expect(result.changePercent).toBeNull();
    expect(
      summarizeWrap('daily', '2026-10-18', [day('2026-10-17', 0), day('2026-10-18', 5)])
        .changePercent,
    ).toBeNull();
  });
  it('adds each device once and keeps unknown metrics independent', () => {
    const rows = [day('2026-10-18', 10), day('2026-10-18', 10), day('2026-10-18', 5, 'other')];
    expect(summarizeWrap('daily', '2026-10-18', rows).views.value).toBe(15);
    const result = summarizeWrap('daily', '2026-10-18', [
      ...rows,
      day('2026-10-18', null, 'third', 5),
    ]);
    expect(result.views.value).toBeNull();
    expect(result.minutes.value).toBe(20);
  });
  it('compares complete daily and weekly periods', () => {
    expect(
      summarizeWrap('daily', '2026-10-18', [day('2026-10-17', 100), day('2026-10-18', 50)])
        .changePercent,
    ).toBe(-50);
    const weeks = Array.from({ length: 14 }, (_, i) =>
      day(`2026-10-${String(i + 5).padStart(2, '0')}`, i < 7 ? 10 : 20),
    );
    expect(summarizeWrap('weekly', '2026-10-18', weeks).changePercent).toBe(100);
  });
});
