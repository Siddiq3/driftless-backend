import { randomInt } from 'node:crypto';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { v1 } from '@siddiq3/driftless-contracts';
import { daysBetween, localDateOf } from '@siddiq3/driftless-contracts/domain';
import { activeWrite, assertActive, readState } from '../lib/lifecycle.js';
import { tableName, Keys, isConditionalFailure } from '../lib/ddb.js';
import { Errors, HttpError, json, parseBody, validate } from '../lib/http.js';
import { rateLimit } from '../lib/rate.js';
import { loadProfile } from './me.js';
import {
  listFriendItems,
  toFriends,
  dailyCount,
  requireOwnHandle,
  MAX_FRIENDS,
} from './friends.js';

const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const codeSchema = v1.BattleLinkCode;
const inviteKey = (code) => ({ pk: `INVITE#${code}`, sk: 'INVITE' });
const friendKey = (a, b) => ({ pk: Keys.user(a), sk: `FRIEND#${b}` });
const receiptKey = (sub, code) => ({ pk: Keys.user(sub), sk: `BATTLEJOIN#${code}` });
const put = (Item, extra = {}) => ({ Put: { TableName: tableName(), Item, ...extra } });
export async function battleInvite(code) {
  if (!codeSchema.safeParse(code).success) throw Errors.notFound();
  const invite = await readState(inviteKey(code));
  if (!invite || invite.kind !== 'battle' || invite.ttl <= Date.now() / 1000)
    throw Errors.notFound();
  await assertActive(invite.sub);
  const profile = await loadProfile(invite.sub);
  if (!profile.handle) throw Errors.notFound();
  return { invite, profile };
}
export async function postBattleInvite(event, caller) {
  parseBody(event, v1.BattleLinkConsent);
  await requireOwnHandle(caller.sub);
  await rateLimit(caller.sub, 'battle_invite', 10, 3600);
  const now = Math.floor(Date.now() / 1000),
    ttl = now + 7 * 86400;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = Array.from({ length: 10 }, () => alphabet[randomInt(alphabet.length)]).join('');
    try {
      await activeWrite(
        caller.sub,
        new TransactWriteCommand({
          TransactItems: [
            put(
              { ...inviteKey(code), sub: caller.sub, kind: 'battle', scoreConsentVersion: 1, ttl },
              { ConditionExpression: 'attribute_not_exists(pk)' },
            ),
            put({ pk: Keys.user(caller.sub), sk: `INVITE#${code}` }),
          ],
        }),
      );
      return json(200, { code, expiresAt: new Date(ttl * 1000).toISOString() });
    } catch (e) {
      if (!isConditionalFailure(e)) throw e;
    }
  }
  throw new HttpError(503, 'invite_unavailable', 'Please try again');
}
export async function getBattleInvite(event, caller) {
  const code = event.pathParameters?.code;
  const { invite, profile } = await battleInvite(code);
  return json(200, {
    code,
    inviterName: profile.displayName || profile.handle,
    inviterUserId: profile.userId,
    isSelf: invite.sub === caller.sub,
    expiresAt: new Date(invite.ttl * 1000).toISOString(),
  });
}
const granted = (row) => row?.status === 'accepted' && row.battleConsentVersion === 1;
export async function acceptBattleInvite(event, caller) {
  parseBody(event, v1.BattleLinkConsent);
  const code = event.pathParameters?.code;
  const { invite } = await battleInvite(code),
    other = invite.sub;
  if (other === caller.sub) throw Errors.badRequest('This is your own invitation');
  await requireOwnHandle(caller.sub);
  await rateLimit(caller.sub, 'battle_accept', 30, 3600);
  const [mine, theirs, receipt] = await Promise.all([
    readState(friendKey(caller.sub, other)),
    readState(friendKey(other, caller.sub)),
    readState(receiptKey(caller.sub, code)),
  ]);
  if (granted(mine) && granted(theirs)) return json(200, { ok: true });
  if (receipt)
    throw Errors.conflict('invite_used', 'This battle was removed. Ask for a new invite.');
  if (
    (!mine && (await listFriendItems(caller.sub)).length >= MAX_FRIENDS) ||
    (!theirs && (await listFriendItems(other)).length >= MAX_FRIENDS)
  )
    throw Errors.conflict('too_many_friends', 'Your battle circle is full');
  const now = new Date().toISOString();
  const sinceDate = localDateOf(Date.now(), (await loadProfile(other)).tz);
  const friend = (a, b, previous) =>
    put(
      {
        ...friendKey(a, b),
        otherSub: b,
        status: 'accepted',
        since: previous?.since ?? now,
        battleConsentVersion: 1,
        battleSinceDate: sinceDate,
      },
      previous
        ? {
            ConditionExpression: 'since = :since AND #s = :status',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: { ':since': previous.since, ':status': previous.status },
          }
        : { ConditionExpression: 'attribute_not_exists(pk)' },
    );
  try {
    await activeWrite(
      caller.sub,
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: tableName(),
              Key: inviteKey(code),
              ConditionExpression:
                '#kind = :kind AND #owner = :owner AND #ttl > :now AND scoreConsentVersion = :v',
              ExpressionAttributeNames: { '#kind': 'kind', '#owner': 'sub', '#ttl': 'ttl' },
              ExpressionAttributeValues: {
                ':kind': 'battle',
                ':owner': other,
                ':now': Math.floor(Date.now() / 1000),
                ':v': 1,
              },
            },
          },
          friend(caller.sub, other, mine),
          friend(other, caller.sub, theirs),
          put(
            { ...receiptKey(caller.sub, code), otherSub: other, since: mine?.since ?? now },
            { ConditionExpression: 'attribute_not_exists(pk)' },
          ),
        ],
      }),
    );
  } catch (e) {
    if (!isConditionalFailure(e)) throw e;
    const [left, right] = await Promise.all([
      readState(friendKey(caller.sub, other)),
      readState(friendKey(other, caller.sub)),
    ]);
    if (!granted(left) || !granted(right))
      throw Errors.conflict('battle_changed', 'The invitation changed. Please try again.');
  }
  return json(200, { ok: true });
}
const missing = { status: 'unavailable', views: null, updatedAt: null };
export async function getBattleDaily(event, caller) {
  const { date } = validate(v1.FriendsDailyQuery, { date: event.queryStringParameters?.date });
  const age = daysBetween(date, localDateOf(Date.now() + 14 * 3600000, 'UTC'));
  if (age < 0 || age >= 400) throw Errors.badRequest('Date outside retained history');
  await rateLimit(caller.sub, 'battle_daily', 120, 3600);
  const own = await loadProfile(caller.sub);
  const members = (await listFriendItems(caller.sub)).filter(granted);
  const observed = [];
  for (let offset = 0; offset < members.length; offset += 10) {
    const batch = await Promise.all(
      members.slice(offset, offset + 10).map(async (row) => {
        const reciprocal = await readState(friendKey(row.otherSub, caller.sub));
        if (!granted(reciprocal)) return null;
        const friends = await toFriends([row]);
        if (!friends.length) return null;
        const profile = await loadProfile(row.otherSub);
        const visible =
          own.consent.cloudSync &&
          profile.consent.cloudSync &&
          date >= row.battleSinceDate &&
          date >= reciprocal.battleSinceDate;
        return {
          value: { ...friends[0], daily: visible ? await dailyCount(row.otherSub, date) : missing },
          other: row.otherSub,
          leftSince: row.since,
          rightSince: reciprocal.since,
        };
      }),
    );
    observed.push(...batch.filter(Boolean));
  }
  const ownCount = own.consent.cloudSync ? await dailyCount(caller.sub, date) : missing;
  // Validate ALL grants after ALL activity reads, including deletion/removal during a later row.
  const results = [];
  for (let offset = 0; offset < observed.length; offset += 10) {
    const batch = await Promise.all(
      observed.slice(offset, offset + 10).map(async (item) => {
        const [left, right, profile, active] = await Promise.all([
          readState(friendKey(caller.sub, item.other)),
          readState(friendKey(item.other, caller.sub)),
          readState({ pk: Keys.user(item.other), sk: Keys.profile }),
          assertActive(item.other).then(
            () => true,
            () => false,
          ),
        ]);
        if (
          !active ||
          !granted(left) ||
          !granted(right) ||
          left.since !== item.leftSince ||
          right.since !== item.rightSince
        )
          return null;
        return { ...item.value, daily: profile?.consent.cloudSync ? item.value.daily : missing };
      }),
    );
    results.push(...batch.filter(Boolean));
  }
  const latestOwn = await loadProfile(caller.sub);
  await assertActive(caller.sub);
  return json(200, {
    localDate: date,
    self: latestOwn.consent.cloudSync ? ownCount : missing,
    friends: results.map((f) => ({ ...f, daily: latestOwn.consent.cloudSync ? f.daily : missing })),
  });
}
