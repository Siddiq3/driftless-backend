import { randomUUID } from 'node:crypto';
import { TransactWriteCommand, QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { afterEach, expect, it, vi } from 'vitest';
import { route } from '../src/router.js';
import { ddb, Keys, tableName } from '../src/lib/ddb.js';
import { bodyOf, event, newAccount, ownerOf } from './helpers.js';
afterEach(() => vi.restoreAllMocks());
const call = (sub, path, method = 'GET', body, headers = {}) =>
  route(event({ sub, path, method, body, headers }));
async function setup(limits = { views: 20, minutes: 600000 }) {
  const sub = await newAccount(),
    incarnation = ownerOf(sub),
    a = randomUUID(),
    b = randomUUID();
  for (const id of [a, b])
    expect(
      (await call(sub, '/v1/devices', 'POST', { deviceId: id, platform: 'android' })).statusCode,
    ).toBe(200);
  const response = await call(sub, '/v1/usage/account', 'PUT', {
    tz: 'America/New_York',
    limits,
    expectedRev: 0,
  });
  expect(response.statusCode).toBe(200);
  const policy = bodyOf(response).policy;
  expect(bodyOf(response).snapshot).toBeNull();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(policy.activeFromMs + 3600000);
  const snapshot = bodyOf(await call(sub, '/v1/usage/account')).snapshot;
  return { sub, incarnation, a, b, clock, snapshot, policy };
}
const reserve = (
  x,
  deviceId,
  requested,
  operationId = randomUUID(),
  periodId = x.snapshot.periodId,
) =>
  call(x.sub, '/v1/usage/account/reserve', 'POST', {
    incarnation: x.incarnation,
    periodId,
    deviceId,
    operationId,
    requested,
  });
const contribution = (x, deviceId, rev, views, usageMs, extra = {}) => ({
  incarnation: x.incarnation,
  periodId: x.snapshot.periodId,
  localDate: x.snapshot.localDate,
  deviceId,
  rev,
  resetGeneration: 0,
  apps: { 'com.instagram.android': { views, usageMs } },
  ...extra,
});
const reconcile = (x, contributions, key = randomUUID()) =>
  call(x.sub, '/v1/usage/account/reconcile', 'POST', { contributions }, { 'idempotency-key': key });
it('fixes timezone and begins at the next account midnight without importing legacy usage', async () => {
  const x = await setup();
  expect(x.snapshot.used).toEqual({});
  expect(x.snapshot.unavailable).toContain('minutes');
  const change = await call(x.sub, '/v1/usage/account', 'PUT', {
    tz: 'UTC',
    limits: { views: 10 },
    expectedRev: 1,
  });
  expect(bodyOf(change).code).toBe('account_timezone_fixed');
});
it('serializes simultaneous reservations so stale reads cannot overspend a shared budget', async () => {
  const x = await setup();
  const responses = await Promise.all([
    reserve(x, x.a, { views: 15, minutes: 400000 }),
    reserve(x, x.b, { views: 15, minutes: 400000 }),
  ]);
  expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
  const snapshot = bodyOf(await call(x.sub, '/v1/usage/account')).snapshot;
  expect(snapshot.allocated).toEqual({ views: 20, minutes: 600000 });
  expect(Object.values(snapshot.devices).reduce((s, d) => s + d.granted.views, 0)).toBe(20);
});
it('replays a lost grant response without issuing additional credit and rejects a changed operation', async () => {
  const x = await setup(),
    id = randomUUID();
  const first = await reserve(x, x.a, { views: 5 }, id);
  expect(bodyOf(await reserve(x, x.a, { views: 5 }, id))).toEqual(bodyOf(first));
  expect((await reserve(x, x.a, { views: 6 }, id)).statusCode).toBe(409);
  expect(bodyOf(await call(x.sub, '/v1/usage/account')).snapshot.allocated.views).toBe(5);
});
it('adds device-minutes, deduplicates contributions, and cannot refund allowance through stale revisions or reset', async () => {
  const x = await setup(),
    key = randomUUID();
  const first = [contribution(x, x.a, 1, 3, 60000), contribution(x, x.b, 1, 4, 60000)];
  expect((await reconcile(x, first, key)).statusCode).toBe(200);
  expect((await reconcile(x, first, key)).headers['idempotent-replayed']).toBe('true');
  await reconcile(x, [contribution(x, x.a, 3, 8, 120000)]);
  await reconcile(x, [contribution(x, x.a, 2, 5, 90000)]);
  const same = await reconcile(x, [contribution(x, x.a, 3, 9, 120000)]);
  expect(bodyOf(same).code).toBe('usage_revision_reused');
  await reconcile(x, [contribution(x, x.a, 4, 0, 0, { resetGeneration: 1 })]);
  const snapshot = bodyOf(await call(x.sub, '/v1/usage/account')).snapshot;
  expect(snapshot.used.views).toBe(12);
  expect(snapshot.used.minutes).toBe(180000);
  expect(snapshot.used['minutes:com.instagram.android']).toBe(180000);
  expect((await reconcile(x, [contribution(x, x.a, 5, 10, 180000)])).statusCode).toBe(409);
});
it('preserves unknown measurement instead of treating it as a measured zero', async () => {
  const x = await setup();
  await reconcile(x, [contribution(x, x.a, 1, null, null)]);
  let snapshot = bodyOf(await call(x.sub, '/v1/usage/account')).snapshot;
  expect(snapshot.used.minutes).toBeUndefined();
  expect(snapshot.unavailable).toContain('minutes');
  await reconcile(x, [contribution(x, x.a, 2, 0, 0)]);
  snapshot = bodyOf(await call(x.sub, '/v1/usage/account')).snapshot;
  expect(snapshot.used.minutes).toBe(0);
  expect(snapshot.unavailable).not.toContain('minutes');
});
it('keeps today immutable after a limit edit and applies the new limit at the account boundary', async () => {
  const x = await setup();
  await reserve(x, x.a, { views: 15 });
  const updated = bodyOf(
    await call(x.sub, '/v1/usage/account', 'PUT', {
      tz: x.policy.tz,
      limits: { views: 5 },
      expectedRev: 1,
    }),
  );
  expect(updated.snapshot.limits.views).toBe(20);
  x.clock.mockReturnValue(x.snapshot.endMs + 1000);
  const next = bodyOf(await call(x.sub, '/v1/usage/account')).snapshot;
  expect(next.limits.views).toBe(5);
  expect(next.allocated).toEqual({});
  expect((await reserve(x, x.a, { views: 1 })).statusCode).toBe(409);
  // Old offline usage is reconciled to its ORIGINAL period, never relabeled as today's usage.
  expect((await reconcile(x, [contribution(x, x.a, 1, 7, 30000)])).statusCode).toBe(200);
  expect(bodyOf(await call(x.sub, '/v1/usage/account')).snapshot.used).toEqual({});
});
it('rejects unregistered devices, future dates, mismatched periods and cross-incarnation contributions', async () => {
  const x = await setup();
  expect((await reserve(x, randomUUID(), { views: 2 })).statusCode).not.toBe(200);
  expect(
    (await reconcile(x, [contribution(x, x.a, 1, 1, 1, { incarnation: randomUUID() })])).statusCode,
  ).toBe(409);
  expect(
    (
      await reconcile(x, [
        contribution(x, x.a, 1, 1, 1, { periodId: `${x.incarnation}:2020-01-01` }),
      ])
    ).statusCode,
  ).toBe(409);
});
it('does not lose concurrent device contributions and preserves exact sub-minute totals', async () => {
  const x = await setup();
  const replies = await Promise.all([
    reconcile(x, [contribution(x, x.a, 1, 2, 59999)]),
    reconcile(x, [contribution(x, x.b, 1, 3, 59999)]),
  ]);
  expect(replies.map((r) => r.statusCode)).toEqual([200, 200]);
  const snap = bodyOf(await call(x.sub, '/v1/usage/account')).snapshot;
  expect(snap.used.views).toBe(5);
  expect(snap.used.minutes).toBe(119998);
});
it('returns bounded historical account totals with only the requesting device baseline', async () => {
  const x = await setup();
  await reconcile(x, [contribution(x, x.a, 1, 2, 59999), contribution(x, x.b, 1, 3, 59999)]);
  const query = { from: x.snapshot.localDate, to: x.snapshot.localDate, deviceId: x.a };
  const result = await route(event({ sub: x.sub, path: '/v1/usage/account/history', query }));
  expect(result.statusCode).toBe(200);
  const day = bodyOf(result).days[0];
  expect(day.used.minutes).toBe(119998);
  expect(day.used.views).toBe(5);
  expect(Object.keys(day.devices)).toEqual([x.a]);
  expect(day.devices[x.a].used.minutes).toBe(59999);
  const other = await newAccount();
  // No policy/data from another incarnation can be resolved through the stable identity.
  expect(
    (await route(event({ sub: other, path: '/v1/usage/account/history', query }))).statusCode,
  ).toBe(409);
  expect(
    (
      await route(
        event({
          sub: x.sub,
          path: '/v1/usage/account/history',
          query: { ...query, from: '2020-01-01' },
        }),
      )
    ).statusCode,
  ).toBe(400);
});
it('safely retries a partially committed frozen batch without double-counting its first contribution', async () => {
  const x = await setup(),
    missing = randomUUID(),
    key = randomUUID();
  const frozen = [contribution(x, x.a, 1, 4, 30000), contribution(x, missing, 1, 6, 30000)];
  const first = await reconcile(x, frozen, key);
  expect(bodyOf(first).code).toBe('device_not_registered');
  expect(bodyOf(await call(x.sub, '/v1/usage/account')).snapshot.used.views).toBe(4);
  expect(
    (await call(x.sub, '/v1/devices', 'POST', { deviceId: missing, platform: 'android' }))
      .statusCode,
  ).toBe(200);
  expect((await reconcile(x, frozen, key)).statusCode).toBe(200);
  const snap = bodyOf(await call(x.sub, '/v1/usage/account')).snapshot;
  expect(snap.used.views).toBe(10);
  expect(snap.used.minutes).toBe(60000);
});
it('rejects a policy edit delayed across the midnight seal without changing issued credit', async () => {
  const x = await setup();
  let reached, release;
  const ready = new Promise((r) => (reached = r)),
    gate = new Promise((r) => (release = r)),
    real = ddb().send.bind(ddb());
  let paused = false;
  vi.spyOn(ddb(), 'send').mockImplementation(async (command) => {
    if (
      !paused &&
      command instanceof TransactWriteCommand &&
      command.input.TransactItems.some((i) => i.Put?.Item.sk === 'ACCOUNTUSAGE#POLICY')
    ) {
      paused = true;
      reached();
      await gate;
    }
    return real(command);
  });
  const pending = call(x.sub, '/v1/usage/account', 'PUT', {
    tz: x.policy.tz,
    limits: { views: 1 },
    expectedRev: 1,
  });
  try {
    await ready;
    x.clock.mockReturnValue(x.snapshot.endMs + 1000);
    const next = bodyOf(await call(x.sub, '/v1/usage/account')).snapshot;
    expect(next.limits.views).toBe(20);
    release();
    expect((await pending).statusCode).toBe(409);
    expect(bodyOf(await call(x.sub, '/v1/usage/account')).snapshot.limits.views).toBe(20);
  } finally {
    release();
    await pending;
  }
});
it('does not reopen old accounting after deleting and explicitly registering an empty incarnation', async () => {
  const x = await setup();
  await reconcile(x, [contribution(x, x.a, 1, 10, 120000)]);
  await reserve(x, x.a, { views: 5 });
  expect((await call(x.sub, '/v1/account/delete', 'POST')).statusCode).toBe(200);
  const registered = await call(x.sub, '/v1/account/register', 'POST', {
    registrationId: randomUUID(),
    expectedIncarnation: x.incarnation,
  });
  expect(registered.statusCode).toBe(200);
  expect(bodyOf(registered).incarnation).not.toBe(x.incarnation);
  expect(
    bodyOf(
      await call(x.sub, '/v1/usage/account', 'GET', undefined, {
        'x-account-incarnation': bodyOf(registered).incarnation,
      }),
    ),
  ).toMatchObject({ policy: null, snapshot: null });
  expect((await reconcile(x, [contribution(x, x.a, 2, 12, 180000)])).statusCode).toBe(409);
});
it('fences a profile timezone patch whose initial missing-policy read races fixed-timezone setup', async () => {
  const sub = await newAccount();
  const before = bodyOf(await call(sub, '/v1/me')).profile.rev;
  let reached, release;
  const ready = new Promise((r) => (reached = r)),
    gate = new Promise((r) => (release = r)),
    real = ddb().send.bind(ddb());
  let paused = false;
  vi.spyOn(ddb(), 'send').mockImplementation(async (command) => {
    if (
      !paused &&
      command instanceof GetCommand &&
      command.input.Key.sk === 'ACCOUNTUSAGE#POLICY'
    ) {
      paused = true;
      const result = await real(command);
      reached();
      await gate;
      return result;
    }
    return real(command);
  });
  // Guessing a future profile revision must not bypass a concurrently established policy.
  const pending = call(
    sub,
    '/v1/me',
    'PATCH',
    { tz: 'Asia/Tokyo' },
    { 'if-match': String(before + 1) },
  );
  try {
    await ready;
    expect(
      (
        await call(sub, '/v1/usage/account', 'PUT', {
          tz: 'America/New_York',
          limits: {},
          expectedRev: 0,
        })
      ).statusCode,
    ).toBe(200);
    release();
    expect((await pending).statusCode).toBe(409);
    expect(bodyOf(await call(sub, '/v1/me')).profile.tz).toBe('America/New_York');
  } finally {
    release();
    await pending;
  }
});
it('a delayed final reservation cannot succeed after deletion/re-registration', async () => {
  const x = await setup();
  let reached, release;
  const ready = new Promise((r) => (reached = r)),
    gate = new Promise((r) => (release = r));
  const real = ddb().send.bind(ddb());
  let paused = false;
  vi.spyOn(ddb(), 'send').mockImplementation(async (command) => {
    if (
      !paused &&
      command instanceof TransactWriteCommand &&
      command.input.TransactItems.some((i) => i.Put?.Item.sk.startsWith('ACCOUNTUSAGE#GRANT#'))
    ) {
      paused = true;
      reached();
      await gate;
    }
    return real(command);
  });
  const pending = reserve(x, x.a, { views: 10 });
  try {
    await ready;
    expect((await call(x.sub, '/v1/account/delete', 'POST')).statusCode).toBe(200);
    expect(
      (
        await call(x.sub, '/v1/account/register', 'POST', {
          registrationId: randomUUID(),
          expectedIncarnation: x.incarnation,
        })
      ).statusCode,
    ).toBe(200);
    release();
    expect((await pending).statusCode).toBe(409);
    const rows = await ddb().send(
      new QueryCommand({
        TableName: tableName(),
        KeyConditionExpression: 'pk = :p',
        ExpressionAttributeValues: { ':p': Keys.user(x.incarnation) },
      }),
    );
    expect(rows.Items).toEqual([]);
  } finally {
    release();
    await pending;
  }
});
