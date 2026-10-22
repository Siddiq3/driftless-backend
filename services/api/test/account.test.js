import { randomUUID } from 'node:crypto';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { v1 } from '@siddiq3/driftless-contracts';
import { localDateOf } from '@siddiq3/driftless-contracts/domain';
import { ddb, Keys, tableName } from '../src/lib/ddb.js';
import { route } from '../src/router.js';
import { bodyOf, event, newSub } from './helpers.js';
const call = (method, path, sub, body, claims) => route(event({ method, path, sub, body, claims }));
const today = localDateOf(Date.now(), 'UTC');
let n = 0;
async function user() {
  const sub = newSub();
  const handle = `d${Date.now().toString(36)}${(n++).toString(36)}`;
  await call('GET', '/v1/me', sub);
  await route(
    event({
      method: 'PATCH',
      path: '/v1/me',
      sub,
      body: { handle, consent: { cloudSync: true, shareWithFriends: true } },
      headers: { 'if-match': '1' },
    }),
  );
  return { sub, handle };
}
const rowsFor = async (sub) =>
  (
    await ddb().send(
      new QueryCommand({
        TableName: tableName(),
        KeyConditionExpression: 'pk = :p',
        ExpressionAttributeValues: { ':p': Keys.user(sub) },
      }),
    )
  ).Items ?? [];
describe('account deletion', () => {
  it('requires a recent sign-in', async () => {
    const a = await user();
    const old = Math.floor(Date.now() / 1000) - 3600;
    expect(
      (await call('POST', '/v1/account/delete', a.sub, undefined, { iat: old })).statusCode,
    ).toBe(403);
  });
  it('removes all data, frees the handle, unlinks friends and challenges, leaves Google identity ownership with Google', async () => {
    const a = await user();
    const b = await user();
    // friendship
    await call('POST', '/v1/friends/requests', a.sub, { handle: b.handle });
    await call('POST', '/v1/friends/respond', b.sub, { userId: a.sub, accept: true });
    // goals, usage, device
    await call('PUT', '/v1/goals', a.sub, {
      goals: [{ goalId: randomUUID(), metric: 'minutes', dailyLimit: 30, enabled: true, rev: 1 }],
    });
    await route(
      event({
        method: 'POST',
        path: '/v1/usage/sync',
        sub: a.sub,
        headers: { 'idempotency-key': randomUUID() },
        body: {
          days: [
            {
              localDate: today,
              tz: 'UTC',
              platform: 'android',
              deviceId: randomUUID(),
              views: null,
              adViews: null,
              minutes: 12,
              coverage: 1,
              rev: 1,
            },
          ],
        },
      }),
    );
    await call('POST', '/v1/devices', a.sub, {
      deviceId: randomUUID(),
      platform: 'android',
      pushToken: 'push-token-0123456789',
    });
    // challenge owned by b, joined by a
    const ch = v1.ChallengeSummary.parse(
      bodyOf(
        await call('POST', '/v1/challenges', b.sub, {
          title: 'Week',
          metric: 'fewest_minutes',
          startDate: today,
          endDate: today,
          tz: 'UTC',
          maxMembers: 5,
        }),
      ),
    );
    await call('POST', `/v1/challenges/${ch.challengeId}/join`, a.sub);
    expect((await rowsFor(a.sub)).length).toBeGreaterThan(3);
    const r = await call('POST', '/v1/account/delete', a.sub);
    expect(r.statusCode).toBe(200);
    expect(bodyOf(r).state).toBe('completed');
    expect(await rowsFor(a.sub)).toEqual([]);
    expect(
      v1.FriendsResponse.parse(bodyOf(await call('GET', '/v1/friends', b.sub))).friends,
    ).toEqual([]);
    const mine = v1.ChallengesResponse.parse(
      bodyOf(await call('GET', '/v1/challenges', b.sub)),
    ).challenges;
    expect(mine[0].memberCount).toBe(1);
    // The handle can be taken by someone else now.
    const c = newSub();
    await call('GET', '/v1/me', c);
    const take = await route(
      event({
        method: 'PATCH',
        path: '/v1/me',
        sub: c,
        body: { handle: a.handle },
        headers: { 'if-match': '1' },
      }),
    );
    expect(take.statusCode).toBe(200);
    // Status is readable afterwards (the job record isn't under USER#).
    expect(
      v1.DeletionStatus.parse(bodyOf(await call('GET', '/v1/account/delete', a.sub))).state,
    ).toBe('completed');
  });
  it('is idempotent', async () => {
    const a = await user();
    expect((await call('POST', '/v1/account/delete', a.sub)).statusCode).toBe(200);
    expect((await call('POST', '/v1/account/delete', a.sub)).statusCode).toBe(200);
  });
});
describe('data export', () => {
  it('returns my data without internal keys or push tokens', async () => {
    const a = await user();
    await call('POST', '/v1/devices', a.sub, {
      deviceId: randomUUID(),
      platform: 'android',
      pushToken: 'secret-push-token-xyz',
    });
    const r = await call('GET', '/v1/account/export', a.sub);
    expect(r.statusCode).toBe(200);
    const text = r.body ?? '';
    expect(text).toContain(a.handle);
    expect(text).not.toContain('secret-push-token-xyz');
    expect(text).not.toContain('"pk"');
    const kinds = JSON.parse(text).items.map((i) => i.kind);
    expect(kinds).toEqual(expect.arrayContaining(['profile', 'device']));
  });
});
