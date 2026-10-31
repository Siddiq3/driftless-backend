import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { localDateOf, addDays } from '@siddiq3/driftless-contracts/domain';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { route } from '../src/router.js';
import { readState } from '../src/lib/lifecycle.js';
import { ddb, tableName, Keys } from '../src/lib/ddb.js';
import { bodyOf, event, newAccount, ownerOf } from './helpers.js';
const call = (method, path, sub, body, query) => route(event({ method, path, sub, body, query }));
const today = localDateOf(Date.now(), 'UTC');
let n = 0;
async function user() {
  const sub = await newAccount();
  const r = await route(
    event({
      method: 'PATCH',
      path: '/v1/me',
      sub,
      body: {
        handle: `b${Date.now().toString(36)}${n++}`,
        displayName: 'Study Garage',
        consent: { cloudSync: true, shareWithFriends: false },
      },
      headers: { 'if-match': '1' },
    }),
  );
  expect(r.statusCode).toBe(200);
  return sub;
}
async function invite(sub) {
  const r = await call('POST', '/v1/battles/invites', sub, { scoreConsent: true });
  expect(r.statusCode).toBe(200);
  return bodyOf(r).code;
}
const accept = (sub, code) =>
  call('POST', `/v1/battles/invites/${code}/accept`, sub, { scoreConsent: true });
const daily = (sub, date = today) => call('GET', '/v1/battles/daily', sub, undefined, { date });
async function sync(sub, views) {
  const r = await route(
    event({
      method: 'POST',
      path: '/v1/usage/sync',
      sub,
      body: {
        days: [
          {
            localDate: today,
            tz: 'UTC',
            platform: 'android',
            deviceId: randomUUID(),
            views,
            adViews: null,
            minutes: 5,
            coverage: 1,
            rev: 1,
          },
        ],
      },
      headers: { 'idempotency-key': randomUUID() },
    }),
  );
  expect(r.statusCode).toBe(200);
}
it('requires explicit consent; public page contains no account data and downloads are unreleased', async () => {
  const a = await user(),
    b = await user();
  expect((await call('POST', '/v1/battles/invites', a, {})).statusCode).toBe(400);
  const code = await invite(a);
  const page = await call('GET', `/join/${code}`, null);
  expect(page.statusCode).toBe(200);
  expect(page.body).toContain('A friend invited you');
  expect(page.body).toContain('<title>Join the ScrollSnooze Friends Leaderboard</title>');
  expect(page.body).toContain('alt=""');
  expect(page.body).not.toMatch(/Study Garage|battle<\/title>|alt="versus"/);
  expect(page.body).toContain('Download to join');
  expect(page.body).not.toContain('<footer');
  expect(page.body).not.toContain(ownerOf(a));
  const preview = bodyOf(await call('GET', `/v1/battles/invites/${code}`, b));
  expect(Object.keys(preview).sort()).toEqual(['code', 'expiresAt', 'isSelf']);
  expect(preview).toMatchObject({ code, isSelf: false });
  expect(JSON.stringify(preview)).not.toContain(bodyOf(await call('GET', '/v1/me', a)).userId);
  expect(bodyOf(await daily(b)).friends).toEqual([]);
  expect((await call('POST', `/v1/battles/invites/${code}/accept`, b, {})).statusCode).toBe(400);
  expect((await accept(a, code)).statusCode).toBe(400);
  expect((await call('POST', '/v1/friends/requests', b, { inviteCode: code })).statusCode).toBe(
    409,
  );
  expect((await accept(b, code)).statusCode).toBe(200);
  expect(bodyOf(await call('GET', '/v1/me', b)).profile.consent.shareWithFriends).toBe(false);
});
it('concurrent acceptance creates one reciprocal friend; missing counts stay null and zero stays real', async () => {
  const a = await user(),
    b = await user(),
    code = await invite(a);
  expect((await Promise.all([accept(b, code), accept(b, code)])).map((r) => r.statusCode)).toEqual([
    200, 200,
  ]);
  expect((await accept(b, code)).statusCode).toBe(200);
  const empty = bodyOf(await daily(a));
  expect(empty.friends).toHaveLength(1);
  expect(empty.friends[0].daily.views).toBeNull();
  await sync(a, 0);
  await sync(b, 6);
  const result = bodyOf(await daily(a));
  expect(result.self.views).toBe(0);
  expect(result.friends[0].daily.views).toBe(6);
  expect(bodyOf(await daily(a, addDays(today, -1))).friends[0].daily.views).toBeNull();
});
it('remove immediately hides scores and consumed links cannot resurrect a removed battle', async () => {
  const a = await user(),
    b = await user(),
    code = await invite(a);
  await accept(b, code);
  await sync(a, 12);
  expect(bodyOf(await daily(b)).friends[0].daily.views).toBe(12);
  expect((await call('POST', '/v1/friends/remove', a, { userId: b })).statusCode).toBe(200);
  expect(bodyOf(await daily(b)).friends).toEqual([]);
  expect((await accept(b, code)).statusCode).toBe(409);
  expect((await accept(b, await invite(a))).statusCode).toBe(200);
});
it('ordinary friendship grants no battle access; accepting preserves its relationship version', async () => {
  const a = await user(),
    b = await user(),
    ordinary = bodyOf(await call('POST', '/v1/friends/invites', a)).code;
  await call('POST', '/v1/friends/requests', b, { inviteCode: ordinary });
  const key = { pk: Keys.user(ownerOf(a)), sk: `FRIEND#${ownerOf(b)}` },
    before = await readState(key);
  expect(bodyOf(await daily(a)).friends).toEqual([]);
  await accept(b, await invite(a));
  expect((await readState(key)).since).toBe(before.since);
});
it('stored names never reach the page, and expired/deleted-owner invites are safe', async () => {
  const a = await user(),
    b = await user(),
    code = await invite(a);
  await ddb().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: { pk: Keys.user(ownerOf(a)), sk: Keys.profile },
      UpdateExpression: 'SET displayName = :n',
      ExpressionAttributeValues: { ':n': '<script>alert(1)</script>' },
    }),
  );
  const page = await call('GET', `/join/${code}`, null);
  expect(page.body).not.toContain('alert(1)');
  await ddb().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: { pk: `INVITE#${code}`, sk: 'INVITE' },
      UpdateExpression: 'SET #t = :t',
      ExpressionAttributeNames: { '#t': 'ttl' },
      ExpressionAttributeValues: { ':t': 1 },
    }),
  );
  expect((await call('GET', `/join/${code}`, null)).statusCode).toBe(404);
  expect((await accept(b, code)).statusCode).toBe(404);
  const next = await invite(a);
  await call('POST', '/v1/account/delete', a);
  expect((await call('GET', `/join/${next}`, null)).statusCode).toBe(404);
  expect([404, 409]).toContain((await accept(b, next)).statusCode);
});
it('association identities are empty until actual signing identities are configured', async () => {
  expect(bodyOf(await call('GET', '/.well-known/assetlinks.json', null))).toEqual([]);
});

it('join page hides invite codes and carries the opaque link through Google Play install referrer', async () => {
  const a = await user(),
    code = await invite(a);
  const previous = process.env.PLAY_STORE_URL;
  process.env.PLAY_STORE_URL =
    'https://play.google.com/store/apps/details?id=com.siddiqkolimi.scrollsnooze';
  try {
    const page = await call('GET', `/join/${code}`, null);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Download to join');
    expect(page.body).toContain(`referrer=battle_invite%3D${code}`);
    expect(page.body).not.toContain('Copy invitation code');
    expect(page.body).not.toContain('<code>');
    expect(page.body).not.toContain('enter this invitation code');
    expect(page.body).not.toContain('Setup &amp; downloads');
    expect(page.body).not.toContain('Accepting adds your friend');
  } finally {
    if (previous === undefined) delete process.env.PLAY_STORE_URL;
    else process.env.PLAY_STORE_URL = previous;
  }
});

const count = (sub, views, personalViews) =>
  route(
    event({
      method: 'POST',
      path: '/v1/usage/sync',
      sub,
      body: {
        days: [
          {
            localDate: today,
            tz: 'UTC',
            platform: 'android',
            deviceId: randomUUID(),
            views,
            personalViews,
            adViews: null,
            minutes: 5,
            rev: 1,
          },
        ],
      },
      headers: { 'idempotency-key': randomUUID() },
    }),
  );
it('a link connects exactly one person; later people are told it is used', async () => {
  const a = await user(),
    b = await user(),
    c = await user(),
    code = await invite(a);
  expect((await accept(b, code)).statusCode).toBe(200);
  const second = await accept(c, code);
  expect(second.statusCode).toBe(409);
  expect(bodyOf(second).code).toBe('invite_used');
  expect(bodyOf(await call('GET', `/v1/battles/invites/${code}`, c)).code).toBe('invite_used');
  expect((await call('GET', `/join/${code}`, null)).body).toContain('no longer available');
  expect(bodyOf(await daily(a)).friends).toHaveLength(1);
  expect(bodyOf(await daily(c)).friends).toEqual([]);
  // A lost reply can retry without adding anyone.
  expect((await accept(b, code)).statusCode).toBe(200);
  expect(bodyOf(await daily(a)).friends).toHaveLength(1);
});
it('two people accepting at once can never both succeed', async () => {
  for (let round = 0; round < 3; round++) {
    const a = await user(),
      people = await Promise.all([user(), user(), user()]),
      code = await invite(a);
    const results = await Promise.all(people.map((p) => accept(p, code)));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    for (const r of results.filter((x) => x.statusCode !== 200)) expect(r.statusCode).toBe(409);
    expect(bodyOf(await daily(a)).friends).toHaveLength(1);
  }
});
it('invitations created before single use still work once', async () => {
  const a = await user(),
    b = await user(),
    c = await user(),
    code = await invite(a);
  expect((await readState({ pk: `INVITE#${code}`, sk: 'INVITE' })).consumedBy).toBeUndefined();
  expect((await accept(b, code)).statusCode).toBe(200);
  expect((await accept(c, code)).statusCode).toBe(409);
});
it('malformed links are not found', async () => {
  const b = await user();
  expect((await accept(b, 'bad')).statusCode).toBe(404);
  expect((await call('GET', '/v1/battles/invites/bad', b)).statusCode).toBe(404);
});
it('nothing is shared before acceptance, and only the name and count after', async () => {
  const a = await user(),
    b = await user(),
    code = await invite(a);
  await count(b, 7, 7);
  expect(bodyOf(await daily(a)).friends).toEqual([]);
  await accept(b, code);
  const { friends } = bodyOf(await daily(a));
  expect(friends[0].displayName).toBe('Study Garage');
  expect(friends[0].daily.views).toBe(7);
  expect(JSON.stringify(friends)).not.toMatch(/minutes|deviceId|adViews|tz/);
});
it('the sharing setting does not control the leaderboard; account backup does', async () => {
  const a = await user(),
    b = await user();
  await accept(b, await invite(a));
  await count(b, 7, 7);
  expect(bodyOf(await call('GET', '/v1/me', b)).profile.consent.shareWithFriends).toBe(false);
  expect(bodyOf(await daily(a)).friends[0].daily.views).toBe(7);
  const rev = bodyOf(await call('GET', '/v1/me', b)).profile.rev;
  await route(
    event({
      method: 'PATCH',
      path: '/v1/me',
      sub: b,
      body: { consent: { cloudSync: false } },
      headers: { 'if-match': String(rev) },
    }),
  );
  expect(bodyOf(await daily(a)).friends[0].daily.views).toBeNull();
});
it('removing a friend ends access both ways, including earlier days', async () => {
  const a = await user(),
    b = await user();
  await accept(b, await invite(a));
  await count(b, 7, 7);
  expect(bodyOf(await daily(a)).friends).toHaveLength(1);
  await call('POST', '/v1/friends/remove', a, {
    userId: bodyOf(await call('GET', '/v1/me', b)).userId,
  });
  expect(bodyOf(await daily(a)).friends).toEqual([]);
  expect(bodyOf(await daily(b)).friends).toEqual([]);
  expect(bodyOf(await daily(a, addDays(today, -1))).friends).toEqual([]);
});
it('flags experimental totals, and not verified ones', async () => {
  const a = await user(),
    b = await user(),
    c = await user();
  await accept(b, await invite(a));
  await accept(c, await invite(a));
  await count(a, 3, 3);
  await count(b, null, 7);
  await count(c, 4, 4);
  const board = bodyOf(await daily(a));
  expect(board.self.experimental).toBe(false);
  const views = Object.fromEntries(board.friends.map((f) => [f.daily.views, f.daily.experimental]));
  expect(views).toEqual({ 7: true, 4: false });
});
it('a missing Google name stays null and the page never shows the handle', async () => {
  const a = await newAccount(),
    b = await user();
  const handle = `n${Date.now().toString(36)}${n++}`;
  await route(
    event({
      method: 'PATCH',
      path: '/v1/me',
      sub: a,
      body: { handle, consent: { cloudSync: true, shareWithFriends: false } },
      headers: { 'if-match': '1' },
    }),
  );
  const code = await invite(a);
  const page = await call('GET', `/join/${code}`, null);
  expect(page.body).toContain('A friend invited you');
  expect(page.body).not.toContain(handle);
  expect(JSON.stringify(bodyOf(await call('GET', `/v1/battles/invites/${code}`, b)))).not.toContain(
    handle,
  );
  await accept(b, code);
  expect(bodyOf(await daily(b)).friends[0].displayName).toBeNull();
});
it('friends get the name only after acceptance; a used link stops showing it', async () => {
  const a = await user(),
    b = await user(),
    c = await user(),
    code = await invite(a);
  for (const sub of [a, b]) {
    expect(JSON.stringify(bodyOf(await daily(sub)))).not.toContain('Study Garage');
    expect(JSON.stringify(bodyOf(await call('GET', '/v1/friends', sub)))).not.toContain(
      'Study Garage',
    );
  }
  await accept(b, code);
  expect(bodyOf(await daily(a)).friends[0].displayName).toBe('Study Garage');
  expect(bodyOf(await call('GET', '/v1/friends', b)).friends[0].displayName).toBe('Study Garage');
  const page = await call('GET', `/join/${code}`, null);
  expect(page.statusCode).toBe(404);
  expect(page.body).not.toContain('Study Garage');
  expect(JSON.stringify(bodyOf(await call('GET', `/v1/battles/invites/${code}`, c)))).not.toContain(
    'Study Garage',
  );
});
it('a removed friend cannot use the old preview, and it never held inviter details', async () => {
  const a = await user(),
    b = await user(),
    code = await invite(a);
  await accept(b, code);
  const retry = bodyOf(await call('GET', `/v1/battles/invites/${code}`, b));
  expect(JSON.stringify(retry)).not.toContain('Study Garage');
  const id = bodyOf(await call('GET', '/v1/me', a)).userId;
  expect(JSON.stringify(retry)).not.toContain(id);
  await call('POST', '/v1/friends/remove', b, { userId: id });
  const after = await call('GET', `/v1/battles/invites/${code}`, b);
  expect(after.statusCode).toBe(409);
  expect(after.body).not.toContain('Study Garage');
  expect((await accept(b, code)).statusCode).toBe(409);
});
it('used, expired and deleted-owner links reveal nothing to anyone', async () => {
  const a = await user(),
    b = await user(),
    c = await user(),
    used = await invite(a),
    expired = await invite(a),
    gone = await invite(a);
  await accept(b, used);
  await ddb().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: { pk: `INVITE#${expired}`, sk: 'INVITE' },
      UpdateExpression: 'SET #t = :t',
      ExpressionAttributeNames: { '#t': 'ttl' },
      ExpressionAttributeValues: { ':t': 1 },
    }),
  );
  const check = async (code) => {
    const page = await call('GET', `/join/${code}`, null),
      preview = await call('GET', `/v1/battles/invites/${code}`, c);
    expect(page.statusCode).toBe(404);
    expect(page.body).not.toContain('Study Garage');
    expect(preview.statusCode).toBeGreaterThanOrEqual(400);
    expect(preview.body).not.toContain('Study Garage');
  };
  await check(used);
  await check(expired);
  await call('POST', '/v1/account/delete', a);
  await check(gone);
});
it('a pending direct request exposes no name in either direction until accepted', async () => {
  const a = await user(),
    b = await user();
  const { handle } = bodyOf(await call('GET', '/v1/me', b)).profile;
  const made = await call('POST', '/v1/friends/requests', a, { handle });
  expect(made.statusCode).toBe(200);
  expect(bodyOf(made).friend).toMatchObject({ status: 'pending_out', displayName: null });
  expect(bodyOf(await call('GET', '/v1/friends', a)).friends[0].displayName).toBeNull();
  expect(bodyOf(await call('GET', '/v1/friends', b)).friends[0].displayName).toBeNull();
  await call('POST', '/v1/friends/respond', b, {
    userId: bodyOf(await call('GET', '/v1/me', a)).userId,
    accept: true,
  });
  expect(bodyOf(await call('GET', '/v1/friends', a)).friends[0].displayName).toBe('Study Garage');
  expect(bodyOf(await call('GET', '/v1/friends', b)).friends[0].displayName).toBe('Study Garage');
});
it('a signed-in real zero is not flagged; an unverified zero is', async () => {
  const a = await user(),
    b = await user();
  await accept(b, await invite(a));
  await count(a, 0, 0);
  await count(b, null, 0);
  const board = bodyOf(await daily(a));
  expect(board.self).toMatchObject({ views: 0, experimental: false });
  expect(board.friends[0].daily).toMatchObject({ views: 0, experimental: true });
});
