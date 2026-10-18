import { describe, expect, it } from 'vitest';
import {
  addDays,
  dateRange,
  daysBetween,
  localDateOf,
  splitByLocalDay,
} from '../../src/domain/index.js';

const H = 3_600_000;

describe('localDateOf', () => {
  it('uses the zone, not UTC', () => {
    // 2026-10-18T20:00Z is already 19 Oct in Kolkata (UTC+5:30)
    const t = Date.UTC(2026, 9, 18, 20, 0);
    expect(localDateOf(t, 'UTC')).toBe('2026-10-18');
    expect(localDateOf(t, 'Asia/Kolkata')).toBe('2026-10-19');
    expect(localDateOf(t, 'America/Los_Angeles')).toBe('2026-10-18');
  });
});

describe('calendar arithmetic', () => {
  it('crosses months, leap days and years', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(daysBetween('2026-01-01', '2027-01-01')).toBe(365);
  });
  it('dateRange is inclusive, empty when reversed, bounded', () => {
    expect(dateRange('2026-10-30', '2026-11-02')).toEqual([
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ]);
    expect(dateRange('2026-10-02', '2026-10-01')).toEqual([]);
    expect(() => dateRange('2025-01-01', '2026-12-31')).toThrow(RangeError);
  });
  it('is not affected by DST (calendar math in UTC)', () => {
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2); // US spring-forward weekend
  });
});

describe('splitByLocalDay', () => {
  it('returns nothing for empty or reversed intervals', () => {
    expect(splitByLocalDay({ startMs: 10, endMs: 10 }, [{ atMs: 0, tz: 'UTC' }])).toEqual([]);
  });
  it('requires a zone', () => {
    expect(() => splitByLocalDay({ startMs: 0, endMs: 10 }, [])).toThrow();
  });
  it('keeps a same-day interval whole', () => {
    const s = Date.UTC(2026, 9, 18, 10);
    const r = splitByLocalDay({ startMs: s, endMs: s + 2 * H }, [{ atMs: s, tz: 'UTC' }]);
    expect(r).toEqual([{ localDate: '2026-10-18', tz: 'UTC', ms: 2 * H }]);
  });
  it('splits exactly at local midnight', () => {
    // 23:30 → 00:45 in Kolkata
    const s = Date.UTC(2026, 9, 18, 18, 0); // 23:30 IST
    const r = splitByLocalDay({ startMs: s, endMs: s + 75 * 60_000 }, [
      { atMs: s, tz: 'Asia/Kolkata' },
    ]);
    expect(r).toEqual([
      { localDate: '2026-10-18', tz: 'Asia/Kolkata', ms: 30 * 60_000 },
      { localDate: '2026-10-19', tz: 'Asia/Kolkata', ms: 45 * 60_000 },
    ]);
  });
  it('detects midnight inside the final partial hour', () => {
    const s = Date.UTC(2026, 9, 18, 23, 20); // 23:20 UTC
    const r = splitByLocalDay({ startMs: s, endMs: s + 50 * 60_000 }, [{ atMs: s, tz: 'UTC' }]);
    expect(r.map((p) => [p.localDate, p.ms / 60_000])).toEqual([
      ['2026-10-18', 40],
      ['2026-10-19', 10],
    ]);
  });
  it('handles a DST day (23-hour day in New York)', () => {
    const s = Date.UTC(2026, 2, 8, 5, 0); // 00:00 EST on 8 Mar 2026
    const r = splitByLocalDay({ startMs: s, endMs: s + 24 * H }, [
      { atMs: s, tz: 'America/New_York' },
    ]);
    expect(r.map((p) => [p.localDate, p.ms / H])).toEqual([
      ['2026-03-08', 23],
      ['2026-03-09', 1],
    ]);
  });
  it('follows a mid-interval zone change and merges repeated local dates (westward travel)', () => {
    const s = Date.UTC(2026, 9, 18, 10, 0); // 15:30 IST, 18 Oct
    const change = s + H; // now in London (11:00 BST, still 18 Oct)
    const r = splitByLocalDay({ startMs: s, endMs: s + 3 * H }, [
      { atMs: s, tz: 'Asia/Kolkata' },
      { atMs: change, tz: 'Europe/London' },
    ]);
    expect(r).toHaveLength(1);
    expect(r[0]!.localDate).toBe('2026-10-18');
    expect(r[0]!.ms).toBe(3 * H);
    expect(r[0]!.tz).toBe('Europe/London'); // zone in effect at the end of that day
  });
  it('sorts zone changes', () => {
    const s = Date.UTC(2026, 9, 18, 10);
    const a = splitByLocalDay({ startMs: s, endMs: s + H }, [
      { atMs: s + 30 * 60_000, tz: 'UTC' },
      { atMs: s, tz: 'UTC' },
    ]);
    expect(a.reduce((n, p) => n + p.ms, 0)).toBe(H);
  });
});
