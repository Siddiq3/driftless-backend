import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { v1 } from '@siddiq3/driftless-contracts';
import { route } from '../src/router.js';
import { bodyOf, event, newSub } from './helpers.js';
const wrap = (sub: string, query = { period: 'daily', end: '2026-10-18' }) =>
  route(event({ path: '/v1/wrapped', sub, query }));
async function user() {
  const sub = newSub();
  await route(event({ path: '/v1/me', sub }));
  await route(
    event({
      method: 'PATCH',
      path: '/v1/me',
      sub,
      body: { consent: { cloudSync: true } },
      headers: { 'if-match': '1' },
    }),
  );
  return sub;
}
async function sync(
  sub: string,
  views: number | null,
  localDate = '2026-10-18',
  deviceId = randomUUID(),
) {
  const r = await route(
    event({
      method: 'POST',
      path: '/v1/usage/sync',
      sub,
      headers: { 'idempotency-key': randomUUID() },
      body: {
        days: [
          {
            deviceId,
            localDate,
            tz: 'UTC',
            platform: 'android',
            views,
            adViews: null,
            minutes: 10,
            coverage: 1,
            rev: 1,
          },
        ],
      },
    }),
  );
  expect(r.statusCode).toBe(200);
}
describe('GET /v1/wrapped', () => {
  it('requires sync consent; validates period and completed date', async () => {
    expect((await wrap(newSub())).statusCode).toBe(403);
    const sub = await user();
    expect((await wrap(sub, { period: 'monthly', end: '2026-10-18' })).statusCode).toBe(400);
    expect((await wrap(sub, { period: 'daily', end: '2099-01-01' })).statusCode).toBe(400);
    expect((await wrap(sub, { period: 'daily', end: '2026-02-30' })).statusCode).toBe(400);
  });
  it('isolates users and preserves empty periods as unknown', async () => {
    const a = await user();
    const b = await user();
    await sync(a, 100);
    expect(v1.WrapResponse.parse(bodyOf(await wrap(a))).views.value).toBe(100);
    const empty = v1.WrapResponse.parse(bodyOf(await wrap(b)));
    expect(empty.views).toEqual({ value: null, trackedDays: 0 });
    expect(empty.changePercent).toBeNull();
  });
  it('adds devices and compares complete daily periods', async () => {
    const sub = await user();
    await sync(sub, 30);
    await sync(sub, 20);
    await sync(sub, 100, '2026-10-17');
    const result = v1.WrapResponse.parse(bodyOf(await wrap(sub)));
    expect(result.source).toBe('synced');
    expect(result.views.value).toBe(50);
    expect(result.changePercent).toBe(-50);
  });
  it('returns partial weeks without unsupported comparisons', async () => {
    const sub = await user();
    await sync(sub, 0);
    await sync(sub, null, '2026-10-17');
    const result = v1.WrapResponse.parse(
      bodyOf(await wrap(sub, { period: 'weekly', end: '2026-10-18' })),
    );
    expect(result.from).toBe('2026-10-12');
    expect(result.views).toEqual({ value: 0, trackedDays: 1 });
    expect(result.expectedDays).toBe(7);
    expect(result.changePercent).toBeNull();
  });
});
