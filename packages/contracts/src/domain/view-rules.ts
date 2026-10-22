/**
 * Reference implementation of the view-counting rule (DECISIONS D-007).
 *
 * The production engine is native Kotlin (D-008). This pure TS version is the executable spec:
 * the same fixtures are replayed against both, and their outputs must match.
 *
 * Definitions (PRODUCT_SPEC §4):
 *  - candidate surface: observation with surface === 'short_video'
 *  - confirmed transition: a structural signal (pager scroll, or entering the surface) AND a
 *    fingerprint not in the recent ring buffer
 *  - counted view: a confirmed transition whose item stays in the foreground ≥ DWELL_MS
 *  - unknown content: short-video surface with no fingerprint → time only, never a view
 */

export const DWELL_MS = 1500;
export const RING_SIZE = 8;
export const IDENTITY_SETTLE_MS = 1200;

export type Surface = 'short_video' | 'other' | 'unknown';

export type Observation = {
  tMs: number;
  surface: Surface;
  /** Salted hash of stable item attributes; null when identity can't be established. */
  fingerprint: string | null;
  isAd: boolean;
  /** A pager/scroll event was observed since the previous observation. */
  pagerScrolled: boolean;
};

export type Tally = {
  views: number;
  adViews: number;
  /** Time on the short-video surface with a known item. */
  surfaceMs: number;
  /** Time on the short-video surface with unknown item identity. */
  unknownMs: number;
};

type Current = { fp: string; since: number; dwellMs: number; isAd: boolean; pending: boolean; awaitingSignal: boolean };

export class ViewCounter {
  private ring: string[] = [];
  private cur: Current | null = null;
  private lastT: number | null = null;
  private lastSurface: Surface = 'other';
  private lastFpNull = false;
  private transitionUntil: number | null = null;
  readonly tally: Tally = { views: 0, adViews: 0, surfaceMs: 0, unknownMs: 0 };

  /** Feed observations in non-decreasing time order. Out-of-order input is ignored. */
  observe(o: Observation): void {
    if (this.lastT !== null && o.tMs < this.lastT) return;
    this.advance(o.tMs);

    const entering = o.surface === 'short_video' && this.lastSurface !== 'short_video';
    this.lastSurface = o.surface;
    this.lastFpNull = o.surface === 'short_video' && o.fingerprint === null;
    if (o.surface !== 'short_video') this.transitionUntil = null;
    else if (entering || o.pagerScrolled) this.transitionUntil = o.tMs + IDENTITY_SETTLE_MS;
    if (this.transitionUntil !== null && o.tMs > this.transitionUntil) this.transitionUntil = null;

    if (o.surface !== 'short_video') {
      // Left the feed (comments, profile, another app). Pause the current item; keep the ring.
      this.cur = null;
      return;
    }
    if (o.fingerprint === null) {
      this.cur = null;
      return;
    }
    if (this.cur && this.cur.fp === o.fingerprint) {
      if (this.cur.awaitingSignal && o.pagerScrolled && o.tMs - this.cur.since <= IDENTITY_SETTLE_MS) {
        this.cur.awaitingSignal = false;
        this.cur.pending = true;
        this.cur.dwellMs = 0;
        this.transitionUntil = null;
      }
      return;
    }

    const novel = !this.ring.includes(o.fingerprint);
    const structural = this.transitionUntil !== null;
    if (structural) this.transitionUntil = null;
    this.remember(o.fingerprint);
    this.cur = {
      fp: o.fingerprint,
      since: o.tMs,
      dwellMs: 0,
      isAd: o.isAd,
      pending: novel && structural,
      awaitingSignal: novel && !structural,
    };
  }

  /** Account for elapsed time up to `tMs` (call at end of session / day boundary). */
  flush(tMs: number): Tally {
    if (this.lastT === null || tMs >= this.lastT) this.advance(tMs);
    return this.tally;
  }

  private advance(tMs: number): void {
    if (this.lastT !== null && this.lastSurface === 'short_video') {
      const dt = tMs - this.lastT;
      if (this.lastFpNull) this.tally.unknownMs += dt;
      else if (this.cur) {
        this.tally.surfaceMs += dt;
        this.cur.dwellMs += dt;
        if (this.cur.pending && this.cur.dwellMs >= DWELL_MS) {
          this.cur.pending = false;
          if (this.cur.isAd) this.tally.adViews += 1;
          else this.tally.views += 1;
        }
      }
    }
    this.lastT = tMs;
  }

  private remember(fp: string): void {
    const i = this.ring.indexOf(fp);
    if (i >= 0) this.ring.splice(i, 1);
    this.ring.push(fp);
    if (this.ring.length > RING_SIZE) this.ring.shift();
  }
}

/** Convenience: run a whole fixture and flush at `endMs`. */
export function countFixture(obs: readonly Observation[], endMs: number): Tally {
  const c = new ViewCounter();
  for (const o of obs) c.observe(o);
  return c.flush(endMs);
}
