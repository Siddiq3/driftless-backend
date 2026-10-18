/**
 * Local-calendar-day helpers. Days are device-local calendar days tagged with the IANA zone
 * in effect (ARCHITECTURE §8). The server never re-buckets device data.
 */

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** Local calendar date (YYYY-MM-DD) of `instantMs` in time zone `tz`. */
export function localDateOf(instantMs: number, tz: string): string {
  const parts = formatter(tz).formatToParts(new Date(instantMs));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function toUtcMs(d: string): number {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, day);
}

function fromUtcMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Calendar arithmetic on YYYY-MM-DD strings (zone-independent). */
export function addDays(d: string, n: number): string {
  return fromUtcMs(toUtcMs(d) + n * 86_400_000);
}

/** Whole calendar days from `a` to `b` (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((toUtcMs(b) - toUtcMs(a)) / 86_400_000);
}

/** Inclusive list of dates from `from` to `to`. Throws if the range exceeds `max` days. */
export function dateRange(from: string, to: string, max = 400): string[] {
  const n = daysBetween(from, to);
  if (n < 0) return [];
  if (n + 1 > max) throw new RangeError(`range of ${n + 1} days exceeds ${max}`);
  return Array.from({ length: n + 1 }, (_, i) => addDays(from, i));
}

export type Interval = { startMs: number; endMs: number };
export type DayPortion = { localDate: string; tz: string; ms: number };

/**
 * Split an interval of activity into local-day portions, honouring zone changes.
 * `zoneChanges` lists `{ atMs, tz }` sorted ascending; the first entry is the zone at `startMs`.
 * Portions that land on the same localDate (e.g. flying west) are merged.
 */
export function splitByLocalDay(
  interval: Interval,
  zoneChanges: ReadonlyArray<{ atMs: number; tz: string }>,
): DayPortion[] {
  if (interval.endMs <= interval.startMs) return [];
  if (zoneChanges.length === 0) throw new Error('at least one zone is required');
  const out = new Map<string, DayPortion>();
  const zones = [...zoneChanges].sort((a, b) => a.atMs - b.atMs);

  for (let zi = 0; zi < zones.length; zi++) {
    const z = zones[zi]!;
    const segStart = Math.max(interval.startMs, zi === 0 ? interval.startMs : z.atMs);
    const segEnd = Math.min(interval.endMs, zones[zi + 1]?.atMs ?? interval.endMs);
    let t = segStart;
    while (t < segEnd) {
      const d = localDateOf(t, z.tz);
      // Probe forward hour by hour until the local date changes or the segment ends.
      const hour = 3_600_000;
      let lo = t;
      let hi = t;
      while (hi < segEnd && localDateOf(hi, z.tz) === d) {
        lo = hi;
        hi = Math.min(hi + hour, segEnd);
      }
      let end: number;
      if (localDateOf(hi, z.tz) === d) {
        end = segEnd; // whole remainder of the segment is on day d
      } else {
        // Midnight lies in (lo, hi]; binary-search to the millisecond.
        while (hi - lo > 1) {
          const mid = Math.floor((lo + hi) / 2);
          if (localDateOf(mid, z.tz) === d) lo = mid;
          else hi = mid;
        }
        end = hi;
      }
      const prev = out.get(d);
      out.set(d, { localDate: d, tz: z.tz, ms: (prev?.ms ?? 0) + (end - t) });
      t = end;
    }
  }
  return [...out.values()].sort((a, b) => (a.localDate < b.localDate ? -1 : 1));
}
