import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { v1 } from '@siddiq3/driftless-contracts';
import { route } from '../src/router.js';
import { bodyOf, event, newAccount } from './helpers.js';
const DEVICE = randomUUID();
const day = (localDate, rev, over = {}) => ({
  localDate,
  tz: 'Asia/Kolkata',
  platform: 'android',
  deviceId: DEVICE,
  views: null,
  adViews: null,
  minutes: 30,
  coverage: 0.95,
  rev,
  ...over,
});
const sync = (sub, days, key = randomUUID()) =>
  route(
    event({
      method: 'POST',
      path: '/v1/usage/sync',
      sub,
      body: { days },
      headers: { 'idempotency-key': key },
    }),
  );
const history = (sub, from, to) =>
  route(event({ path: '/v1/usage/history', sub, query: { from, to, includePersonal: 'true' } }));
async function userWithSync() {
  const sub = await newAccount();
  await route(event({ path: '/v1/me', sub }));
  const r = await route(
    event({
      method: 'PATCH',
      path: '/v1/me',
      sub,
      body: { consent: { cloudSync: true } },
      headers: { 'if-match': '1' },
    }),
  );
  expect(r.statusCode).toBe(200);
  return sub;
}
describe('POST /v1/usage/sync', () => {
  it('round-trips personal counts separately from competitive views, with revision and owner isolation', async () => {
    const sub = await userWithSync();
    const other = await userWithSync();
    const row = day('2026-10-17', 1, { personalViews: 73, views: null });
    const key = randomUUID();
    expect((await sync(sub, [row], key)).statusCode).toBe(200);
    expect((await sync(sub, [row], key)).headers['idempotent-replayed']).toBe('true');
    await sync(sub, [day('2026-10-17', 2, { personalViews: 89 })]);
    await sync(sub, [row]);
    const restored = v1.HistoryResponse.parse(
      bodyOf(await history(sub, '2026-10-17', '2026-10-17')),
    );
    expect(restored.days).toEqual([
      expect.objectContaining({ personalViews: 89, views: null, minutes: 30, rev: 2 }),
    ]);
    expect(bodyOf(await history(other, '2026-10-17', '2026-10-17')).days).toEqual([]);
    // Legacy writes and reads keep working during staged rollout.
    await sync(sub, [day('2026-10-17', 3, { minutes: 31 })]);
    expect(bodyOf(await history(sub, '2026-10-17', '2026-10-17')).days[0]).toMatchObject({
      personalViews: 89,
      minutes: 31,
    });
    const legacy = bodyOf(
      await route(
        event({ path: '/v1/usage/history', sub, query: { from: '2026-10-17', to: '2026-10-17' } }),
      ),
    );
    expect(legacy.days[0]).not.toHaveProperty('personalViews');
  });
  it('rejects invalid personal counts and personal video counts from iOS', async () => {
    const sub = await userWithSync();
    for (const personalViews of [-1, 1.5, 100001]) {
      expect((await sync(sub, [day('2026-10-17', 1, { personalViews })])).statusCode).toBe(400);
    }
    expect(
      (await sync(sub, [day('2026-10-17', 1, { platform: 'ios', personalViews: 73 })])).statusCode,
    ).toBe(400);
  });
  it('preserves platform history through 80 → 115 → 130 cumulative merges, retries and account isolation', async () => {
    const a = await userWithSync(),
      b = await userWithSync();
    const counts = (ig, yt) => ({ 'com.instagram.android': ig, 'com.google.android.youtube': yt });
    const date = '2026-10-28';
    for (const [rev, ig, yt] of [
      [1, 50, 30],
      [2, 70, 45],
      [3, 80, 50],
    ]) {
      const row = day(date, rev, { personalViews: ig + yt, personalAppViews: counts(ig, yt) });
      const key = randomUUID();
      expect((await sync(a, [row], key)).statusCode).toBe(200);
      expect((await sync(a, [row], key)).headers['idempotent-replayed']).toBe('true');
      await sync(a, [row]);
      const restored = bodyOf(await history(a, date, date)).days;
      expect(restored).toHaveLength(1);
      expect(restored[0]).toMatchObject({
        localDate: date,
        personalViews: ig + yt,
        personalAppViews: counts(ig, yt),
        rev,
      });
    }
    await sync(a, [day(date, 1, { personalViews: 80, personalAppViews: counts(50, 30) })]);
    expect(bodyOf(await history(a, date, date)).days[0].personalViews).toBe(130);
    expect(bodyOf(await history(b, date, date)).days).toEqual([]);
    await sync(a, [
      day('2026-10-29', 1, {
        deviceId: randomUUID(),
        personalViews: 3,
        personalAppViews: counts(0, 3),
      }),
    ]);
    expect(
      bodyOf(await history(a, date, '2026-10-29')).days.map((d) => [
        d.localDate,
        d.personalAppViews,
      ]),
    ).toEqual([
      [date, counts(80, 50)],
      ['2026-10-29', counts(0, 3)],
    ]);
  });
  it('rejects inconsistent or unsupported platform attribution and video attribution from iOS', async () => {
    const sub = await userWithSync();
    for (const over of [
      { personalViews: 5, personalAppViews: { 'com.instagram.android': 6 } },
      { personalViews: 5, personalAppViews: { 'unknown.app': 5 } },
      { personalViews: 5, personalAppViews: { 'com.instagram.android': -1 } },
      { platform: 'ios', personalViews: null, personalAppViews: { 'com.instagram.android': 0 } },
    ])
      expect((await sync(sub, [day('2026-10-28', 1, over)])).statusCode).toBe(400);
  });
  it('does not attach an outdated breakdown to a newer total from a legacy client', async () => {
    const sub = await userWithSync();
    await sync(sub, [
      day('2026-10-28', 1, {
        personalViews: 80,
        personalAppViews: { 'com.instagram.android': 50, 'com.google.android.youtube': 30 },
      }),
    ]);
    await sync(sub, [day('2026-10-28', 2, { personalViews: 90 })]);
    const row = bodyOf(await history(sub, '2026-10-28', '2026-10-28')).days[0];
    expect(row.personalViews).toBe(90);
    expect(row).not.toHaveProperty('personalAppViews');
  });
  it('stores a current upload without coverage and clears coverage left by an older client', async () => {
    const sub = await userWithSync();
    expect((await sync(sub, [day('2026-10-20', 1)])).statusCode).toBe(200);
    const current = day('2026-10-20', 2);
    delete current.coverage;
    expect((await sync(sub, [current])).statusCode).toBe(200);
    const [stored] = bodyOf(await history(sub, '2026-10-20', '2026-10-20')).days;
    expect(stored).toMatchObject({ minutes: 30, rev: 2 });
    expect(stored).not.toHaveProperty('coverage');
  });

  it('requires cloud-sync consent', async () => {
    const sub = await newAccount();
    await route(event({ path: '/v1/me', sub }));
    const r = await sync(sub, [day('2026-10-17', 1)]);
    expect(r.statusCode).toBe(403);
    expect(bodyOf(r).code).toBe('consent_required');
  });
  it('applies new days and reports per-day results', async () => {
    const sub = await userWithSync();
    const r = await sync(sub, [day('2026-10-16', 1), day('2026-10-17', 2)]);
    expect(r.statusCode).toBe(200);
    const res = v1.UsageSyncResponse.parse(bodyOf(r));
    expect(res.results.map((x) => x.status)).toEqual(['applied', 'applied']);
  });
  it('higher rev wins; equal rev is unchanged; lower rev is stale', async () => {
    const sub = await userWithSync();
    await sync(sub, [day('2026-10-17', 3, { minutes: 40 })]);
    const same = v1.UsageSyncResponse.parse(
      bodyOf(await sync(sub, [day('2026-10-17', 3, { minutes: 40 })])),
    );
    expect(same.results[0]).toMatchObject({ status: 'unchanged', serverRev: 3 });
    const old = v1.UsageSyncResponse.parse(
      bodyOf(await sync(sub, [day('2026-10-17', 2, { minutes: 10 })])),
    );
    expect(old.results[0]).toMatchObject({ status: 'stale', serverRev: 3 });
    const newer = v1.UsageSyncResponse.parse(
      bodyOf(await sync(sub, [day('2026-10-17', 4, { minutes: 55 })])),
    );
    expect(newer.results[0]).toMatchObject({ status: 'applied', serverRev: 4 });
    const h = v1.HistoryResponse.parse(bodyOf(await history(sub, '2026-10-17', '2026-10-17')));
    expect(h.days).toHaveLength(1);
    expect(h.days[0]).toMatchObject({ minutes: 55, rev: 4 });
  });
  it('a retried request with the same Idempotency-Key is replayed, not re-applied', async () => {
    const sub = await userWithSync();
    const key = randomUUID();
    const first = await sync(sub, [day('2026-10-15', 1)], key);
    const again = await sync(sub, [day('2026-10-15', 1)], key);
    expect(again.headers?.['idempotent-replayed']).toBe('true');
    expect(again.body).toBe(first.body);
  });
  it('two devices on the same day are stored separately', async () => {
    const sub = await userWithSync();
    const other = randomUUID();
    await sync(sub, [day('2026-10-14', 1), day('2026-10-14', 1, { deviceId: other, minutes: 5 })]);
    const h = v1.HistoryResponse.parse(bodyOf(await history(sub, '2026-10-14', '2026-10-14')));
    expect(h.days.map((d) => d.minutes).sort()).toEqual([30, 5].sort());
  });
  it('rejects future dates, video counts from iOS, and malformed payloads', async () => {
    const sub = await userWithSync();
    expect((await sync(sub, [day('2099-01-01', 1)])).statusCode).toBe(400);
    expect(
      (await sync(sub, [day('2026-10-13', 1, { platform: 'ios', views: 3 })])).statusCode,
    ).toBe(400);
    expect((await sync(sub, [day('2026-10-13', 1, { minutes: 5000 })])).statusCode).toBe(400);
    expect((await sync(sub, [])).statusCode).toBe(400);
  });
  it('requires an Idempotency-Key', async () => {
    const sub = await userWithSync();
    const r = await route(
      event({
        method: 'POST',
        path: '/v1/usage/sync',
        sub,
        body: { days: [day('2026-10-12', 1)] },
      }),
    );
    expect(r.statusCode).toBe(428);
  });
  it("one user's sync never appears in another user's history", async () => {
    const a = await userWithSync();
    const b = await userWithSync();
    await sync(a, [day('2026-10-11', 1, { minutes: 99 })]);
    const hb = v1.HistoryResponse.parse(bodyOf(await history(b, '2026-10-01', '2026-10-31')));
    expect(hb.days).toEqual([]);
  });
  it('a userId smuggled into a day is rejected by the strict schema', async () => {
    const sub = await userWithSync();
    const bad = { ...day('2026-10-10', 1), userId: await newAccount() };
    expect((await sync(sub, [bad])).statusCode).toBe(400);
  });
});
describe('GET /v1/usage/history', () => {
  it('returns days in range only, sorted by date', async () => {
    const sub = await userWithSync();
    await sync(sub, [
      day('2026-09-30', 1),
      day('2026-10-01', 1),
      day('2026-10-02', 1),
      day('2026-10-03', 1),
    ]);
    const h = v1.HistoryResponse.parse(bodyOf(await history(sub, '2026-10-01', '2026-10-02')));
    expect(h.days.map((d) => d.localDate)).toEqual(['2026-10-01', '2026-10-02']);
  });
  it('validates the range', async () => {
    const sub = await userWithSync();
    expect((await history(sub, '2026-10-05', '2026-10-01')).statusCode).toBe(400);
    expect((await history(sub, '2025-01-01', '2026-10-01')).statusCode).toBe(400);
    expect((await history(sub, 'yesterday', '2026-10-01')).statusCode).toBe(400);
  });
  it('works without cloud-sync consent (reads are of data already stored)', async () => {
    const sub = await newAccount();
    const r = await history(sub, '2026-10-01', '2026-10-02');
    expect(r.statusCode).toBe(200);
    expect(v1.HistoryResponse.parse(bodyOf(r)).days).toEqual([]);
  });
});
