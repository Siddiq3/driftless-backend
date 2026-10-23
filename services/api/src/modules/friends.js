import { randomInt } from 'node:crypto';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { v1 } from '@siddiq3/driftless-contracts';
import { daysBetween, localDateOf } from '@siddiq3/driftless-contracts/domain';
import { ddb, isConditionalFailure, Keys, tableName } from '../lib/ddb.js';
import { Errors, HttpError, json, parseBody, validate } from '../lib/http.js';
import { rateLimit } from '../lib/rate.js';
import { loadOrCreateProfile } from './me.js';
import { batchGet } from '../lib/batch.js';
export const MAX_FRIENDS = 200;
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const INVITE_TTL_SEC = 7 * 86_400;
const friendKey = (a, b) => ({ pk: Keys.user(a), sk: `FRIEND#${b}` });
const inviteKey = (code) => ({ pk: `INVITE#${code}`, sk: 'INVITE' });
export async function friendStatus(a, b) {
  const r = await ddb().send(new GetCommand({ TableName: tableName(), Key: friendKey(a, b) }));
  return r.Item?.status ?? null;
}
export async function areFriends(a, b) {
  return (await friendStatus(a, b)) === 'accepted';
}
async function listFriendItems(sub) {
  const out = [];
  let start;
  do {
    const r = await ddb().send(
      new QueryCommand({
        TableName: tableName(),
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :f)',
        ExpressionAttributeValues: { ':pk': Keys.user(sub), ':f': 'FRIEND#' },
        ExclusiveStartKey: start,
        ConsistentRead: true,
      }),
    );
    out.push(...(r.Items ?? []));
    start = r.LastEvaluatedKey;
  } while (start);
  return out;
}
/** Current handle / display name for each user (never stale copies). Users without a handle are omitted. */
async function profiles(subs) {
  const map = new Map();
  for (let i = 0; i < subs.length; i += 100) {
    const keys = subs.slice(i, i + 100).map((s) => ({ pk: Keys.user(s), sk: Keys.profile }));
    for (const p of await batchGet(keys)) {
      const sub = String(p.pk).slice('USER#'.length);
      if (p.handle)
        map.set(sub, {
          handle: p.handle,
          displayName: p.displayName ?? null,
        });
    }
  }
  return map;
}
async function toFriends(items) {
  const prof = await profiles(items.map((i) => i.otherSub));
  return items.flatMap((i) => {
    const p = prof.get(i.otherSub);
    return p
      ? [
          {
            userId: i.otherSub,
            handle: p.handle,
            displayName: p.displayName,
            status: i.status,
            since: i.since,
          },
        ]
      : [];
  });
}
export async function getFriends(_e, caller) {
  return json(200, { friends: await toFriends(await listFriendItems(caller.sub)) });
}
/** A local-date comparison, never a raw local candidate count or a missing-device zero. */
async function dailyCount(sub, date) {
  const rows = [];
  let start;
  do {
    const page = await ddb().send(
      new QueryCommand({
        TableName: tableName(),
        KeyConditionExpression: 'pk = :pk AND sk BETWEEN :a AND :b',
        ExpressionAttributeValues: {
          ':pk': Keys.user(sub),
          ':a': Keys.dayRangeStart(date),
          ':b': Keys.dayRangeEnd(date),
        },
        ConsistentRead: true,
        ExclusiveStartKey: start,
      }),
    );
    rows.push(...(page.Items ?? []));
    start = page.LastEvaluatedKey;
  } while (start);
  const live = rows.filter((row) => row.ttl > Date.now() / 1000);
  if (!live.length || live.some((row) => row.views === null || row.coverage < 0.8))
    return { status: 'unavailable', views: null, updatedAt: null };
  return {
    status: 'eligible',
    views: live.reduce((sum, row) => sum + row.views, 0),
    updatedAt: live
      .map((row) => row.receivedAt)
      .sort()
      .at(-1),
  };
}
export async function getFriendsDaily(event, caller) {
  const { date } = validate(v1.FriendsDailyQuery, { date: event.queryStringParameters?.date });
  const age = daysBetween(date, localDateOf(Date.now() + 14 * 3600_000, 'UTC'));
  if (age < 0 || age >= 400) throw Errors.badRequest('date must be within retained history');
  const own = await loadOrCreateProfile(caller.sub);
  if (!own.consent.cloudSync || !own.consent.shareWithFriends)
    throw new HttpError(
      403,
      'consent_required',
      'Turn on cloud backup and share progress with friends to compare counts.',
    );
  await rateLimit(caller.sub, 'friends_daily', 120, 3600);
  const friends = (await listFriendItems(caller.sub)).filter((row) => row.status === 'accepted');
  const result = [];
  // Bound database fan-out even for a full circle. Strong reads honor withdrawn consent.
  for (let i = 0; i < friends.length; i += 10) {
    const batch = await Promise.all(
      friends.slice(i, i + 10).map(async (friend) => {
        const profile = await ddb().send(
          new GetCommand({
            TableName: tableName(),
            Key: { pk: Keys.user(friend.otherSub), sk: Keys.profile },
            ConsistentRead: true,
          }),
        );
        if (!profile.Item?.handle) return null;
        const consent = profile.Item?.consent;
        const daily =
          consent?.cloudSync && consent.shareWithFriends
            ? await dailyCount(friend.otherSub, date)
            : { status: 'private', views: null, updatedAt: null };
        return {
          userId: friend.otherSub,
          handle: profile.Item.handle,
          displayName: profile.Item.displayName ?? null,
          status: friend.status,
          since: friend.since,
          daily,
        };
      }),
    );
    result.push(...batch.filter((row) => row !== null));
  }
  result.sort(
    (a, b) =>
      (a.daily.views ?? Infinity) - (b.daily.views ?? Infinity) || a.handle.localeCompare(b.handle),
  );
  return json(200, {
    localDate: date,
    self: await dailyCount(caller.sub, date),
    friends: result,
  });
}
async function requireOwnHandle(sub) {
  const me = await ddb().send(
    new GetCommand({ TableName: tableName(), Key: { pk: Keys.user(sub), sk: Keys.profile } }),
  );
  if (!me.Item?.handle)
    throw new HttpError(409, 'handle_required', 'choose a handle before adding friends');
}
export async function postInvite(_e, caller) {
  await requireOwnHandle(caller.sub);
  await rateLimit(caller.sub, 'invite', 10, 3600);
  const now = Math.floor(Date.now() / 1000);
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = Array.from(
      { length: 10 },
      () => INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)],
    ).join('');
    try {
      await ddb().send(
        new PutCommand({
          TableName: tableName(),
          Item: { ...inviteKey(code), sub: caller.sub, ttl: now + INVITE_TTL_SEC },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
      return json(200, {
        code,
        expiresAt: new Date((now + INVITE_TTL_SEC) * 1000).toISOString(),
      });
    } catch (e) {
      if (!isConditionalFailure(e)) throw e;
    }
  }
  throw new HttpError(503, 'invite_unavailable', 'try again');
}
async function resolveTarget(body) {
  if ('inviteCode' in body) {
    const r = await ddb().send(
      new GetCommand({ TableName: tableName(), Key: inviteKey(body.inviteCode) }),
    );
    const it = r.Item;
    if (!it || it.ttl < Date.now() / 1000)
      throw new HttpError(404, 'invite_invalid', 'invite code is invalid or expired');
    return { sub: it.sub, viaInvite: true };
  }
  const r = await ddb().send(
    new GetCommand({ TableName: tableName(), Key: Keys.handle(body.handle) }),
  );
  // Same response for "no such user" as for any other failure would leak less, but handle lookup is
  // exact-match only and rate-limited (T12), so a clear 404 is acceptable for usability.
  if (!r.Item) throw new HttpError(404, 'user_not_found', 'no one has that handle');
  return { sub: r.Item.sub, viaInvite: false };
}
export async function postFriendRequest(event, caller) {
  const body = parseBody(event, v1.FriendRequestCreate);
  await requireOwnHandle(caller.sub);
  await rateLimit(caller.sub, 'friend_request', 20, 3600);
  const { sub: other, viaInvite } = await resolveTarget(body);
  if (other === caller.sub) throw Errors.badRequest('you cannot add yourself');
  const mine = await friendStatus(caller.sub, other);
  if (mine === 'accepted') throw Errors.conflict('already_friends', 'you are already friends');
  if (mine === 'pending_out' && !viaInvite)
    throw Errors.conflict('request_pending', 'request already sent');
  if ((await listFriendItems(caller.sub)).length >= MAX_FRIENDS)
    throw Errors.conflict('too_many_friends', `limit is ${MAX_FRIENDS}`);
  // An invite code is the other person's consent; a mutual request means both asked.
  const accept = viaInvite || mine === 'pending_in';
  const now = new Date().toISOString();
  await ddb().send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: tableName(),
            Item: {
              ...friendKey(caller.sub, other),
              otherSub: other,
              status: accept ? 'accepted' : 'pending_out',
              since: now,
            },
          },
        },
        {
          Put: {
            TableName: tableName(),
            Item: {
              ...friendKey(other, caller.sub),
              otherSub: caller.sub,
              status: accept ? 'accepted' : 'pending_in',
              since: now,
            },
          },
        },
      ],
    }),
  );
  const [friend] = await toFriends([
    {
      ...friendKey(caller.sub, other),
      otherSub: other,
      status: accept ? 'accepted' : 'pending_out',
      since: now,
    },
  ]);
  if (!friend) throw Errors.notFound();
  return json(200, { friend });
}
export async function postFriendRespond(event, caller) {
  const { userId, accept } = parseBody(event, v1.FriendRespond);
  const now = new Date().toISOString();
  try {
    if (accept) {
      await ddb().send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: tableName(),
                Key: friendKey(caller.sub, userId),
                UpdateExpression: 'SET #s = :a, since = :n',
                ConditionExpression: '#s = :in',
                ExpressionAttributeNames: { '#s': 'status' },
                ExpressionAttributeValues: { ':a': 'accepted', ':in': 'pending_in', ':n': now },
              },
            },
            {
              Update: {
                TableName: tableName(),
                Key: friendKey(userId, caller.sub),
                UpdateExpression: 'SET #s = :a, since = :n',
                ConditionExpression: '#s = :out',
                ExpressionAttributeNames: { '#s': 'status' },
                ExpressionAttributeValues: { ':a': 'accepted', ':out': 'pending_out', ':n': now },
              },
            },
          ],
        }),
      );
    } else {
      await removeBoth(caller.sub, userId, 'pending_in');
    }
  } catch (e) {
    if (isConditionalFailure(e)) throw Errors.notFound();
    throw e;
  }
  return json(200, { ok: true });
}
async function removeBoth(a, b, requireStatus) {
  await ddb().send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Delete: {
            TableName: tableName(),
            Key: friendKey(a, b),
            ...(requireStatus
              ? {
                  ConditionExpression: '#s = :s',
                  ExpressionAttributeNames: { '#s': 'status' },
                  ExpressionAttributeValues: { ':s': requireStatus },
                }
              : { ConditionExpression: 'attribute_exists(pk)' }),
          },
        },
        { Delete: { TableName: tableName(), Key: friendKey(b, a) } },
      ],
    }),
  );
}
export async function postFriendRemove(event, caller) {
  const { userId } = parseBody(event, v1.FriendRemove);
  try {
    await removeBoth(caller.sub, userId);
  } catch (e) {
    if (isConditionalFailure(e)) throw Errors.notFound();
    throw e;
  }
  return json(200, { ok: true });
}
/** Used by account deletion. */
export async function deleteAllFriendships(sub) {
  for (const f of await listFriendItems(sub)) {
    await ddb().send(
      new DeleteCommand({ TableName: tableName(), Key: friendKey(sub, f.otherSub) }),
    );
    await ddb().send(
      new DeleteCommand({ TableName: tableName(), Key: friendKey(f.otherSub, sub) }),
    );
  }
}
