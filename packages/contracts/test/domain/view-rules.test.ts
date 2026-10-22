import { describe, expect, it } from 'vitest';
import {
  countFixture,
  DWELL_MS,
  RING_SIZE,
  ViewCounter,
  type Observation,
} from '../../src/domain/index.js';

const S = 1000;
const o = (
  tMs: number,
  fingerprint: string | null,
  extra: Partial<Observation> = {},
): Observation => ({
  tMs,
  surface: 'short_video',
  fingerprint,
  isAd: false,
  pagerScrolled: true,
  ...extra,
});
const leave = (tMs: number): Observation =>
  o(tMs, null, { surface: 'other', pagerScrolled: false });

describe('view counting fixtures (TEST_PLAN §2)', () => {
  it('counts a normal watch sequence', () => {
    const t = countFixture(
      [o(0, 'a', { pagerScrolled: false }), o(10 * S, 'b'), o(20 * S, 'c')],
      30 * S,
    );
    expect(t.views).toBe(3);
    expect(t.surfaceMs).toBe(30 * S);
  });

  it('repeated accessibility callbacks for the same item → 1 view', () => {
    const obs = [
      o(0, 'a', { pagerScrolled: false }),
      ...Array.from({ length: 50 }, (_, i) => o(100 * (i + 1), 'a')),
    ];
    expect(countFixture(obs, 10 * S).views).toBe(1);
  });

  it('fast scrolling below dwell threshold → no views for skipped items, time still counted', () => {
    const obs = [o(0, 'a', { pagerScrolled: false }), o(300, 'b'), o(600, 'c'), o(900, 'd')];
    const t = countFixture(obs, 900 + DWELL_MS);
    expect(t.views).toBe(1); // only 'd' dwelled long enough
    expect(t.surfaceMs).toBe(900 + DWELL_MS);
  });

  it('returning to a previous item is not re-counted', () => {
    const obs = [
      o(0, 'a', { pagerScrolled: false }),
      o(5 * S, 'b'),
      o(10 * S, 'a'),
      o(15 * S, 'b'),
    ];
    expect(countFixture(obs, 20 * S).views).toBe(2);
  });

  it('opening comments or a profile and coming back → no new view', () => {
    const obs = [
      o(0, 'a', { pagerScrolled: false }),
      leave(3 * S),
      o(9 * S, 'a', { pagerScrolled: false }),
    ];
    const t = countFixture(obs, 12 * S);
    expect(t.views).toBe(1);
    expect(t.surfaceMs).toBe(6 * S); // time in comments is not surface time
  });

  it('advertisements count as adViews, not views', () => {
    const obs = [
      o(0, 'a', { pagerScrolled: false }),
      o(5 * S, 'ad1', { isAd: true }),
      o(10 * S, 'b'),
    ];
    const t = countFixture(obs, 15 * S);
    expect(t).toMatchObject({ views: 2, adViews: 1 });
  });

  it('app switch away and back to the same item → not re-counted', () => {
    const obs = [
      o(0, 'a', { pagerScrolled: false }),
      leave(4 * S),
      o(60 * S, 'a', { pagerScrolled: false }),
    ];
    expect(countFixture(obs, 70 * S).views).toBe(1);
  });

  it('entering the surface counts the first item without a scroll event', () => {
    expect(countFixture([o(0, 'a', { pagerScrolled: false })], 5 * S).views).toBe(1);
  });

  it('a content change without a structural signal is not a transition', () => {
    // e.g. autoplay preview swaps in place while user stays on the same pager page
    const obs = [o(0, 'a', { pagerScrolled: false }), o(5 * S, 'b', { pagerScrolled: false })];
    expect(countFixture(obs, 10 * S).views).toBe(1);
  });

  it('unknown content contributes time only', () => {
    const t = countFixture([o(0, null), o(10 * S, null)], 20 * S);
    expect(t).toMatchObject({ views: 0, unknownMs: 20 * S, surfaceMs: 0 });
  });

  it('items older than the ring buffer can count again', () => {
    const ids = Array.from({ length: RING_SIZE + 1 }, (_, i) => `i${i}`);
    const obs = ids.map((id, i) => o(i * 5 * S, id, { pagerScrolled: i > 0 }));
    obs.push(o(ids.length * 5 * S, 'i0'));
    expect(countFixture(obs, (ids.length + 1) * 5 * S).views).toBe(RING_SIZE + 2);
  });

  it('ignores out-of-order observations', () => {
    const c = new ViewCounter();
    c.observe(o(10 * S, 'a', { pagerScrolled: false }));
    c.observe(o(5 * S, 'b'));
    expect(c.flush(20 * S).views).toBe(1);
  });

  it('flush is idempotent for earlier times', () => {
    const c = new ViewCounter();
    c.observe(o(0, 'a', { pagerScrolled: false }));
    c.flush(5 * S);
    expect(c.flush(1 * S)).toMatchObject({ views: 1, surfaceMs: 5 * S });
  });

  it('flush with no observations is a no-op', () => {
    expect(new ViewCounter().flush(1000)).toEqual({
      views: 0,
      adViews: 0,
      surfaceMs: 0,
      unknownMs: 0,
    });
  });
});

describe('asynchronous player caption identity', () => {
  it('counts a delayed caption on entering while preserving unknown time', () => {
    expect(
      countFixture(
        [o(0, null, { pagerScrolled: false }), o(300, 'a', { pagerScrolled: false })],
        2500,
      ),
    ).toMatchObject({ views: 1, unknownMs: 300 });
  });
  it('carries one recent swipe through stale and missing captions', () => {
    expect(
      countFixture(
        [
          o(0, 'a', { pagerScrolled: false }),
          o(3000, 'a'),
          o(3300, null, { pagerScrolled: false }),
          o(3600, 'b', { pagerScrolled: false }),
          o(3800, 'b', { pagerScrolled: false }),
        ],
        6000,
      ).views,
    ).toBe(2);
  });
  it('expires pending swipes and never lends a consumed swipe to a caption edit', () => {
    expect(
      countFixture(
        [
          o(0, 'a', { pagerScrolled: false }),
          o(3000, 'a'),
          o(4500, 'edit', { pagerScrolled: false }),
        ],
        7000,
      ).views,
    ).toBe(1);
    expect(
      countFixture(
        [
          o(0, 'a', { pagerScrolled: false }),
          o(3000, 'b'),
          o(3300, 'edit', { pagerScrolled: false }),
        ],
        6000,
      ).views,
    ).toBe(1);
  });
  it('clears pending identity on leaving and ignores short dwell', () => {
    expect(
      countFixture(
        [
          o(0, null),
          leave(300),
          o(600, null, { pagerScrolled: false }),
          o(2000, 'late', { pagerScrolled: false }),
        ],
        5000,
      ).views,
    ).toBe(0);
    expect(
      countFixture([o(0, null), o(300, 'skip', { pagerScrolled: false }), o(600, 'watched')], 3000)
        .views,
    ).toBe(1);
  });
});

describe('identity arriving before the structural signal', () => {
  it('requires fresh dwell after confirmation and ignores duplicate callbacks', () => {
    const c = new ViewCounter();
    for (const e of [
      o(0, 'a', { pagerScrolled: false }),
      o(3000, 'b', { pagerScrolled: false }),
      o(3200, 'b'),
      o(3300, 'b'),
    ])
      c.observe(e);
    expect(c.flush(4699).views).toBe(1);
    expect(c.flush(4700).views).toBe(2);
    c.observe(o(4800, 'b'));
    expect(c.flush(8000).views).toBe(2);
  });
  it('does not revive a stale candidate or recount a recent identity', () => {
    expect(
      countFixture([o(0, 'a'), o(3000, 'b', { pagerScrolled: false }), o(4300, 'b')], 7000).views,
    ).toBe(1);
    expect(
      countFixture(
        [o(0, 'a'), o(3000, 'b'), o(6000, 'a', { pagerScrolled: false }), o(6200, 'a')],
        9000,
      ).views,
    ).toBe(2);
  });
});
