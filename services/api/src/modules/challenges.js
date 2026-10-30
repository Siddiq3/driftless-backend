import {
  readState,
  accountKey,
  incarnationKey,
  activeWrite,
  assertActive,
} from '../lib/lifecycle.js';
import { createHash, randomUUID } from 'node:crypto';
import { GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { v1 } from '@siddiq3/driftless-contracts';
import { daysBetween, evaluateDay, localDateOf } from '@siddiq3/driftless-contracts/domain';
import { ddb, isConditionalFailure, Keys, tableName } from '../lib/ddb.js';
import { Errors, HttpError, json, parseBody } from '../lib/http.js';
import { rateLimit } from '../lib/rate.js';
import { batchGet } from '../lib/batch.js';
import { comparisonCount } from '../lib/comparison-count.js';
export const MAX_CHALLENGE_DAYS = 31;
const metaKey = (id) => ({ pk: `CHAL#${id}`, sk: 'META' });
const memberKey = (id, sub) => ({ pk: `CHAL#${id}`, sk: `MEMBER#${sub}` });
const journalKey = (id, sub) => ({ pk: Keys.user(sub), sk: `MEMBERSHIP#${id}` });
const toSummary = (m) => ({
  challengeId: m.challengeId,
  ownerId: m.ownerUserId ?? null,
  title: m.title,
  metric: m.metric,
  startDate: m.startDate,
  endDate: m.endDate,
  tz: m.tz,
  maxMembers: m.maxMembers,
  memberCount: m.memberCount,
});
function idParam(e) {
  const id = e.pathParameters?.id;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) throw Errors.notFound();
  return id.toLowerCase();
}
async function getMeta(id) {
  const r = await ddb().send(
    new GetCommand({ TableName: tableName(), Key: metaKey(id), ConsistentRead: true }),
  );
  if (!r.Item) throw Errors.notFound();
  return r.Item;
}
async function isMember(id, sub) {
  const r = await ddb().send(
    new GetCommand({ TableName: tableName(), Key: memberKey(id, sub), ConsistentRead: true }),
  );
  return Boolean(r.Item);
}
function memberItem(id, sub, ttl) {
  return {
    ...memberKey(id, sub),
    sub,
    joinedAt: new Date().toISOString(),
    gsi1pk: `MEMBEROF#${sub}`,
    gsi1sk: `CHAL#${id}`,
    ttl,
  };
}
// Direct invitations live in the same challenge/membership model, owned by incarnations.
const inviteKey = (id, target) => ({ pk: Keys.user(target), sk: `BATTLEINVITE#${id}` });
const operationKey = (sub, id) => ({ pk: Keys.user(sub), sk: `BATTLEOP#${id}` });
const pairKey = (sub, target) => ({ pk: Keys.user(sub), sk: `BATTLEPAIR#${target}` });
const expired = (m) => localDateOf(Date.now(), m.tz) > m.endDate;
const put = (Item, extra = {}) => ({ Put: { TableName: tableName(), Item, ...extra } });
const condition = (Key, expression, values) => ({
  ConditionCheck: {
    TableName: tableName(),
    Key,
    ConditionExpression: expression,
    ExpressionAttributeValues: values,
  },
});
const friendshipKey = (a, b) => ({ pk: Keys.user(a), sk: `FRIEND#${b}` });
async function friendship(a, b) {
  const [left, right] = await Promise.all([
    readState(friendshipKey(a, b)),
    readState(friendshipKey(b, a)),
  ]);
  if (left?.status !== 'accepted' || right?.status !== 'accepted')
    throw Errors.conflict('friend_unavailable', 'This friend is no longer available for a battle');
  return { left: left.since, right: right.since };
}
const friendshipGuards = (a, b, since) =>
  [
    condition(friendshipKey(a, b), '#s = :accepted AND since = :since', {
      ':accepted': 'accepted',
      ':since': since.left,
    }),
    condition(friendshipKey(b, a), '#s = :accepted AND since = :since', {
      ':accepted': 'accepted',
      ':since': since.right,
    }),
  ].map((c) => {
    c.ConditionCheck.ExpressionAttributeNames = { '#s': 'status' };
    return c;
  });
async function directStatus(m) {
  if (!m.targetIncarnation) return null;
  if (!m.ownerId) return 'unavailable';
  const [owner, target] = await Promise.all([
    readState(incarnationKey(m.ownerId)),
    readState(incarnationKey(m.targetIncarnation)),
  ]);
  if (owner?.state !== 'active' || target?.state !== 'active') return 'unavailable';
  if (['declined', 'cancelled', 'unavailable'].includes(m.invitationState))
    return m.invitationState;
  try {
    const since = await friendship(m.ownerId, m.targetIncarnation);
    if (since.left !== m.friendshipSince.left || since.right !== m.friendshipSince.right)
      return 'unavailable';
  } catch (e) {
    if (e instanceof HttpError && e.code === 'friend_unavailable') return 'unavailable';
    throw e;
  }
  return expired(m) ? 'expired' : m.invitationState;
}
async function summary(m, caller) {
  const base = toSummary(m);
  const member = await readState(memberKey(m.challengeId, caller.sub));
  if (member)
    base.myScoreConsent = member.scoreConsentVersion === 1 && member.scoreConsent === true;
  if (m.targetIncarnation) {
    if (caller.sub !== m.ownerId && caller.sub !== m.targetIncarnation) throw Errors.notFound();
    base.targetUserId = m.targetUserId;
    base.invitationState = await directStatus(m);
    const owner =
      base.invitationState === 'unavailable'
        ? null
        : await readState({ pk: Keys.user(m.ownerId), sk: Keys.profile });
    base.ownerName = owner?.displayName ?? owner?.handle ?? null;
  }
  return base;
}
async function sendSummary(m, caller) {
  return json(200, await summary(m, caller));
}
function assertDirectUsable(status) {
  if (!['pending', 'accepted'].includes(status))
    throw Errors.conflict(
      `battle_${status}`,
      `This battle is ${status}. Start a new battle if needed.`,
    );
}
async function queryOwned(sub, prefix) {
  const items = [];
  let start;
  do {
    const r = await ddb().send(
      new QueryCommand({
        TableName: tableName(),
        ConsistentRead: true,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk,:prefix)',
        ExpressionAttributeValues: { ':pk': Keys.user(sub), ':prefix': prefix },
        ExclusiveStartKey: start,
      }),
    );
    items.push(...(r.Items ?? []));
    start = r.LastEvaluatedKey;
  } while (start);
  return items;
}
export async function postChallenge(event, caller) {
  const c = parseBody(event, v1.ChallengeCreate);
  if (
    c.targetUserId &&
    (!c.operationId || !c.scoreConsent || c.maxMembers !== 2 || c.targetUserId === caller.userId)
  )
    throw Errors.badRequest(
      'A direct battle requires a different friend, two places, an operation ID and battle score consent',
    );
  const fingerprint = createHash('sha256').update(JSON.stringify(c)).digest('hex');
  const replay = async () => {
    const op = c.operationId ? await readState(operationKey(caller.sub, c.operationId)) : null;
    if (!op) return null;
    if (op.fingerprint !== fingerprint)
      throw Errors.conflict('operation_reuse', 'Use the original battle request when retrying');
    return sendSummary(await getMeta(op.challengeId), caller);
  };
  const previous = await replay();
  if (previous) return previous;
  await rateLimit(caller.sub, 'challenge_create', 5, 86_400);
  const length = daysBetween(c.startDate, c.endDate) + 1;
  if (length > MAX_CHALLENGE_DAYS)
    throw Errors.badRequest(`a challenge can last at most ${MAX_CHALLENGE_DAYS} days`);
  const today = localDateOf(Date.now(), c.tz);
  if (daysBetween(today, c.startDate) < -1) throw Errors.badRequest('start date is in the past');
  if (c.endDate < today) throw Errors.badRequest('challenge has already ended');
  let target, since;
  if (c.targetUserId) {
    const state = await readState(accountKey(c.targetUserId));
    if (state?.state !== 'active')
      throw Errors.conflict(
        'friend_unavailable',
        'This friend is no longer available for a battle',
      );
    target = state.incarnation;
    since = await friendship(caller.sub, target);
  }
  const id = randomUUID();
  const ttl = Math.floor(Date.parse(`${c.endDate}T00:00:00Z`) / 1000) + 90 * 86_400;
  const { operationId, scoreConsent, targetUserId, ...fields } = c;
  const meta = {
    ...metaKey(id),
    challengeId: id,
    ownerId: caller.sub,
    ownerUserId: caller.userId,
    ...fields,
    memberCount: 1,
    ttl,
    ...(target
      ? {
          targetIncarnation: target,
          targetUserId,
          invitationState: 'pending',
          friendshipSince: since,
        }
      : {}),
  };
  const member = {
    ...memberItem(id, caller.sub, ttl),
    ...(scoreConsent ? { scoreConsentVersion: 1, scoreConsent: true } : {}),
  };
  const items = [
    put(meta, { ConditionExpression: 'attribute_not_exists(pk)' }),
    put(member),
    put({ ...journalKey(id, caller.sub), challengeId: id }),
    put({ pk: Keys.user(caller.sub), sk: `OWNEDCHALLENGE#${id}`, challengeId: id }),
  ];
  if (operationId)
    items.push(
      put(
        { ...operationKey(caller.sub, operationId), challengeId: id, fingerprint },
        { ConditionExpression: 'attribute_not_exists(pk)' },
      ),
    );
  if (target) {
    items.push(
      put({ ...inviteKey(id, target), challengeId: id, ownerId: caller.sub, ttl }),
      ...friendshipGuards(caller.sub, target, since),
      condition(accountKey(targetUserId), '#s = :active AND incarnation = :inc', {
        ':active': 'active',
        ':inc': target,
      }),
    );
    items[items.length - 1].ConditionCheck.ExpressionAttributeNames = { '#s': 'state' };
    // One outstanding invitation per creator/target pair, regardless of repeated operation IDs.
    const pair = await readState(pairKey(caller.sub, target));
    if (pair) {
      const existing = await readState(metaKey(pair.challengeId));
      if (existing && ['pending', 'accepted'].includes(await directStatus(existing))) {
        // A concurrent copy of this operation may have committed after our first
        // receipt read. Replay it before treating its pair as a different battle.
        const committed = await replay();
        if (committed) return committed;
        throw Errors.conflict(
          'battle_exists',
          'A battle with this friend is already active. Open Your battles.',
        );
      }
    }
    items.push(
      put(
        { ...pairKey(caller.sub, target), challengeId: id },
        pair
          ? {
              ConditionExpression: 'challengeId = :previous',
              ExpressionAttributeValues: { ':previous': pair.challengeId },
            }
          : { ConditionExpression: 'attribute_not_exists(pk)' },
      ),
    );
  }
  try {
    await activeWrite(
      caller.sub,
      new TransactWriteCommand({ TransactItems: items }),
      target ? [target] : [],
    );
  } catch (e) {
    if (!isConditionalFailure(e)) throw e;
    const won = await replay();
    if (won) return won;
    throw Errors.conflict(
      'battle_changed',
      'Friendship or invitation changed. Refresh Your battles before retrying.',
    );
  }
  return sendSummary(meta, caller);
}
export async function postJoin(event, caller) {
  const id = idParam(event),
    meta = await getMeta(id);
  const body = parseBody({ ...event, body: event.body || '{}' }, v1.ChallengeJoin);
  if (!meta.ownerId) throw Errors.notFound();
  await assertActive(meta.ownerId);
  if (meta.targetIncarnation && caller.sub !== meta.targetIncarnation) throw Errors.notFound();
  const since =
    caller.sub === meta.ownerId
      ? null
      : await friendship(caller.sub, meta.ownerId).catch((e) => {
          if (!meta.targetIncarnation && e instanceof HttpError && e.code === 'friend_unavailable')
            throw Errors.notFound();
          throw e;
        });
  if (meta.targetIncarnation) {
    assertDirectUsable(await directStatus(meta));
    if (!body.scoreConsent)
      throw Errors.badRequest('Accepting a direct battle requires battle-only score consent');
  }
  if (await isMember(id, caller.sub)) return sendSummary(meta, caller);
  if (expired(meta)) throw Errors.conflict('challenge_over', 'this challenge has ended');
  const update = {
    Update: {
      TableName: tableName(),
      Key: metaKey(id),
      UpdateExpression: meta.targetIncarnation
        ? 'SET memberCount = memberCount + :one, invitationState = :accepted'
        : 'SET memberCount = memberCount + :one',
      ConditionExpression: meta.targetIncarnation
        ? 'memberCount < maxMembers AND invitationState = :pending'
        : 'memberCount < maxMembers',
      ExpressionAttributeValues: {
        ':one': 1,
        ...(meta.targetIncarnation ? { ':accepted': 'accepted', ':pending': 'pending' } : {}),
      },
    },
  };
  const items = [
    update,
    put(
      {
        ...memberItem(id, caller.sub, meta.ttl),
        ...(body.scoreConsent ? { scoreConsentVersion: 1, scoreConsent: true } : {}),
      },
      { ConditionExpression: 'attribute_not_exists(pk)' },
    ),
    put({ ...journalKey(id, caller.sub), challengeId: id }),
    ...(since ? friendshipGuards(caller.sub, meta.ownerId, since) : []),
  ];
  try {
    await activeWrite(caller.sub, new TransactWriteCommand({ TransactItems: items }), [
      meta.ownerId,
    ]);
  } catch (e) {
    if (!isConditionalFailure(e)) throw e;
    const winner = await getMeta(id);
    if (
      (await isMember(id, caller.sub)) &&
      (!meta.targetIncarnation || (await directStatus(winner)) === 'accepted')
    )
      return sendSummary(winner, caller);
    throw Errors.conflict(
      meta.targetIncarnation ? 'challenge_changed' : 'challenge_full',
      'This invitation changed, is full or is no longer available. Refresh before retrying.',
    );
  }
  return sendSummary(
    {
      ...meta,
      memberCount: meta.memberCount + 1,
      ...(meta.targetIncarnation ? { invitationState: 'accepted' } : {}),
    },
    caller,
  );
}
export async function postInvitation(event, caller) {
  const id = idParam(event),
    m = await getMeta(id);
  const { action } = parseBody(event, v1.BattleInvitationAction);
  if (
    !m.targetIncarnation ||
    (action === 'cancel' ? caller.sub !== m.ownerId : caller.sub !== m.targetIncarnation)
  )
    throw Errors.notFound();
  const next = action === 'cancel' ? 'cancelled' : 'declined';
  if (m.invitationState === next) return sendSummary(m, caller);
  assertDirectUsable(await directStatus(m));
  if (action === 'decline' && m.invitationState !== 'pending')
    throw Errors.conflict('invitation_changed', 'An accepted battle must be left, not declined');
  try {
    await activeWrite(
      caller.sub,
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: tableName(),
              Key: metaKey(id),
              UpdateExpression: 'SET invitationState = :next',
              ConditionExpression: 'invitationState = :previous',
              ExpressionAttributeValues: { ':next': next, ':previous': m.invitationState },
            },
          },
        ],
      }),
      [m.ownerId, m.targetIncarnation],
    );
  } catch (e) {
    if (!isConditionalFailure(e)) throw e;
    const winner = await getMeta(id);
    if (winner.invitationState !== next)
      throw Errors.conflict('invitation_changed', 'Invitation changed; refresh before retrying');
  }
  return sendSummary(await getMeta(id), caller);
}
export async function putScoreConsent(event, caller) {
  const id = idParam(event),
    m = await getMeta(id),
    { share } = parseBody(event, v1.BattleScoreConsent);
  if (!(await isMember(id, caller.sub))) throw Errors.notFound();
  if (share) {
    if (expired(m)) throw Errors.conflict('challenge_over', 'This battle has ended');
    if (m.targetIncarnation) assertDirectUsable(await directStatus(m));
  }
  const guards = [];
  if (share && m.targetIncarnation) {
    guards.push(...friendshipGuards(m.ownerId, m.targetIncarnation, m.friendshipSince), {
      ConditionCheck: {
        TableName: tableName(),
        Key: metaKey(id),
        ConditionExpression: 'invitationState = :previous',
        ExpressionAttributeValues: { ':previous': m.invitationState },
      },
    });
  } else if (share && m.ownerId && caller.sub !== m.ownerId) {
    const since = await friendship(caller.sub, m.ownerId);
    guards.push(...friendshipGuards(caller.sub, m.ownerId, since));
  }
  try {
    await activeWrite(
      caller.sub,
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: tableName(),
              Key: memberKey(id, caller.sub),
              UpdateExpression: 'SET scoreConsent = :share, scoreConsentVersion = :version',
              ConditionExpression: 'attribute_exists(pk)',
              ExpressionAttributeValues: { ':share': share, ':version': 1 },
            },
          },
          ...guards,
        ],
      }),
      share && m.ownerId ? [m.ownerId, ...(m.targetIncarnation ? [m.targetIncarnation] : [])] : [],
    );
  } catch (e) {
    if (!isConditionalFailure(e)) throw e;
    throw Errors.conflict(
      'battle_changed',
      'This battle changed. Refresh before changing score sharing.',
    );
  }
  return sendSummary(m, caller);
}
export async function postLeave(event, caller) {
  const id = idParam(event),
    m = await getMeta(id);
  if (!(await isMember(id, caller.sub))) {
    if (m.targetIncarnation && [m.ownerId, m.targetIncarnation].includes(caller.sub))
      return json(200, { ok: true });
    throw Errors.notFound();
  }
  const items = [
    {
      Delete: {
        TableName: tableName(),
        Key: memberKey(id, caller.sub),
        ConditionExpression: 'attribute_exists(pk)',
      },
    },
    {
      Update: {
        TableName: tableName(),
        Key: metaKey(id),
        UpdateExpression: m.targetIncarnation
          ? 'SET memberCount = memberCount - :one, invitationState = :cancelled'
          : 'SET memberCount = memberCount - :one',
        ConditionExpression: 'memberCount > :zero',
        ExpressionAttributeValues: {
          ':one': 1,
          ':zero': 0,
          ...(m.targetIncarnation ? { ':cancelled': 'cancelled' } : {}),
        },
      },
    },
    { Delete: { TableName: tableName(), Key: journalKey(id, caller.sub) } },
  ];
  try {
    await activeWrite(caller.sub, new TransactWriteCommand({ TransactItems: items }));
  } catch (e) {
    if (!isConditionalFailure(e) || (await isMember(id, caller.sub))) throw e;
  }
  return json(200, { ok: true });
}
export async function getChallenges(_event, caller) {
  const [own, inbox] = await Promise.all([
    queryOwned(caller.sub, 'MEMBERSHIP#'),
    queryOwned(caller.sub, 'BATTLEINVITE#'),
  ]);
  const load = async (rows) => {
    const out = [];
    for (const row of rows.slice(0, 100)) {
      const m = await readState(metaKey(row.challengeId));
      if (m) out.push(await summary(m, caller));
    }
    return out.sort((a, b) => b.endDate.localeCompare(a.endDate));
  };
  const challenges = await load(own);
  const joined = new Set(challenges.map((c) => c.challengeId));
  const invitations = await load(inbox.filter((row) => !joined.has(row.challengeId)));
  return json(200, { challenges, invitations });
}
async function memberDays(sub, from, to) {
  const rows = [];
  let start;
  do {
    const r = await ddb().send(
      new QueryCommand({
        TableName: tableName(),
        ExclusiveStartKey: start,
        KeyConditionExpression: 'pk = :pk AND sk BETWEEN :a AND :b',
        ConsistentRead: true,
        ExpressionAttributeValues: {
          ':pk': Keys.user(sub),
          ':a': Keys.dayRangeStart(from),
          ':b': Keys.dayRangeEnd(to),
        },
      }),
    );
    rows.push(...(r.Items ?? []));
    start = r.LastEvaluatedKey;
  } while (start);
  // Combine devices for the same local day (someone with two phones).
  const byDate = new Map();
  for (const it of rows) {
    const d = it;
    if (d.ttl != null && d.ttl <= Date.now() / 1000) continue;
    const count = comparisonCount(d);
    const cur = byDate.get(d.localDate);
    if (!cur) byDate.set(d.localDate, { ...d, comparisonViews: count });
    else
      byDate.set(d.localDate, {
        localDate: d.localDate,
        minutes:
          cur.minutes === null && d.minutes === null ? null : (cur.minutes ?? 0) + (d.minutes ?? 0),
        // A partly observed device-day must not appear as a lower, winning count.
        comparisonViews:
          cur.comparisonViews === null || count === null ? null : cur.comparisonViews + count,
        views: null,
        coverage: Math.min(cur.coverage, d.coverage),
      });
  }
  return [...byDate.values()];
}
async function minutesGoal(sub) {
  let start;
  do {
    const r = await ddb().send(
      new QueryCommand({
        TableName: tableName(),
        ExclusiveStartKey: start,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :g)',
        ExpressionAttributeValues: { ':pk': Keys.user(sub), ':g': 'GOAL#' },
      }),
    );
    const g = (r.Items ?? []).find((x) => x.metric === 'minutes' && x.enabled);
    if (g) return g.dailyLimit;
    start = r.LastEvaluatedKey;
  } while (start);
  return null;
}
/** Score for one member, or null if they have no usable data. Lower is better except goal_days. */
export function scoreMember(metric, days, goalMinutes) {
  if (metric === 'fewest_minutes') {
    const t = days.filter((d) => d.minutes !== null);
    return t.length
      ? Math.round((t.reduce((n, d) => n + d.minutes, 0) / t.length) * 10) / 10
      : null;
  }
  if (metric === 'fewest_views') {
    const counts = days
      .map((day) => ('comparisonViews' in day ? day.comparisonViews : comparisonCount(day)))
      .filter((count) => count !== null);
    return counts.length
      ? Math.round((counts.reduce((sum, count) => sum + count, 0) / counts.length) * 10) / 10
      : null;
  }
  if (goalMinutes === null) return null;
  return days.filter(
    (d) => evaluateDay(d, { metric: 'minutes', dailyLimit: goalMinutes }) === 'kept',
  ).length;
}
export async function getLeaderboard(event, caller) {
  const id = idParam(event);
  const requester = await readState(memberKey(id, caller.sub));
  if (!requester) throw Errors.notFound();
  await rateLimit(caller.sub, 'leaderboard', 120, 3600);
  const meta = await getMeta(id);
  const today = localDateOf(Date.now(), meta.tz);
  const to = today < meta.endDate ? today : meta.endDate;
  const expectedDays = meta.startDate > to ? 0 : daysBetween(meta.startDate, to) + 1;
  const direct = meta.targetIncarnation ? await directStatus(meta) : null;
  const members = await ddb().send(
    new QueryCommand({
      TableName: tableName(),
      ConsistentRead: true,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk,:m)',
      ExpressionAttributeValues: { ':pk': `CHAL#${id}`, ':m': 'MEMBER#' },
    }),
  );
  const rows = (members.Items ?? []).slice(0, 50);
  const profiles = await batchGet(
    rows.map((m) => ({ pk: Keys.user(m.sub), sk: Keys.profile })),
    true,
  );
  const prof = new Map(profiles.map((p) => [String(p.pk).slice(5), p]));
  const participants = [],
    scored = [];
  const requesterRevoked = requester.scoreConsentVersion === 1 && !requester.scoreConsent;
  const requesterUnavailable =
    !direct && requester.scoreConsentVersion === 1 && meta.ownerId && caller.sub !== meta.ownerId
      ? await friendship(caller.sub, meta.ownerId).then(
          () => false,
          (e) => {
            if (e instanceof HttpError && e.code === 'friend_unavailable') return true;
            throw e;
          },
        )
      : false;
  for (let offset = 0; offset < rows.length; offset += 10) {
    const batch = await Promise.all(
      rows.slice(offset, offset + 10).map(async (member) => {
        const sub = member.sub,
          p = prof.get(sub),
          scoped = member.scoreConsentVersion === 1;
        let status = requesterUnavailable ? 'unavailable' : null;
        if (
          !p?.handle ||
          !(await assertActive(sub).then(
            () => true,
            () => false,
          ))
        )
          status = 'unavailable';
        else if (direct && !['pending', 'accepted'].includes(direct))
          status = direct === 'expired' ? 'expired' : 'unavailable';
        else if (scoped && expired(meta)) status = 'expired';
        else if (
          requesterRevoked ||
          (scoped ? !member.scoreConsent : !p.consent?.cloudSync || !p.consent.shareWithFriends)
        )
          status = 'sharing_off';
        else if (direct === 'pending') status = 'awaiting_opponent';
        else if (expectedDays === 0) status = 'no_data';
        // A new battle-only grant does not survive removal/recreation of its friendship.
        if (!status && scoped && !direct && meta.ownerId && sub !== meta.ownerId) {
          const connected = await friendship(sub, meta.ownerId).then(
            () => true,
            (e) => {
              if (e instanceof HttpError && e.code === 'friend_unavailable') return false;
              throw e;
            },
          );
          if (!connected) status = 'unavailable';
        }
        if (status)
          return {
            participant: {
              userId: p?.userId ?? sub,
              handle: p?.handle ?? null,
              status,
              availableDays: 0,
              expectedDays,
            },
          };
        const [days, goal] = await Promise.all([
          memberDays(sub, meta.startDate, to),
          meta.metric === 'goal_days' ? minutesGoal(sub) : Promise.resolve(null),
        ]);
        const availableDays = days.filter((d) =>
          meta.metric === 'fewest_views'
            ? d.comparisonViews !== null
            : meta.metric === 'goal_days'
              ? goal !== null &&
                evaluateDay(d, { metric: 'minutes', dailyLimit: goal }) !== 'unknown'
              : d.minutes !== null,
        ).length;
        // A zero goal-day score is valid only when some measured days were actually evaluated.
        const score = availableDays ? scoreMember(meta.metric, days, goal) : null;
        return {
          participant: {
            userId: p.userId,
            handle: p.handle,
            status: score === null ? 'no_data' : 'ready',
            availableDays,
            expectedDays,
          },
          ...(score === null
            ? {}
            : { entry: { userId: p.userId, handle: p.handle, score, availableDays } }),
        };
      }),
    );
    for (const result of batch) {
      participants.push(result.participant);
      if (result.entry) scored.push(result.entry);
    }
  }
  // A consent withdrawal/cancel/leave while history was being read must fence the reply.
  const finalRequester = await readState(memberKey(id, caller.sub));
  if (!finalRequester) throw Errors.notFound();
  let stopAll = finalRequester.scoreConsentVersion === 1 && !finalRequester.scoreConsent;
  let stoppedStatus = 'sharing_off';
  if (meta.targetIncarnation) {
    const latest = await getMeta(id),
      status = await directStatus(latest);
    if (status !== 'accepted') {
      stopAll = true;
      stoppedStatus =
        status === 'expired'
          ? 'expired'
          : status === 'pending'
            ? 'awaiting_opponent'
            : 'unavailable';
    }
  }
  const blocked = new Set();
  for (const member of rows.filter((r) => r.scoreConsentVersion === 1)) {
    const latest = await readState(memberKey(id, member.sub));
    const stillActive = await assertActive(member.sub).then(
      () => true,
      () => false,
    );
    const participant = participants.find((p) => p.userId === prof.get(member.sub)?.userId);
    let reason = null;
    if (stopAll) reason = stoppedStatus;
    else if (!latest || !stillActive) reason = 'unavailable';
    else if (!latest.scoreConsent) reason = 'sharing_off';
    else if (expired(meta)) reason = 'expired';
    if (reason && participant) {
      participant.status = reason;
      participant.availableDays = 0;
      blocked.add(participant.userId);
    }
  }
  for (let i = scored.length - 1; i >= 0; i--)
    if (blocked.has(scored[i].userId)) scored.splice(i, 1);
  const higher = meta.metric === 'goal_days';
  scored.sort((a, b) => (higher ? b.score - a.score : a.score - b.score));
  const entries = [];
  scored.forEach((s, i) => {
    const previous = entries[i - 1];
    const rank = previous && scored[i - 1].score === s.score ? previous.rank : i + 1;
    // Legacy response shape stays compatible; data completeness is always in participants.
    entries.push({
      userId: s.userId,
      handle: s.handle,
      score: s.score,
      rank,
      scoreSource: 'device',
    });
  });
  return json(200, {
    challengeId: id,
    asOf: to,
    entries,
    hiddenMembers: rows.length - scored.length,
    participants,
  });
}
