import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { UpdateCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { v1 } from '@siddiq3/driftless-contracts';
import { route } from '../src/router.js';
import { ddb, tableName } from '../src/lib/ddb.js';
import { bodyOf, event, newAccount, ownerOf } from './helpers.js';
const call = (sub, method, path, body, extra = {}) =>
  route(event({ sub, method, path, body, ...extra }));
const date = () => new Date(Date.now()).toISOString().slice(0, 10);
const end = () => new Date(Date.now() + 6 * 86400000).toISOString().slice(0, 10);
async function user(name) {
  const sub = await newAccount();
  const handle = `u${randomUUID().replaceAll('-', '').slice(0, 15)}`;
  expect(
    (
      await call(
        sub,
        'PATCH',
        '/v1/me',
        { handle, displayName: name, consent: { cloudSync: true, shareWithFriends: false } },
        { headers: { 'if-match': '1' } },
      )
    ).statusCode,
  ).toBe(200);
  return sub;
}
async function friends(a, b) {
  const invite = bodyOf(await call(a, 'POST', '/v1/friends/invites'));
  expect(
    (await call(b, 'POST', '/v1/friends/requests', { inviteCode: invite.code })).statusCode,
  ).toBe(200);
}
const input = (target, more = {}) => ({
  title: 'Scroll battle',
  metric: 'fewest_views',
  startDate: date(),
  endDate: end(),
  tz: 'UTC',
  maxMembers: 2,
  targetUserId: target,
  operationId: randomUUID(),
  scoreConsent: true,
  ...more,
});
async function start(a, b, more = {}) {
  const body = input(b, more),
    r = await call(a, 'POST', '/v1/challenges', body);
  expect(r.statusCode, r.body).toBe(200);
  return { id: bodyOf(r).challengeId, body, result: bodyOf(r) };
}
const board = (sub, id) => call(sub, 'GET', `/v1/challenges/${id}/leaderboard`);
const accept = (sub, id) => call(sub, 'POST', `/v1/challenges/${id}/join`, { scoreConsent: true });
async function upload(
  sub,
  views,
  device = randomUUID(),
  rev = 1,
  localDate = date(),
  coverage = 0.1,
) {
  const r = await call(
    sub,
    'POST',
    '/v1/usage/sync',
    {
      days: [
        {
          localDate,
          deviceId: device,
          tz: 'UTC',
          platform: 'android',
          views: null,
          personalViews: views,
          adViews: null,
          minutes: 10,
          coverage,
          rev,
        },
      ],
    },
    { headers: { 'idempotency-key': randomUUID() } },
  );
  expect(r.statusCode, r.body).toBe(200);
  return device;
}
let a, b, c;
beforeEach(async () => {
  a = await user('Creator');
  b = await user('Target');
  c = await user('Other');
  await friends(a, b);
  await friends(a, c);
});
afterEach(() => vi.restoreAllMocks());
describe('direct challenge invitations', () => {
  it('targets the selected friend and appears only in that incarnation inbox', async () => {
    const { id, result } = await start(a, b);
    expect(result).toMatchObject({
      targetUserId: b,
      invitationState: 'pending',
      memberCount: 1,
      myScoreConsent: true,
    });
    const inbox = v1.ChallengesResponse.parse(bodyOf(await call(b, 'GET', '/v1/challenges')));
    expect(inbox.invitations).toMatchObject([
      { challengeId: id, ownerName: 'Creator', targetUserId: b, invitationState: 'pending' },
    ]);
    expect(bodyOf(await call(c, 'GET', '/v1/challenges')).invitations).toEqual([]);
    expect((await board(b, id)).statusCode).toBe(404);
    expect(bodyOf(await board(a, id)).entries).toEqual([]);
  });
  it('accepts once across concurrent accepts and preserves all global sharing settings', async () => {
    const { id } = await start(a, b);
    const replies = await Promise.all([accept(b, id), accept(b, id), accept(b, id)]);
    expect(replies.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect(bodyOf(await accept(b, id)).memberCount).toBe(2);
    const data = bodyOf(await call(b, 'GET', '/v1/challenges'));
    expect(data.challenges).toHaveLength(1);
    expect(data.invitations).toEqual([]);
    for (const sub of [a, b])
      expect(bodyOf(await call(sub, 'GET', '/v1/me')).profile.consent).toEqual({
        cloudSync: true,
        shareWithFriends: false,
      });
  });
  it('rejects a copied code used by another friend and requires explicit battle consent', async () => {
    const { id } = await start(a, b);
    expect((await accept(c, id)).statusCode).toBe(404);
    expect((await call(b, 'POST', `/v1/challenges/${id}/join`, {})).statusCode).toBe(400);
    expect((await board(c, id)).statusCode).toBe(404);
  });
  it('durably replays creation even if the response was lost and rejects changed intent', async () => {
    const body = input(b);
    const responses = await Promise.all([
      call(a, 'POST', '/v1/challenges', body),
      call(a, 'POST', '/v1/challenges', body),
    ]);
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
    const ids = responses.map((r) => bodyOf(r).challengeId);
    expect(new Set(ids).size).toBe(1);
    expect(bodyOf(await call(a, 'POST', '/v1/challenges', body)).challengeId).toBe(ids[0]);
    expect(
      (await call(a, 'POST', '/v1/challenges', { ...body, title: 'Different intent' })).statusCode,
    ).toBe(409);
    expect(bodyOf(await call(b, 'GET', '/v1/challenges')).invitations).toHaveLength(1);
    expect((await call(a, 'POST', '/v1/challenges', input(b))).statusCode).toBe(409);
  });
  it('declines or cancels idempotently and cannot accept a terminal invitation', async () => {
    const first = await start(a, b);
    expect(
      (await call(b, 'POST', `/v1/challenges/${first.id}/invitation`, { action: 'cancel' }))
        .statusCode,
    ).toBe(404);
    for (let i = 0; i < 2; i++)
      expect(
        bodyOf(
          await call(b, 'POST', `/v1/challenges/${first.id}/invitation`, { action: 'decline' }),
        ).invitationState,
      ).toBe('declined');
    expect((await accept(b, first.id)).statusCode).toBe(409);
    const second = await start(a, b);
    expect(
      bodyOf(await call(a, 'POST', `/v1/challenges/${second.id}/invitation`, { action: 'cancel' }))
        .invitationState,
    ).toBe('cancelled');
    expect((await accept(b, second.id)).statusCode).toBe(409);
  });
  it('friend removal permanently invalidates the old invitation even after re-adding', async () => {
    const { id } = await start(a, b);
    await call(a, 'POST', '/v1/friends/remove', { userId: b });
    expect((await accept(b, id)).statusCode).toBe(409);
    expect(bodyOf(await call(b, 'GET', '/v1/challenges')).invitations[0].invitationState).toBe(
      'unavailable',
    );
    await new Promise((resolve) => setTimeout(resolve, 2));
    await friends(a, b);
    expect((await accept(b, id)).statusCode).toBe(409);
  });
  it('rejects expired invitations and full challenges', async () => {
    const { id } = await start(a, b);
    await ddb().send(
      new UpdateCommand({
        TableName: tableName(),
        Key: { pk: `CHAL#${id}`, sk: 'META' },
        UpdateExpression: 'SET memberCount = :full',
        ExpressionAttributeValues: { ':full': 2 },
      }),
    );
    expect((await accept(b, id)).statusCode).toBe(409);
    const future = Date.now() + 8 * 86400000;
    vi.spyOn(Date, 'now').mockReturnValue(future);
    expect(bodyOf(await call(b, 'GET', '/v1/challenges')).invitations[0].invitationState).toBe(
      'expired',
    );
    expect((await accept(b, id)).statusCode).toBe(409);
  });
  it('cannot invite a stranger or target a deleted identity', async () => {
    const stranger = await user('Stranger');
    expect((await call(a, 'POST', '/v1/challenges', input(stranger))).statusCode).toBe(409);
    await call(b, 'POST', '/v1/account/delete');
    expect((await call(a, 'POST', '/v1/challenges', input(b))).statusCode).toBe(409);
  });
  it('atomic friendship guard rejects removal between validation and membership write', async () => {
    const { id } = await start(a, b),
      client = ddb(),
      send = client.send.bind(client);
    let removed = false;
    vi.spyOn(client, 'send').mockImplementation(async (command) => {
      if (
        !removed &&
        command instanceof TransactWriteCommand &&
        command.input.TransactItems.some((i) =>
          i.Update?.UpdateExpression.includes('memberCount = memberCount +'),
        )
      ) {
        removed = true;
        await call(a, 'POST', '/v1/friends/remove', { userId: b });
      }
      return send(command);
    });
    expect((await accept(b, id)).statusCode).toBe(409);
    expect(bodyOf(await call(a, 'GET', '/v1/challenges')).challenges[0].memberCount).toBe(1);
  });
  it('concurrent cancel and accept never produce a usable cancelled battle', async () => {
    const { id } = await start(a, b);
    await Promise.all([
      accept(b, id),
      call(a, 'POST', `/v1/challenges/${id}/invitation`, { action: 'cancel' }),
    ]);
    const data = bodyOf(await call(a, 'GET', '/v1/challenges')).challenges[0];
    expect(data.memberCount).toBeLessThanOrEqual(2);
    if (data.invitationState === 'cancelled')
      expect(bodyOf(await board(a, id)).entries).toEqual([]);
  });
});
describe('battle-only score privacy', () => {
  it('shows only the authorized score projection, preserves formulas and ties, and sees delayed uploads once', async () => {
    const { id } = await start(a, b);
    await accept(b, id);
    const missing = bodyOf(await board(a, id));
    expect(missing.entries).toEqual([]);
    expect(missing.participants.every((p) => p.status === 'no_data')).toBe(true);
    const device = await upload(a, 50);
    await upload(a, 50, device, 1);
    await upload(b, 50);
    const initial = v1.LeaderboardResponse.parse(bodyOf(await board(a, id)));
    expect(initial.entries.map((e) => [e.rank, e.score])).toEqual([
      [1, 50],
      [1, 50],
    ]);
    expect(initial.participants.map((p) => p.availableDays)).toEqual([1, 1]);
    expect(JSON.stringify(initial)).not.toMatch(/personalViews|minutes|dailyLimit|localDate|goals/);
    await upload(a, 60, device, 2);
    expect(bodyOf(await board(b, id)).entries.map((e) => e.score)).toEqual([50, 60]);
    expect(bodyOf(await call(a, 'GET', '/v1/me')).profile.consent.shareWithFriends).toBe(false);
    expect((await call(c, 'GET', `/v1/challenges/${id}/leaderboard`)).statusCode).toBe(404);
    expect(
      (
        await call(c, 'GET', '/v1/usage/history', undefined, {
          query: { from: date(), to: date(), includePersonal: 'true' },
        })
      ).statusCode,
    ).toBe(200);
  });
  it('revocation prevents scores even if global sharing remains enabled and can be restored explicitly', async () => {
    const { id } = await start(a, b);
    await accept(b, id);
    await upload(a, 3);
    await upload(b, 9);
    const p = bodyOf(await call(b, 'GET', '/v1/me')).profile;
    await call(
      b,
      'PATCH',
      '/v1/me',
      { consent: { shareWithFriends: true } },
      { headers: { 'if-match': String(p.rev) } },
    );
    expect(
      (await call(b, 'PUT', `/v1/challenges/${id}/score-consent`, { share: false })).statusCode,
    ).toBe(200);
    const visible = bodyOf(await board(a, id));
    expect(visible.entries).toHaveLength(1);
    expect(visible.participants.find((p) => p.userId === b).status).toBe('sharing_off');
    expect(bodyOf(await board(b, id)).entries).toEqual([]);
    await call(b, 'PUT', `/v1/challenges/${id}/score-consent`, { share: true });
    expect(bodyOf(await board(a, id)).entries).toHaveLength(2);
  });
  it('friendship removal and ending the battle stop scoped score visibility', async () => {
    const { id } = await start(a, b);
    await accept(b, id);
    await upload(a, 3);
    await upload(b, 4);
    await call(a, 'POST', '/v1/friends/remove', { userId: b });
    expect(bodyOf(await board(a, id)).entries).toEqual([]);
    const future = Date.now() + 8 * 86400000;
    vi.spyOn(Date, 'now').mockReturnValue(future);
    expect(bodyOf(await board(b, id)).entries).toEqual([]);
  });
  it('expired scoped consent never exposes a retained historical leaderboard', async () => {
    const { id } = await start(a, b);
    await accept(b, id);
    await upload(a, 10);
    await upload(b, 20);
    const future = Date.now() + 8 * 86400000;
    vi.spyOn(Date, 'now').mockReturnValue(future);
    const r = bodyOf(await board(a, id));
    expect(r.entries).toEqual([]);
    expect(r.participants.every((p) => p.status === 'expired')).toBe(true);
  });
  it('deleted target incarnation cannot be replaced by the same Google identity', async () => {
    const { id } = await start(a, b);
    await accept(b, id);
    await upload(a, 4);
    await upload(b, 5);
    const old = ownerOf(b);
    await call(b, 'POST', '/v1/account/delete');
    expect(bodyOf(await board(a, id)).entries).toEqual([]);
    const fresh = bodyOf(
      await call(b, 'POST', '/v1/account/register', {
        registrationId: randomUUID(),
        expectedIncarnation: old,
      }),
    ).incarnation;
    expect(
      (
        await call(
          b,
          'POST',
          `/v1/challenges/${id}/join`,
          { scoreConsent: true },
          { headers: { 'x-account-incarnation': fresh } },
        )
      ).statusCode,
    ).toBe(404);
    expect(
      bodyOf(
        await call(b, 'GET', '/v1/challenges', undefined, {
          headers: { 'x-account-incarnation': fresh },
        }),
      ).invitations,
    ).toEqual([]);
  });
  it('deleting the creator removes the recipient inbox reference and blocks acceptance', async () => {
    const { id } = await start(a, b);
    await call(a, 'POST', '/v1/account/delete');
    expect(bodyOf(await call(b, 'GET', '/v1/challenges')).invitations).toEqual([]);
    expect((await accept(b, id)).statusCode).toBe(404);
  });
  it('leaving revokes membership and cancels a direct battle', async () => {
    const { id } = await start(a, b);
    await accept(b, id);
    await upload(a, 2);
    await call(b, 'POST', `/v1/challenges/${id}/leave`);
    expect((await board(b, id)).statusCode).toBe(404);
    expect(bodyOf(await board(a, id)).entries).toEqual([]);
    expect((await accept(b, id)).statusCode).toBe(409);
  });
});

it('revocation during a score read fences the outgoing reply', async () => {
  const { id } = await start(a, b);
  await accept(b, id);
  await upload(a, 4);
  await upload(b, 8);
  const client = ddb(),
    send = client.send.bind(client);
  let revoked = false;
  vi.spyOn(client, 'send').mockImplementation(async (command) => {
    if (
      !revoked &&
      command.constructor.name === 'QueryCommand' &&
      command.input.ExpressionAttributeValues?.[':a']
    ) {
      revoked = true;
      await call(b, 'PUT', `/v1/challenges/${id}/score-consent`, { share: false });
    }
    return send(command);
  });
  const data = bodyOf(await board(a, id));
  expect(data.entries.some((e) => e.userId === b)).toBe(false);
  expect(data.participants.find((p) => p.userId === b).status).toBe('sharing_off');
});
it('reports partial date coverage and excludes history outside the shared challenge window', async () => {
  const startDate = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const oldDate = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  const { id } = await start(a, b, { startDate });
  await accept(b, id);
  await upload(a, 50);
  await upload(a, 999, randomUUID(), 1, oldDate);
  await upload(b, 10);
  await upload(b, 30, randomUUID(), 1, startDate);
  const data = bodyOf(await board(a, id));
  expect(data.entries.map((e) => e.score)).toEqual([20, 50]);
  expect(data.participants.find((p) => p.userId === a)).toMatchObject({
    availableDays: 1,
    expectedDays: 2,
  });
});
it('uses existing minute and goal-day formulas for new scoped generic participation', async () => {
  for (const metric of ['fewest_minutes', 'goal_days']) {
    const req = input(undefined, { metric, maxMembers: 10 });
    delete req.targetUserId;
    const response = await call(a, 'POST', '/v1/challenges', req);
    expect(response.statusCode, response.body).toBe(200);
    const id = bodyOf(response).challengeId;
    expect((await accept(b, id)).statusCode).toBe(200);
    const goal = {
      goals: [{ goalId: randomUUID(), metric: 'minutes', dailyLimit: 20, enabled: true, rev: 1 }],
    };
    for (const sub of [a, b]) {
      await call(sub, 'PUT', '/v1/goals', goal);
      await upload(sub, 3, randomUUID(), 1, date(), 1);
    }
    const scores = bodyOf(await board(a, id)).entries.map((e) => e.score);
    expect(scores).toEqual(metric === 'fewest_minutes' ? [10, 10] : [1, 1]);
  }
});

it('does not rank unknown low-coverage goal days as a zero score', async () => {
  const req = input(undefined, { metric: 'goal_days', maxMembers: 10 });
  delete req.targetUserId;
  const response = await call(a, 'POST', '/v1/challenges', req);
  expect(response.statusCode, response.body).toBe(200);
  const id = bodyOf(response).challengeId;
  await call(a, 'PUT', '/v1/goals', {
    goals: [{ goalId: randomUUID(), metric: 'minutes', dailyLimit: 20, enabled: true, rev: 1 }],
  });
  await upload(a, 4); // minutes observed but insufficient coverage to claim a kept goal.
  const data = bodyOf(await board(a, id));
  expect(data.entries).toEqual([]);
  expect(data.participants[0]).toMatchObject({ status: 'no_data', availableDays: 0 });
});

it('concurrent generic joins cannot exceed a two-person challenge capacity', async () => {
  const req = input(undefined);
  delete req.targetUserId;
  const response = await call(a, 'POST', '/v1/challenges', req);
  expect(response.statusCode, response.body).toBe(200);
  const id = bodyOf(response).challengeId;
  const results = await Promise.all([accept(b, id), accept(c, id)]);
  expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  expect(bodyOf(await call(a, 'GET', '/v1/challenges')).challenges[0].memberCount).toBe(2);
});
