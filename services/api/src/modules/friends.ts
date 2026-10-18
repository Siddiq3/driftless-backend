import { randomInt } from 'node:crypto';
import {
  BatchGetCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { v1 } from '@siddiq3/driftless-contracts';
import type { Caller } from '../lib/auth.js';
import { ddb, isConditionalFailure, Keys, tableName } from '../lib/ddb.js';
import { Errors, HttpError, json, parseBody, type ApiEvent, type ApiResult } from '../lib/http.js';
import { rateLimit } from '../lib/rate.js';

export const MAX_FRIENDS = 200;
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const INVITE_TTL_SEC = 7 * 86_400;

type FriendStatus = 'pending_out' | 'pending_in' | 'accepted';
type FriendItem = { pk: string; sk: string; otherSub: string; status: FriendStatus; since: string };

const friendKey = (a: string, b: string) => ({ pk: Keys.user(a), sk: `FRIEND#${b}` });
const inviteKey = (code: string) => ({ pk: `INVITE#${code}`, sk: 'INVITE' });

export async function friendStatus(a: string, b: string): Promise<FriendStatus | null> {
  const r = await ddb().send(new GetCommand({ TableName: tableName(), Key: friendKey(a, b) }));
  return (r.Item as FriendItem | undefined)?.status ?? null;
}

export async function areFriends(a: string, b: string): Promise<boolean> {
  return (await friendStatus(a, b)) === 'accepted';
}

async function listFriendItems(sub: string): Promise<FriendItem[]> {
  const out: FriendItem[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const r = await ddb().send(
      new QueryCommand({
        TableName: tableName(),
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :f)',
        ExpressionAttributeValues: { ':pk': Keys.user(sub), ':f': 'FRIEND#' },
        ExclusiveStartKey: start,
      }),
    );
    out.push(...((r.Items ?? []) as FriendItem[]));
    start = r.LastEvaluatedKey;
  } while (start);
  return out;
}

/** Current handle / display name for each user (never stale copies). Users without a handle are omitted. */
async function profiles(
  subs: string[],
): Promise<Map<string, { handle: string; displayName: string | null }>> {
  const map = new Map<string, { handle: string; displayName: string | null }>();
  for (let i = 0; i < subs.length; i += 100) {
    const keys = subs.slice(i, i + 100).map((s) => ({ pk: Keys.user(s), sk: Keys.profile }));
    const r = await ddb().send(
      new BatchGetCommand({ RequestItems: { [tableName()]: { Keys: keys } } }),
    );
    for (const p of r.Responses?.[tableName()] ?? []) {
      const sub = String(p.pk).slice('USER#'.length);
      if (p.handle)
        map.set(sub, {
          handle: p.handle as string,
          displayName: (p.displayName as string | null) ?? null,
        });
    }
  }
  return map;
}

async function toFriends(items: FriendItem[]): Promise<v1.Friend[]> {
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

export async function getFriends(_e: ApiEvent, caller: Caller): Promise<ApiResult> {
  return json(200, { friends: await toFriends(await listFriendItems(caller.sub)) });
}

async function requireOwnHandle(sub: string): Promise<void> {
  const me = await ddb().send(
    new GetCommand({ TableName: tableName(), Key: { pk: Keys.user(sub), sk: Keys.profile } }),
  );
  if (!me.Item?.handle)
    throw new HttpError(409, 'handle_required', 'choose a handle before adding friends');
}

export async function postInvite(_e: ApiEvent, caller: Caller): Promise<ApiResult> {
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
      } satisfies { code: string; expiresAt: string });
    } catch (e) {
      if (!isConditionalFailure(e)) throw e;
    }
  }
  throw new HttpError(503, 'invite_unavailable', 'try again');
}

async function resolveTarget(
  body: { handle: string } | { inviteCode: string },
): Promise<{ sub: string; viaInvite: boolean }> {
  if ('inviteCode' in body) {
    const r = await ddb().send(
      new GetCommand({ TableName: tableName(), Key: inviteKey(body.inviteCode) }),
    );
    const it = r.Item as { sub: string; ttl: number } | undefined;
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
  return { sub: r.Item.sub as string, viaInvite: false };
}

export async function postFriendRequest(event: ApiEvent, caller: Caller): Promise<ApiResult> {
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
  return json(200, { friend } satisfies { friend: v1.Friend });
}

export async function postFriendRespond(event: ApiEvent, caller: Caller): Promise<ApiResult> {
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

async function removeBoth(a: string, b: string, requireStatus?: FriendStatus) {
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

export async function postFriendRemove(event: ApiEvent, caller: Caller): Promise<ApiResult> {
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
export async function deleteAllFriendships(sub: string): Promise<void> {
  for (const f of await listFriendItems(sub)) {
    await ddb().send(
      new DeleteCommand({ TableName: tableName(), Key: friendKey(sub, f.otherSub) }),
    );
    await ddb().send(
      new DeleteCommand({ TableName: tableName(), Key: friendKey(f.otherSub, sub) }),
    );
  }
}
