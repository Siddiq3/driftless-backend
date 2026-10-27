import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
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
  expect(page.body).toContain('Study Garage invited you');
  expect(page.body).toContain('Google Play · coming soon');
  expect(page.body).not.toContain(ownerOf(a));
  writeFileSync('/private/tmp/scrollsnooze-war-invite.html', page.body);
  expect(bodyOf(await call('GET', `/v1/battles/invites/${code}`, b))).toMatchObject({
    code,
    inviterName: 'Study Garage',
    isSelf: false,
  });
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
it('escaped names and expired/deleted-owner invites are safe', async () => {
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
  expect(page.body).toContain('&lt;script&gt;');
  expect(page.body).not.toContain('<script>alert(1)</script>');
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
    expect(page.body).toContain(`scrollsnooze://battle-invite?code=${code}`);
    expect(page.body).toContain(`referrer=battle_invite%3D${code}`);
    expect(page.body).not.toContain('Copy invitation code');
    expect(page.body).not.toContain('<code>');
    expect(page.body).not.toContain('enter this invitation code');
    expect(page.body).toContain('reopen this invitation after installing');
  } finally {
    if (previous === undefined) delete process.env.PLAY_STORE_URL;
    else process.env.PLAY_STORE_URL = previous;
  }
});
