import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { v1 } from '@siddiq3/driftless-contracts';
import { addDays, localDateOf } from '@siddiq3/driftless-contracts/domain';
import { scoreMember } from '../src/modules/challenges.js';
import { route } from '../src/router.js';
import { bodyOf, event, newAccount } from './helpers.js';
const call = (method, path, sub, body, headers) =>
  route(event({ method, path, sub, body, headers }));
const today = localDateOf(Date.now(), 'UTC');
let n = 0;
/** A signed-up user with a handle; optionally sharing with friends. */
async function user(share = true) {
  const sub = await newAccount();
  const handle = `u${Date.now().toString(36)}${(n++).toString(36)}`.slice(0, 20);
  await call('GET', '/v1/me', sub);
  const r = await route(
    event({
      method: 'PATCH',
      path: '/v1/me',
      sub,
      body: { handle, consent: { cloudSync: true, shareWithFriends: share } },
      headers: { 'if-match': '1' },
    }),
  );
  expect(r.statusCode).toBe(200);
  return { sub, handle };
}
async function befriend(a, b) {
  expect((await call('POST', '/v1/friends/requests', a.sub, { handle: b.handle })).statusCode).toBe(
    200,
  );
  expect(
    (await call('POST', '/v1/friends/respond', b.sub, { userId: a.sub, accept: true })).statusCode,
  ).toBe(200);
}
const friends = async (sub) =>
  v1.FriendsResponse.parse(bodyOf(await call('GET', '/v1/friends', sub))).friends;
describe('daily friend comparisons', () => {
  const daily = (sub, date = today) =>
    route(event({ path: '/v1/friends/daily', sub, query: { date } }));
  const sync = async (
    sub,
    views,
    coverage = 1,
    deviceId = randomUUID(),
    rev = 1,
    personalViews,
  ) => {
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
              deviceId,
              views,
              ...(personalViews !== undefined ? { personalViews } : {}),
              adViews: null,
              minutes: 10,
              coverage,
              rev,
            },
          ],
        },
        headers: { 'idempotency-key': randomUUID() },
      }),
    );
    expect(r.statusCode).toBe(200);
  };
  it('compares recorded totals across devices without double counting approved views or losing zero', async () => {
    const a = await user(),
      b = await user();
    await befriend(a, b);
    const device = randomUUID();
    await sync(a.sub, 8, 0.01, device, 1, 73);
    await sync(a.sub, 8, 0.01, device, 1, 73); // Retry remains one device-day.
    await sync(a.sub, null, 0.01, randomUUID(), 1, 2);
    await sync(b.sub, null, 0, randomUUID(), 1, 0);
    const result = bodyOf(await daily(a.sub));
    expect(result.self).toMatchObject({ status: 'eligible', views: 75 });
    expect(result.friends[0].daily).toMatchObject({ status: 'eligible', views: 0 });
    // Withdrawing sharing still hides a recorded personal total.
    const me = await call('GET', '/v1/me', b.sub);
    await call(
      'PATCH',
      '/v1/me',
      b.sub,
      { consent: { shareWithFriends: false } },
      { 'if-match': String(bodyOf(me).profile.rev) },
    );
    expect(bodyOf(await daily(a.sub)).friends[0].daily).toMatchObject({
      status: 'private',
      views: null,
    });
  });
  it('compares eligible counts, combines devices, preserves zero and excludes pending/strangers', async () => {
    const a = await user(),
      b = await user(),
      c = await user(),
      pending = await user(),
      stranger = await user();
    await befriend(a, b);
    await befriend(a, c);
    await call('POST', '/v1/friends/requests', a.sub, { handle: pending.handle });
    await sync(a.sub, 20);
    await sync(b.sub, 5);
    await sync(b.sub, 3);
    await sync(c.sub, 0);
    await sync(pending.sub, 1);
    await sync(stranger.sub, 1);
    const res = await daily(a.sub);
    expect(res.statusCode).toBe(200);
    const data = v1.FriendsDailyResponse.parse(bodyOf(res));
    expect(data.self).toMatchObject({ status: 'eligible', views: 20 });
    expect(data.friends.map((row) => [row.userId, row.daily.views])).toEqual([
      [c.sub, 0],
      [b.sub, 8],
    ]);
    expect(
      v1.FriendsDailyResponse.parse(bodyOf(await daily(a.sub, addDays(today, -1)))).self,
    ).toMatchObject({ status: 'unavailable', views: null });
  });
  it('hides counts when sharing is off or withdrawn and removes former friends', async () => {
    const a = await user(),
      b = await user(false);
    await befriend(a, b);
    await sync(b.sub, 5);
    expect(v1.FriendsDailyResponse.parse(bodyOf(await daily(a.sub))).friends[0].daily).toEqual({
      status: 'private',
      views: null,
      updatedAt: null,
    });
    expect((await daily(b.sub)).statusCode).toBe(403);
    expect(
      (
        await route(
          event({
            method: 'PATCH',
            path: '/v1/me',
            sub: b.sub,
            body: { consent: { shareWithFriends: true } },
            headers: { 'if-match': '2' },
          }),
        )
      ).statusCode,
    ).toBe(200);
    expect(v1.FriendsDailyResponse.parse(bodyOf(await daily(a.sub))).friends[0].daily.views).toBe(
      5,
    );
    expect(
      (
        await route(
          event({
            method: 'PATCH',
            path: '/v1/me',
            sub: b.sub,
            body: { consent: { cloudSync: false, shareWithFriends: false } },
            headers: { 'if-match': '3' },
          }),
        )
      ).statusCode,
    ).toBe(200);
    expect(v1.FriendsDailyResponse.parse(bodyOf(await daily(a.sub))).friends[0].daily.status).toBe(
      'private',
    );
    await call('POST', '/v1/friends/remove', a.sub, { userId: b.sub });
    expect(v1.FriendsDailyResponse.parse(bodyOf(await daily(a.sub))).friends).toEqual([]);
  });
  it('does not turn missing, low-coverage or incomplete multi-device data into a zero', async () => {
    const a = await user(),
      b = await user();
    await befriend(a, b);
    expect(
      v1.FriendsDailyResponse.parse(bodyOf(await daily(a.sub))).friends[0].daily.views,
    ).toBeNull();
    const device = randomUUID();
    await sync(b.sub, 4, 0.79, device);
    expect(
      v1.FriendsDailyResponse.parse(bodyOf(await daily(a.sub))).friends[0].daily.views,
    ).toBeNull();
    await sync(b.sub, 4, 0.8, device, 2);
    expect(v1.FriendsDailyResponse.parse(bodyOf(await daily(a.sub))).friends[0].daily.views).toBe(
      4,
    );
    await sync(b.sub, null);
    expect(
      v1.FriendsDailyResponse.parse(bodyOf(await daily(a.sub))).friends[0].daily.views,
    ).toBeNull();
  });
  it('requires authentication and validates dates', async () => {
    expect(
      (await route(event({ path: '/v1/friends/daily', sub: null, query: { date: today } })))
        .statusCode,
    ).toBe(401);
    const a = await user();
    expect((await daily(a.sub, '2026-02-30')).statusCode).toBe(400);
    expect((await daily(a.sub, addDays(today, 3))).statusCode).toBe(400);
    expect((await daily(a.sub, addDays(today, -401))).statusCode).toBe(400);
    expect((await route(event({ path: '/v1/friends/daily', sub: a.sub }))).statusCode).toBe(400);
  });
});
describe('friends', () => {
  it('request by handle → pending both ways → accept → friends', async () => {
    const a = await user();
    const b = await user();
    const r = await call('POST', '/v1/friends/requests', a.sub, { handle: b.handle });
    expect(v1.FriendRequestResult.parse(bodyOf(r)).friend.status).toBe('pending_out');
    expect((await friends(b.sub))[0]).toMatchObject({ userId: a.sub, status: 'pending_in' });
    await call('POST', '/v1/friends/respond', b.sub, { userId: a.sub, accept: true });
    expect((await friends(a.sub))[0]).toMatchObject({
      userId: b.sub,
      status: 'accepted',
      handle: b.handle,
    });
  });
  it('an invite code connects instantly', async () => {
    const a = await user();
    const b = await user();
    const inv = v1.InviteResponse.parse(bodyOf(await call('POST', '/v1/friends/invites', a.sub)));
    expect(inv.code).toMatch(/^[A-HJ-NP-Z2-9]{10}$/);
    const r = await call('POST', '/v1/friends/requests', b.sub, { inviteCode: inv.code });
    expect(v1.FriendRequestResult.parse(bodyOf(r)).friend.status).toBe('accepted');
    expect((await friends(a.sub))[0].status).toBe('accepted');
  });
  it('mutual requests become friends', async () => {
    const a = await user();
    const b = await user();
    await call('POST', '/v1/friends/requests', a.sub, { handle: b.handle });
    const r = await call('POST', '/v1/friends/requests', b.sub, { handle: a.handle });
    expect(v1.FriendRequestResult.parse(bodyOf(r)).friend.status).toBe('accepted');
  });
  it('guards: self, unknown handle, no own handle, duplicates, bad invite', async () => {
    const a = await user();
    const b = await user();
    expect(
      (await call('POST', '/v1/friends/requests', a.sub, { handle: a.handle })).statusCode,
    ).toBe(400);
    expect(
      (await call('POST', '/v1/friends/requests', a.sub, { handle: 'nobody_here_zz' })).statusCode,
    ).toBe(404);
    const noHandle = await newAccount();
    await call('GET', '/v1/me', noHandle);
    expect(
      bodyOf(await call('POST', '/v1/friends/requests', noHandle, { handle: b.handle })).code,
    ).toBe('handle_required');
    await call('POST', '/v1/friends/requests', a.sub, { handle: b.handle });
    expect(
      bodyOf(await call('POST', '/v1/friends/requests', a.sub, { handle: b.handle })).code,
    ).toBe('request_pending');
    expect(
      (await call('POST', '/v1/friends/requests', a.sub, { inviteCode: 'ABCDEFGHJK' })).statusCode,
    ).toBe(404);
  });
  it('decline and remove delete both sides; you cannot accept your own request', async () => {
    const a = await user();
    const b = await user();
    await call('POST', '/v1/friends/requests', a.sub, { handle: b.handle });
    expect(
      (await call('POST', '/v1/friends/respond', a.sub, { userId: b.sub, accept: true }))
        .statusCode,
    ).toBe(404);
    await call('POST', '/v1/friends/respond', b.sub, { userId: a.sub, accept: false });
    expect(await friends(a.sub)).toEqual([]);
    await befriend(a, b);
    await call('POST', '/v1/friends/remove', b.sub, { userId: a.sub });
    expect(await friends(a.sub)).toEqual([]);
    expect(await friends(b.sub)).toEqual([]);
  });
  it('friend requests are rate limited (20/hour)', async () => {
    const a = await user();
    for (let i = 0; i < 20; i++)
      await call('POST', '/v1/friends/requests', a.sub, { handle: `missing_${i}_xx` });
    const r = await call('POST', '/v1/friends/requests', a.sub, { handle: 'missing_last_xx' });
    expect(r.statusCode).toBe(429);
    expect(r.headers?.['retry-after']).toBe('3600');
  });
});
async function syncDays(sub, minutesByOffset) {
  const days = Object.entries(minutesByOffset).map(([off, minutes]) => ({
    localDate: addDays(today, Number(off)),
    tz: 'UTC',
    platform: 'android',
    deviceId: randomUUID(),
    views: null,
    adViews: null,
    minutes,
    coverage: 1,
    rev: 1,
  }));
  const r = await route(
    event({
      method: 'POST',
      path: '/v1/usage/sync',
      sub,
      body: { days },
      headers: { 'idempotency-key': randomUUID() },
    }),
  );
  expect(r.statusCode).toBe(200);
}
const create = async (sub, over = {}) =>
  call('POST', '/v1/challenges', sub, {
    title: 'Calm week',
    metric: 'fewest_minutes',
    startDate: addDays(today, -1), // the server allows starting at most yesterday
    endDate: addDays(today, 4),
    tz: 'UTC',
    maxMembers: 3,
    ...over,
  });
describe('challenges & leaderboards', () => {
  it('ranks shared recorded reel counts, preserves zero, and excludes incomplete device-days', async () => {
    const a = await user(),
      b = await user(),
      privateMember = await user(false);
    await befriend(a, b);
    await befriend(a, privateMember);
    const ch = v1.ChallengeSummary.parse(bodyOf(await create(a.sub, { metric: 'fewest_views' })));
    await call('POST', `/v1/challenges/${ch.challengeId}/join`, b.sub);
    await call('POST', `/v1/challenges/${ch.challengeId}/join`, privateMember.sub);
    const device = randomUUID();
    const upload = async (
      sub,
      personalViews,
      deviceId = randomUUID(),
      date = today,
      views = null,
    ) => {
      const response = await route(
        event({
          method: 'POST',
          path: '/v1/usage/sync',
          sub,
          body: {
            days: [
              {
                localDate: date,
                tz: 'UTC',
                platform: 'android',
                deviceId,
                views,
                personalViews,
                adViews: null,
                minutes: 10,
                coverage: 0.01,
                rev: 1,
              },
            ],
          },
          headers: { 'idempotency-key': randomUUID() },
        }),
      );
      expect(response.statusCode).toBe(200);
    };
    await upload(a.sub, 73, device, today, 8);
    await upload(a.sub, 73, device, today, 8); // Same source-device row, not a second copy.
    await upload(a.sub, 2);
    await upload(a.sub, 20, randomUUID(), addDays(today, -1));
    await upload(b.sub, 0);
    await upload(privateMember.sub, 1);
    const board = async () =>
      v1.LeaderboardResponse.parse(
        bodyOf(await call('GET', `/v1/challenges/${ch.challengeId}/leaderboard`, a.sub)),
      );
    const initial = await board();
    expect(initial.entries.map((entry) => [entry.userId, entry.score])).toEqual([
      [b.sub, 0],
      [a.sub, 47.5],
    ]);
    expect(initial.hiddenMembers).toBe(1);
    await upload(a.sub, null); // An unknown device count must not become an artificial zero.
    expect((await board()).entries.find((entry) => entry.userId === a.sub).score).toBe(20);
  });
  it('friends join; strangers cannot; full challenges refuse', async () => {
    const a = await user();
    const b = await user();
    const c = await user();
    const d = await user();
    await befriend(a, b);
    await befriend(a, d);
    const ch = v1.ChallengeSummary.parse(bodyOf(await create(a.sub, { maxMembers: 2 })));
    expect((await call('POST', `/v1/challenges/${ch.challengeId}/join`, c.sub)).statusCode).toBe(
      404,
    ); // not a friend
    expect(
      v1.ChallengeSummary.parse(
        bodyOf(await call('POST', `/v1/challenges/${ch.challengeId}/join`, b.sub)),
      ).memberCount,
    ).toBe(2);
    expect(bodyOf(await call('POST', `/v1/challenges/${ch.challengeId}/join`, d.sub)).code).toBe(
      'challenge_full',
    );
    const mine = v1.ChallengesResponse.parse(
      bodyOf(await call('GET', '/v1/challenges', b.sub)),
    ).challenges;
    expect(mine.map((x) => x.challengeId)).toEqual([ch.challengeId]);
  });
  it('ranks only members who share; others are counted as hidden; non-members see nothing', async () => {
    const a = await user();
    const b = await user();
    const shy = await user(false);
    const outsider = await user();
    await befriend(a, b);
    await befriend(a, shy);
    const ch = v1.ChallengeSummary.parse(bodyOf(await create(a.sub)));
    await call('POST', `/v1/challenges/${ch.challengeId}/join`, b.sub);
    await call('POST', `/v1/challenges/${ch.challengeId}/join`, shy.sub);
    await syncDays(a.sub, { [-1]: 40, 0: 20 }); // avg 30
    await syncDays(b.sub, { [-1]: 10, 0: 20 }); // avg 15
    await syncDays(shy.sub, { [-1]: 1 });
    const lb = v1.LeaderboardResponse.parse(
      bodyOf(await call('GET', `/v1/challenges/${ch.challengeId}/leaderboard`, a.sub)),
    );
    expect(lb.entries.map((e) => [e.rank, e.handle, e.score])).toEqual([
      [1, b.handle, 15],
      [2, a.handle, 30],
    ]);
    expect(lb.hiddenMembers).toBe(1);
    expect(lb.entries.some((e) => e.userId === shy.sub)).toBe(false);
    expect(
      (await call('GET', `/v1/challenges/${ch.challengeId}/leaderboard`, outsider.sub)).statusCode,
    ).toBe(404);
  });
  it('validates dates and length', async () => {
    const a = await user();
    expect(
      (await create(a.sub, { startDate: addDays(today, -10), endDate: addDays(today, 1) }))
        .statusCode,
    ).toBe(400);
    expect(
      (await create(a.sub, { startDate: today, endDate: addDays(today, 40) })).statusCode,
    ).toBe(400);
    expect((await call('POST', '/v1/challenges/not-a-uuid/join', a.sub)).statusCode).toBe(404);
  });
  it('leaving frees a place', async () => {
    const a = await user();
    const b = await user();
    await befriend(a, b);
    const ch = v1.ChallengeSummary.parse(bodyOf(await create(a.sub, { maxMembers: 2 })));
    await call('POST', `/v1/challenges/${ch.challengeId}/join`, b.sub);
    expect((await call('POST', `/v1/challenges/${ch.challengeId}/leave`, b.sub)).statusCode).toBe(
      200,
    );
    expect((await call('POST', `/v1/challenges/${ch.challengeId}/leave`, b.sub)).statusCode).toBe(
      404,
    );
    expect(
      v1.ChallengeSummary.parse(
        bodyOf(await call('POST', `/v1/challenges/${ch.challengeId}/join`, b.sub)),
      ).memberCount,
    ).toBe(2);
  });
});
describe('scoreMember', () => {
  const d = (minutes, views, coverage = 1) => ({
    localDate: today,
    minutes,
    views,
    coverage,
  });
  it('video scores ignore low-coverage and untracked days', () => {
    expect(scoreMember('fewest_views', [d(1, 10), d(1, 2, 0.5), d(1, null)], null)).toBe(10);
    expect(scoreMember('fewest_views', [d(1, null)], null)).toBeNull();
  });
  it('video scores prefer recorded totals and retain the legacy coverage fallback', () => {
    expect(scoreMember('fewest_views', [{ ...d(1, 8, 0.01), personalViews: 73 }], null)).toBe(73);
    expect(scoreMember('fewest_views', [{ ...d(1, null, 0), personalViews: 0 }], null)).toBe(0);
    expect(
      scoreMember('fewest_views', [{ ...d(1, 8, 0.5), personalViews: null }], null),
    ).toBeNull();
  });
  it('goal days count kept days against the member’s own minutes goal', () => {
    expect(scoreMember('goal_days', [d(10, null), d(50, null), d(29, null)], 30)).toBe(2);
    expect(scoreMember('goal_days', [d(10, null)], null)).toBeNull();
  });
});
describe('devices', () => {
  it('registers up to 10 devices and only the owner can remove one', async () => {
    const a = await user();
    const b = await user();
    const ids = Array.from({ length: 10 }, () => randomUUID());
    for (const id of ids) {
      expect(
        (
          await call('POST', '/v1/devices', a.sub, {
            deviceId: id,
            platform: 'android',
            pushToken: `token-${id}`,
          })
        ).statusCode,
      ).toBe(200);
    }
    expect(
      bodyOf(
        await call('POST', '/v1/devices', a.sub, {
          deviceId: randomUUID(),
          platform: 'android',
          pushToken: 'x'.repeat(20),
        }),
      ).code,
    ).toBe('too_many_devices');
    expect((await call('DELETE', `/v1/devices/${ids[0]}`, b.sub)).statusCode).toBe(404);
    expect((await call('DELETE', `/v1/devices/${ids[0]}`, a.sub)).statusCode).toBe(200);
  });
});
