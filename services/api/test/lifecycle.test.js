import { randomUUID } from 'node:crypto';
import { PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { afterEach, expect, it, vi } from 'vitest';
import { route } from '../src/router.js';
import { ddb, Keys, tableName } from '../src/lib/ddb.js';
import { accountKey, incarnationKey, readState } from '../src/lib/lifecycle.js';
import { setBillingDeps } from '../src/modules/billing/index.js';
import { reconcilePlay } from '../src/modules/billing/reconcile.js';
import { obfuscatedAccountId } from '../src/modules/billing/play-state.js';
import { bodyOf, event, newAccount, newSub, ownerOf } from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
  setBillingDeps(null);
});
const call = (sub, path, method = 'GET', body, headers = {}) =>
  route(event({ sub, path, method, body, headers }));
const rows = async (owner) =>
  (
    await ddb().send(
      new QueryCommand({
        TableName: tableName(),
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': Keys.user(owner) },
        ConsistentRead: true,
      }),
    )
  ).Items ?? [];
const remove = (sub) => call(sub, '/v1/account/delete', 'POST');
const register = (sub, expectedIncarnation = null, registrationId = randomUUID()) =>
  call(sub, '/v1/account/register', 'POST', { expectedIncarnation, registrationId });
const device = () => ({
  deviceId: randomUUID(),
  platform: 'android',
  pushToken: 'fixture-push-token-only',
});
const day = () => ({
  localDate: '2026-10-17',
  tz: 'UTC',
  platform: 'android',
  deviceId: randomUUID(),
  views: null,
  adViews: null,
  minutes: 12,
  personalViews: 30,
  coverage: 1,
  rev: 1,
});
const goal = () => ({
  goalId: randomUUID(),
  metric: 'minutes',
  dailyLimit: 30,
  enabled: true,
  rev: 1,
});
async function sharedUser() {
  const sub = await newAccount();
  expect(
    (
      await call(
        sub,
        '/v1/me',
        'PATCH',
        {
          handle: `p${randomUUID().replaceAll('-', '').slice(0, 14)}`,
          consent: { cloudSync: true, shareWithFriends: true },
        },
        { 'if-match': '1' },
      )
    ).statusCode,
  ).toBe(200);
  return sub;
}
/** Pause the actual final SDK transaction, after handler reads but before DynamoDB evaluates it.
 * No timing sleeps and no fake conditional evaluation: DynamoDB Local decides the transaction. */
function pauseTransaction(matches, entitlement) {
  let release, reached;
  const ready = new Promise((resolve) => {
    reached = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const real = ddb().send.bind(ddb());
  let paused = false;
  vi.spyOn(ddb(), 'send').mockImplementation(async (command) => {
    if (
      entitlement &&
      command instanceof QueryCommand &&
      command.input.ExpressionAttributeValues?.[':p'] === 'ENT#play'
    )
      return { Items: [entitlement] };
    if (
      !paused &&
      command instanceof TransactWriteCommand &&
      matches(command.input.TransactItems)
    ) {
      paused = true;
      reached();
      await gate;
    }
    return real(command);
  });
  return { ready, release, send: real };
}
const has = (prefix) => (items) =>
  items.some((item) => {
    const op = item.Put ?? item.Update ?? item.Delete;
    return (op?.Item?.sk ?? op?.Key?.sk ?? '').startsWith(prefix);
  });

it('ordinary authenticated reads neither create profiles nor activate accounts', async () => {
  const sub = newSub();
  expect((await call(sub, '/v1/me')).statusCode).toBe(409);
  expect(await rows(sub)).toEqual([]);
  expect(await readState(accountKey(sub))).toBeUndefined();
});

it('explicit registration is replay-safe, recent-authenticated, and distinct from sign-in', async () => {
  const sub = newSub();
  const id = randomUUID();
  const responses = await Promise.all([register(sub, null, id), register(sub, null, id)]);
  expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
  const incarnation = bodyOf(responses[0]).incarnation;
  expect(bodyOf(responses[1]).incarnation).toBe(incarnation);
  expect(incarnation).not.toBe(sub);
  expect((await rows(incarnation)).map((r) => r.sk)).toEqual(['PROFILE']);
  expect((await register(sub)).statusCode).toBe(409);
  const old = event({
    sub: newSub(),
    path: '/v1/account/register',
    method: 'POST',
    body: { registrationId: randomUUID(), expectedIncarnation: null },
    claims: { iat: Math.floor(Date.now() / 1000) - 301 },
  });
  expect((await route(old)).statusCode).toBe(403);
});

it.each(['absent', 'expired', 'completed', 'in_progress'])(
  'quarantines legacy data with %s deletion evidence; fresh registration imports nothing',
  async (marker) => {
    const sub = newSub();
    const legacy = {
      pk: Keys.user(sub),
      sk: 'PROFILE',
      createdAt: '2020-01-01',
      rev: 99,
      handle: 'legacy-fixture',
    };
    await ddb().send(new PutCommand({ TableName: tableName(), Item: legacy }));
    if (marker !== 'absent')
      await ddb().send(
        new PutCommand({
          TableName: tableName(),
          Item: {
            pk: `DELETE#${sub}`,
            sk: 'JOB',
            state: marker === 'expired' ? 'completed' : marker,
            ttl: marker === 'expired' ? 1 : 4_000_000_000,
          },
        }),
      );
    expect(bodyOf(await call(sub, '/v1/account')).state).toBe('legacy_quarantined');
    expect((await call(sub, '/v1/me')).statusCode).toBe(409);
    const incarnation = bodyOf(await register(sub)).incarnation;
    const response = await call(sub, '/v1/me', 'GET', undefined, {
      'x-account-incarnation': incarnation,
    });
    expect(bodyOf(response).profile).toMatchObject({ handle: null, rev: 1 });
    expect(await rows(sub)).toEqual([legacy]);
  },
);

it('deletion, fresh registration and old registration/deletion retries cannot adopt or erase the new incarnation', async () => {
  const sub = await sharedUser();
  const old = ownerOf(sub);
  await call(sub, '/v1/devices', 'POST', device());
  expect((await remove(sub)).statusCode).toBe(200);
  expect(await rows(old)).toEqual([]);
  const tombstone = await readState(incarnationKey(old));
  expect(tombstone).toMatchObject({ state: 'deleted' });
  expect(tombstone.ttl).toBeUndefined();
  const fresh = bodyOf(await register(sub, old)).incarnation;
  const headers = { 'x-account-incarnation': fresh };
  expect((await call(sub, '/v1/devices', 'POST', device(), headers)).statusCode).toBe(200);
  const snapshot = await rows(fresh);
  expect((await remove(sub)).statusCode).toBe(200); // completed OLD deletion only
  expect((await call(sub, '/v1/devices', 'POST', device())).statusCode).toBe(409);
  expect((await register(sub, old)).statusCode).toBe(409);
  expect(await rows(fresh)).toEqual(snapshot);
  expect(bodyOf(await call(sub, '/v1/me', 'GET', undefined, headers)).profile.handle).toBeNull();
  expect(
    (await call(sub, '/v1/goals', 'GET', undefined, { 'x-account-incarnation': '' })).statusCode,
  ).toBe(409);
});

it.each([
  ['profile', '/v1/me', 'PATCH', () => ({ locale: 'fr' }), { 'if-match': '2' }, 'PROFILE'],
  ['goals', '/v1/goals', 'PUT', () => ({ goals: [goal()] }), {}, 'GOALSET#'],
  ['device', '/v1/devices', 'POST', device, {}, 'DEVICE#'],
  [
    'usage',
    '/v1/usage/sync',
    'POST',
    () => ({ days: [day()] }),
    { 'idempotency-key': randomUUID() },
    'DAY#',
  ],
  ['invite', '/v1/friends/invites', 'POST', () => undefined, {}, 'INVITE'],
])(
  'rejects a %s transaction paused until after deletion and re-registration',
  async (_name, path, method, body, headers, prefix) => {
    const sub = await sharedUser();
    const old = ownerOf(sub);
    const paused = pauseTransaction(has(prefix));
    const request = call(sub, path, method, body(), headers);
    try {
      await paused.ready;
      expect((await remove(sub)).statusCode).toBe(200);
      const fresh = bodyOf(await register(sub, old)).incarnation;
      paused.release();
      expect((await request).statusCode).toBe(409);
      expect(await rows(old)).toEqual([]);
      expect((await rows(fresh)).map((r) => r.sk)).toEqual(['PROFILE']);
    } finally {
      paused.release();
      await request;
    }
  },
);

it('a friendship transaction paused before its final write cannot write to either owner after peer deletion', async () => {
  const a = await sharedUser(),
    b = await sharedUser();
  const handle = bodyOf(await call(b, '/v1/me')).profile.handle;
  const snapshot = await rows(ownerOf(a));
  const paused = pauseTransaction(has('FRIEND#'));
  const request = call(a, '/v1/friends/requests', 'POST', { handle });
  try {
    await paused.ready;
    expect((await remove(b)).statusCode).toBe(200);
    paused.release();
    expect((await request).statusCode).toBe(409);
    expect(await rows(ownerOf(a))).toEqual(snapshot);
    expect(await rows(ownerOf(b))).toEqual([]);
  } finally {
    paused.release();
    await request;
  }
});

it.each([
  'device removal',
  'friend acceptance',
  'friend rejection',
  'friend removal',
  'challenge creation',
  'challenge join',
  'challenge leave',
])('fences delayed %s at its final transaction', async (operation) => {
  const a = await sharedUser(),
    b = await sharedUser();
  let path,
    method = 'POST',
    body,
    prefix;
  if (operation.startsWith('friend')) {
    const handle = bodyOf(await call(a, '/v1/me')).profile.handle;
    expect((await call(b, '/v1/friends/requests', 'POST', { handle })).statusCode).toBe(200);
    path = operation === 'friend removal' ? '/v1/friends/remove' : '/v1/friends/respond';
    body =
      operation === 'friend removal'
        ? { userId: b }
        : { userId: b, accept: operation === 'friend acceptance' };
    prefix = 'FRIEND#';
  } else if (operation === 'device removal') {
    const value = device();
    await call(a, '/v1/devices', 'POST', value);
    path = `/v1/devices/${value.deviceId}`;
    method = 'DELETE';
    prefix = 'DEVICE#';
  } else {
    const today = new Date().toISOString().slice(0, 10);
    const spec = {
      title: 'Lifecycle fixture',
      metric: 'fewest_minutes',
      startDate: today,
      endDate: today,
      tz: 'UTC',
      maxMembers: 5,
    };
    if (operation === 'challenge creation') {
      path = '/v1/challenges';
      body = spec;
      prefix = 'META';
    } else {
      const invite = bodyOf(await call(b, '/v1/friends/invites', 'POST')).code;
      expect(
        (await call(a, '/v1/friends/requests', 'POST', { inviteCode: invite })).statusCode,
      ).toBe(200);
      const id = bodyOf(await call(b, '/v1/challenges', 'POST', spec)).challengeId;
      if (operation === 'challenge leave')
        expect((await call(a, `/v1/challenges/${id}/join`, 'POST')).statusCode).toBe(200);
      path = `/v1/challenges/${id}/${operation === 'challenge join' ? 'join' : 'leave'}`;
      prefix = 'META';
    }
  }
  const paused = pauseTransaction(has(prefix));
  const work = call(a, path, method, body);
  try {
    await paused.ready;
    expect((await remove(a)).statusCode).toBe(200);
    const fresh = bodyOf(await register(a, ownerOf(a))).incarnation;
    const other = await rows(ownerOf(b));
    paused.release();
    expect((await work).statusCode).toBe(409);
    expect(await rows(ownerOf(b))).toEqual(other);
    expect((await rows(fresh)).map((r) => r.sk)).toEqual(['PROFILE']);
  } finally {
    paused.release();
    await work;
  }
});

it('linked purchase supersession cannot modify an old purchase after deletion', async () => {
  const sub = await sharedUser(),
    old = ownerOf(sub),
    token = `old-link-${randomUUID()}`;
  expect((await billing(sub, token)()).statusCode).toBe(200);
  setBillingDeps({
    config: { packageName: 'fixture.pkg', proProducts: new Set(['driftless_pro']) },
    play: {
      getSubscription: async () => ({
        subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
        linkedPurchaseToken: token,
        externalAccountIdentifiers: { obfuscatedExternalAccountId: obfuscatedAccountId(old) },
        lineItems: [
          { productId: 'driftless_pro', expiryTime: new Date(Date.now() + 3600_000).toISOString() },
        ],
      }),
      acknowledge: vi.fn(),
    },
  });
  const paused = pauseTransaction((items) =>
    items.some((i) => i.Update?.UpdateExpression.includes('supersededBy')),
  );
  const work = call(sub, '/v1/billing/play/verify', 'POST', {
    productId: 'driftless_pro',
    purchaseToken: `new-link-${randomUUID()}`,
  });
  try {
    await paused.ready;
    expect((await remove(sub)).statusCode).toBe(200);
    const fresh = bodyOf(await register(sub, old)).incarnation;
    paused.release();
    expect((await work).statusCode).toBe(409);
    expect((await rows(fresh)).map((r) => r.sk)).toEqual(['PROFILE']);
  } finally {
    paused.release();
    await work;
  }
});

it('concurrent deletion retries decrement membership once and keep the closed barrier durable', async () => {
  const a = await sharedUser();
  const today = new Date().toISOString().slice(0, 10);
  const id = bodyOf(
    await call(a, '/v1/challenges', 'POST', {
      title: 'Concurrent deletion fixture',
      metric: 'fewest_minutes',
      startDate: today,
      endDate: today,
      tz: 'UTC',
      maxMembers: 5,
    }),
  ).challengeId;
  const results = await Promise.all([remove(a), remove(a)]);
  expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
  expect((await readState({ pk: `CHAL#${id}`, sk: 'META' })).memberCount).toBe(0);
  expect((await readState(incarnationKey(ownerOf(a)))).state).toBe('deleted');
});

it('cleanup survives interruption without losing reciprocal references and never changes an unrelated account', async () => {
  const a = await sharedUser(),
    b = await sharedUser(),
    c = await sharedUser();
  const handle = bodyOf(await call(b, '/v1/me')).profile.handle;
  await call(a, '/v1/friends/requests', 'POST', { handle });
  const other = await rows(ownerOf(c));
  const real = ddb().send.bind(ddb());
  let failed = false;
  const spy = vi.spyOn(ddb(), 'send').mockImplementation((command) => {
    if (
      !failed &&
      command instanceof TransactWriteCommand &&
      has('FRIEND#')(command.input.TransactItems)
    ) {
      failed = true;
      return Promise.reject(new Error('isolated cleanup interruption'));
    }
    return real(command);
  });
  expect((await remove(a)).statusCode).toBe(500);
  spy.mockRestore();
  expect((await readState(incarnationKey(ownerOf(a)))).state).toBe('deleting');
  expect((await register(a, ownerOf(a))).statusCode).toBe(409);
  expect((await rows(ownerOf(a))).some((r) => r.sk.startsWith('FRIEND#'))).toBe(true);
  expect((await remove(a)).statusCode).toBe(200);
  expect((await remove(a)).statusCode).toBe(200);
  expect((await rows(ownerOf(b))).some((r) => r.sk.startsWith('FRIEND#'))).toBe(false);
  expect(await rows(ownerOf(c))).toEqual(other);
  expect(
    (
      await call(c, '/v1/account/delete', 'POST', undefined, {
        'x-account-incarnation': ownerOf(b),
      })
    ).statusCode,
  ).toBe(409);
});

function billing(sub, token) {
  const subscription = {
    subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
    lineItems: [
      { productId: 'driftless_pro', expiryTime: new Date(Date.now() + 3600_000).toISOString() },
    ],
    externalAccountIdentifiers: { obfuscatedExternalAccountId: obfuscatedAccountId(ownerOf(sub)) },
  };
  const getSubscription = vi.fn(async () => subscription);
  setBillingDeps({
    play: { getSubscription, acknowledge: vi.fn() },
    config: {
      packageName: 'fixture.pkg',
      proProducts: new Set(['driftless_pro']),
      rtdnServiceAccount: 'fixture@example.test',
    },
    verifier: { verify: async () => ({ email: 'fixture@example.test', email_verified: true }) },
  });
  return () =>
    call(sub, '/v1/billing/play/verify', 'POST', {
      productId: 'driftless_pro',
      purchaseToken: token,
    });
}

it('different concurrent registration operations produce exactly one active incarnation', async () => {
  const sub = newSub();
  const results = await Promise.all([register(sub), register(sub)]);
  expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  const current = await readState(accountKey(sub));
  expect((await rows(current.incarnation)).map((r) => r.sk)).toEqual(['PROFILE']);
});

it('a missing active profile fails closed and is never repaired by GET /me', async () => {
  const sub = await newAccount();
  await ddb().send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Delete: {
            TableName: tableName(),
            Key: { pk: Keys.user(ownerOf(sub)), sk: 'PROFILE' },
          },
        },
      ],
    }),
  );
  expect((await call(sub, '/v1/me')).statusCode).toBe(409);
  expect(await rows(ownerOf(sub))).toEqual([]);
});

it('a final write is rejected while deletion is interrupted with its barrier already closed', async () => {
  const sub = await sharedUser();
  const paused = pauseTransaction(has('DEVICE#'));
  const work = call(sub, '/v1/devices', 'POST', device());
  await paused.ready;
  // Force an interruption only after the actual active -> deleting transition commits.
  const real = paused.send;
  const spy = vi.spyOn(ddb(), 'send').mockImplementation((command) => {
    if (
      command instanceof TransactWriteCommand &&
      command.input.TransactItems.some((i) => i.Delete)
    )
      return Promise.reject(new Error('cleanup unavailable'));
    return real(command);
  });
  try {
    expect((await remove(sub)).statusCode).toBe(500);
    expect((await readState(incarnationKey(ownerOf(sub)))).state).toBe('deleting');
    paused.release();
    expect((await work).statusCode).toBe(409);
  } finally {
    paused.release();
    await work;
    spy.mockRestore();
  }
});

it.each(['claim', 'completion', 'release', 'rate'])(
  'fences the idempotency %s/supporting-state mutation after deletion',
  async (boundary) => {
    const sub = await sharedUser();
    const { withIdempotency } = await import('../src/lib/idempotency.js');
    const { rateLimit } = await import('../src/lib/rate.js');
    const { json, HttpError } = await import('../src/lib/http.js');
    const key = randomUUID();
    const paused = pauseTransaction((items) =>
      items.some((i) => {
        const op = boundary === 'claim' ? i.Put : i.Update;
        const pk = op?.Item?.pk ?? op?.Key?.pk;
        return (
          pk?.startsWith(boundary === 'rate' ? 'RATE#' : 'IDEM#') &&
          (boundary !== 'release' || op.UpdateExpression.includes('startedAt'))
        );
      }),
    );
    const work =
      boundary === 'rate'
        ? rateLimit(ownerOf(sub), 'fixture', 10, 3600)
        : withIdempotency(
            event({
              sub,
              method: 'POST',
              path: '/v1/usage/sync',
              headers: { 'idempotency-key': key },
            }),
            ownerOf(sub),
            '{}',
            async () => {
              if (boundary === 'release') throw new HttpError(503, 'fixture_failed', 'fixture');
              return json(200, {});
            },
          );
    // Attach rejection handling immediately; no unhandled rejection while arranging the race.
    const settled = work.then(
      () => null,
      (error) => error,
    );
    try {
      await paused.ready;
      expect((await remove(sub)).statusCode).toBe(200);
      const fresh = bodyOf(await register(sub, ownerOf(sub))).incarnation;
      paused.release();
      expect((await settled).code).toBe(
        boundary === 'release' ? 'fixture_failed' : 'account_inactive',
      );
      expect((await rows(fresh)).map((r) => r.sk)).toEqual(['PROFILE']);
      if (boundary !== 'rate') {
        const record = await readState(Keys.idem(ownerOf(sub), key));
        if (boundary === 'claim') expect(record).toBeUndefined();
        if (boundary === 'completion') expect(record.status).toBe('in_progress');
        if (boundary === 'release') expect(record.startedAt).toBeGreaterThan(0);
      }
    } finally {
      paused.release();
      await settled;
    }
  },
);

it.each(['verify', 'rtdn', 'reconcile'])(
  '%s delayed provider response cannot write after deletion/re-registration',
  async (mode) => {
    const sub = await sharedUser(),
      old = ownerOf(sub),
      token = `provider-delay-${randomUUID()}`;
    const verify = billing(sub, token);
    if (mode !== 'verify') expect((await verify()).statusCode).toBe(200);
    let release, reached;
    const ready = new Promise((r) => {
      reached = r;
    });
    const gate = new Promise((r) => {
      release = r;
    });
    setBillingDeps({
      config: {
        packageName: 'fixture.pkg',
        proProducts: new Set(['driftless_pro']),
        rtdnServiceAccount: 'fixture@example.test',
      },
      play: {
        getSubscription: async () => {
          reached();
          await gate;
          return {
            subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
            lineItems: [
              {
                productId: 'driftless_pro',
                expiryTime: new Date(Date.now() + 3600_000).toISOString(),
              },
            ],
            externalAccountIdentifiers: { obfuscatedExternalAccountId: obfuscatedAccountId(old) },
          };
        },
        acknowledge: vi.fn(),
      },
      verifier: { verify: async () => ({ email: 'fixture@example.test', email_verified: true }) },
    });
    if (mode === 'reconcile') {
      const entitlement = await readState({ pk: Keys.user(old), sk: 'ENTITLEMENT' });
      const real = ddb().send.bind(ddb());
      vi.spyOn(ddb(), 'send').mockImplementation((command) =>
        command instanceof QueryCommand &&
        command.input.ExpressionAttributeValues?.[':p'] === 'ENT#play'
          ? Promise.resolve({ Items: [entitlement] })
          : real(command),
      );
    }
    const work =
      mode === 'verify'
        ? verify()
        : mode === 'reconcile'
          ? reconcilePlay()
          : call(
              null,
              '/webhooks/play-rtdn',
              'POST',
              {
                message: {
                  messageId: randomUUID(),
                  data: Buffer.from(
                    JSON.stringify({ subscriptionNotification: { purchaseToken: token } }),
                  ).toString('base64'),
                },
              },
              { authorization: 'Bearer fixture' },
            );
    try {
      await ready;
      expect((await remove(sub)).statusCode).toBe(200);
      const fresh = bodyOf(await register(sub, old)).incarnation;
      release();
      const result = await work;
      if (mode === 'verify') expect(result.statusCode).toBe(409);
      if (mode === 'rtdn') expect(result.statusCode).toBe(200);
      expect(await rows(old)).toEqual([]);
      expect((await rows(fresh)).map((r) => r.sk)).toEqual(['PROFILE']);
    } finally {
      release();
      await work;
    }
  },
);

it.each(['handle', 'friend', 'member', 'purchase', 'invite', 'owner', 'partition', 'completion'])(
  'cleanup resumes after an acknowledged-as-failed %s boundary',
  async (boundary) => {
    const a = await sharedUser(),
      b = await sharedUser(),
      unrelated = await sharedUser();
    const old = ownerOf(a),
      peer = ownerOf(b);
    const handle = bodyOf(await call(a, '/v1/me')).profile.handle;
    await call(a, '/v1/friends/requests', 'POST', {
      handle: bodyOf(await call(b, '/v1/me')).profile.handle,
    });
    await call(b, '/v1/friends/respond', 'POST', { userId: a, accept: true });
    const today = new Date().toISOString().slice(0, 10);
    const challenge = bodyOf(
      await call(a, '/v1/challenges', 'POST', {
        title: 'Disposable fixture',
        metric: 'fewest_minutes',
        startDate: today,
        endDate: today,
        tz: 'UTC',
        maxMembers: 5,
      }),
    ).challengeId;
    expect((await call(b, `/v1/challenges/${challenge}/join`, 'POST')).statusCode).toBe(200);
    const invite = bodyOf(await call(a, '/v1/friends/invites', 'POST')).code;
    const token = `cleanup-purchase-${randomUUID()}`;
    expect((await billing(a, token)()).statusCode).toBe(200);
    const snapshot = await rows(ownerOf(unrelated));
    const real = ddb().send.bind(ddb());
    let failed = false;
    const spy = vi.spyOn(ddb(), 'send').mockImplementation(async (command) => {
      const result = await real(command);
      if (!failed && command instanceof TransactWriteCommand) {
        const items = command.input.TransactItems;
        const match =
          boundary === 'handle'
            ? items.some((i) => i.Delete?.Key.pk.startsWith('HANDLE#'))
            : boundary === 'friend'
              ? has('FRIEND#')(items)
              : boundary === 'member'
                ? has(`MEMBER#${old}`)(items)
                : boundary === 'purchase'
                  ? items.some((i) => i.Update?.UpdateExpression.includes('disabled'))
                  : boundary === 'invite'
                    ? items.some((i) => i.Delete?.Key.pk === `INVITE#${invite}`)
                    : boundary === 'owner'
                      ? items.some(
                          (i) => i.Update?.UpdateExpression === 'REMOVE ownerId, ownerUserId',
                        )
                      : boundary === 'partition'
                        ? has('PROFILE')(items) &&
                          items.some((i) => i.Delete?.Key.pk === Keys.user(old))
                        : items.some(
                            (i) => i.Update?.ExpressionAttributeValues?.[':deleted'] === 'deleted',
                          );
        if (match) {
          failed = true;
          throw new Error('simulated response loss after commit');
        }
      }
      return result;
    });
    expect((await remove(a)).statusCode).toBe(500);
    spy.mockRestore();
    expect(failed).toBe(true);
    expect((await remove(a)).statusCode).toBe(200);
    expect((await remove(a)).statusCode).toBe(200);
    expect(await rows(old)).toEqual([]);
    expect(await readState(Keys.handle(handle))).toBeUndefined();
    expect(await readState({ pk: Keys.user(peer), sk: `FRIEND#${old}` })).toBeUndefined();
    expect(await readState({ pk: `CHAL#${challenge}`, sk: `MEMBER#${old}` })).toBeUndefined();
    const meta = await readState({ pk: `CHAL#${challenge}`, sk: 'META' });
    expect(meta.memberCount).toBe(1);
    expect(meta.ownerId).toBeUndefined();
    expect(meta.ownerUserId).toBeUndefined();
    expect(await readState({ pk: `INVITE#${invite}`, sk: 'INVITE' })).toBeUndefined();
    expect(await rows(ownerOf(unrelated))).toEqual(snapshot);
    const summary = bodyOf(await call(b, '/v1/challenges')).challenges[0];
    expect(summary).toMatchObject({ ownerId: null, memberCount: 1 });
  },
);
it.each(['verify', 'rtdn', 'reconcile'])(
  '%s paused at final entitlement transaction cannot restore a deleted incarnation',
  async (mode) => {
    const sub = await sharedUser(),
      old = ownerOf(sub);
    const token = `fixture-token-${randomUUID()}`;
    const verify = billing(sub, token);
    if (mode !== 'verify') expect((await verify()).statusCode).toBe(200);
    // Select only this disposable billing fixture; final writes still use real DynamoDB conditions.
    const entitlement =
      mode === 'reconcile' ? await readState({ pk: Keys.user(old), sk: 'ENTITLEMENT' }) : null;
    const paused = pauseTransaction(has('ENTITLEMENT'), entitlement);
    const work =
      mode === 'verify'
        ? verify()
        : mode === 'reconcile'
          ? reconcilePlay()
          : call(
              null,
              '/webhooks/play-rtdn',
              'POST',
              {
                message: {
                  messageId: randomUUID(),
                  data: Buffer.from(
                    JSON.stringify({
                      packageName: 'fixture.pkg',
                      subscriptionNotification: { purchaseToken: token },
                    }),
                  ).toString('base64'),
                },
              },
              { authorization: 'Bearer fixture' },
            );
    try {
      await paused.ready;
      expect((await remove(sub)).statusCode).toBe(200);
      const fresh = bodyOf(await register(sub, old)).incarnation;
      paused.release();
      const result = await work;
      if (mode === 'verify') expect(result.statusCode).toBe(409);
      if (mode === 'rtdn') expect(bodyOf(result)).toEqual({ ignored: 'inactive account' });
      expect(await rows(old)).toEqual([]);
      expect((await rows(fresh)).map((r) => r.sk)).toEqual(['PROFILE']);
      expect((await verify()).statusCode).toBe(409);
      const rebind = await call(
        sub,
        '/v1/billing/play/verify',
        'POST',
        { productId: 'driftless_pro', purchaseToken: token },
        { 'x-account-incarnation': fresh },
      );
      expect(rebind.statusCode).toBe(403); // Google purchase binding is incarnation-specific, too.
    } finally {
      paused.release();
      await work;
    }
  },
);
