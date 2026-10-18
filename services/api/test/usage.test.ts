import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { v1 } from '@siddiq3/driftless-contracts';
import { route } from '../src/router.js';
import { bodyOf, event, newSub } from './helpers.js';

const DEVICE = randomUUID();

const day = (
  localDate: string,
  rev: number,
  over: Partial<v1.DailyAggregate> = {},
): v1.DailyAggregate => ({
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

const sync = (sub: string, days: v1.DailyAggregate[], key = randomUUID()) =>
  route(
    event({
      method: 'POST',
      path: '/v1/usage/sync',
      sub,
      body: { days },
      headers: { 'idempotency-key': key },
    }),
  );

const history = (sub: string, from: string, to: string) =>
  route(event({ path: '/v1/usage/history', sub, query: { from, to } }));

async function userWithSync(): Promise<string> {
  const sub = newSub();
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
  it('requires cloud-sync consent', async () => {
    const sub = newSub();
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
    const bad = { ...day('2026-10-10', 1), userId: newSub() } as unknown as v1.DailyAggregate;
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
    const sub = newSub();
    const r = await history(sub, '2026-10-01', '2026-10-02');
    expect(r.statusCode).toBe(200);
    expect(v1.HistoryResponse.parse(bodyOf(r)).days).toEqual([]);
  });
});
