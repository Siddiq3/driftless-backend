import { activeWrite, assertActive } from '../lib/lifecycle.js';
import { randomUUID } from 'node:crypto';
import { GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { v1 } from '@siddiq3/driftless-contracts';
import { daysBetween, evaluateDay, localDateOf } from '@siddiq3/driftless-contracts/domain';
import { ddb, isConditionalFailure, Keys, tableName } from '../lib/ddb.js';
import { Errors, json, parseBody } from '../lib/http.js';
import { rateLimit } from '../lib/rate.js';
import { areFriends } from './friends.js';
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
  const r = await ddb().send(new GetCommand({ TableName: tableName(), Key: memberKey(id, sub) }));
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
export async function postChallenge(event, caller) {
  const c = parseBody(event, v1.ChallengeCreate);
  await rateLimit(caller.sub, 'challenge_create', 5, 86_400);
  const length = daysBetween(c.startDate, c.endDate) + 1;
  if (length > MAX_CHALLENGE_DAYS)
    throw Errors.badRequest(`a challenge can last at most ${MAX_CHALLENGE_DAYS} days`);
  const today = localDateOf(Date.now(), c.tz);
  if (daysBetween(today, c.startDate) < -1) throw Errors.badRequest('start date is in the past');
  const id = randomUUID();
  const ttl = Math.floor(Date.parse(`${c.endDate}T00:00:00Z`) / 1000) + 90 * 86_400;
  const meta = {
    ...metaKey(id),
    challengeId: id,
    ownerId: caller.sub,
    ownerUserId: caller.userId,
    ...c,
    memberCount: 1,
    ttl,
  };
  await activeWrite(
    caller.sub,
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: tableName(),
            Item: meta,
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
        { Put: { TableName: tableName(), Item: memberItem(id, caller.sub, ttl) } },
        {
          Put: { TableName: tableName(), Item: { ...journalKey(id, caller.sub), challengeId: id } },
        },
        {
          Put: {
            TableName: tableName(),
            Item: { pk: Keys.user(caller.sub), sk: `OWNEDCHALLENGE#${id}`, challengeId: id },
          },
        },
      ],
    }),
  );
  return json(200, toSummary(meta));
}
export async function postJoin(event, caller) {
  const id = idParam(event);
  const meta = await getMeta(id);
  if (!meta.ownerId) throw Errors.notFound();
  await assertActive(meta.ownerId);
  // Friends-only (D-011): you can join only challenges created by a friend.
  if (meta.ownerId !== caller.sub && !(await areFriends(caller.sub, meta.ownerId)))
    throw Errors.notFound();
  if (await isMember(id, caller.sub)) return json(200, toSummary(meta));
  if (localDateOf(Date.now(), meta.tz) > meta.endDate)
    throw Errors.conflict('challenge_over', 'this challenge has ended');
  try {
    await activeWrite(
      caller.sub,
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: tableName(),
              Key: metaKey(id),
              UpdateExpression: 'SET memberCount = memberCount + :one',
              ConditionExpression: 'memberCount < maxMembers',
              ExpressionAttributeValues: { ':one': 1 },
            },
          },
          {
            Put: {
              TableName: tableName(),
              Item: memberItem(id, caller.sub, meta.ttl),
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
          {
            Put: {
              TableName: tableName(),
              Item: { ...journalKey(id, caller.sub), challengeId: id },
            },
          },
        ],
      }),
      [meta.ownerId],
    );
  } catch (e) {
    if (isConditionalFailure(e)) throw Errors.conflict('challenge_full', 'this challenge is full');
    throw e;
  }
  return json(200, toSummary({ ...meta, memberCount: meta.memberCount + 1 }));
}
export async function postLeave(event, caller) {
  const id = idParam(event);
  try {
    await activeWrite(
      caller.sub,
      new TransactWriteCommand({
        TransactItems: [
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
              UpdateExpression: 'SET memberCount = memberCount - :one',
              ConditionExpression: 'memberCount > :zero',
              ExpressionAttributeValues: { ':one': 1, ':zero': 0 },
            },
          },
          { Delete: { TableName: tableName(), Key: journalKey(id, caller.sub) } },
        ],
      }),
    );
  } catch (e) {
    if (isConditionalFailure(e)) throw Errors.notFound();
    throw e;
  }
  return json(200, { ok: true });
}
export async function getChallenges(_e, caller) {
  const r = await ddb().send(
    new QueryCommand({
      TableName: tableName(),
      IndexName: 'gsi1',
      KeyConditionExpression: 'gsi1pk = :p AND begins_with(gsi1sk, :c)',
      ExpressionAttributeValues: { ':p': `MEMBEROF#${caller.sub}`, ':c': 'CHAL#' },
    }),
  );
  const ids = (r.Items ?? []).map((i) => String(i.gsi1sk).slice('CHAL#'.length));
  if (ids.length === 0) return json(200, { challenges: [] });
  const got = await batchGet(ids.slice(0, 100).map(metaKey));
  const challenges = got.map(toSummary).sort((a, b) => (a.endDate < b.endDate ? 1 : -1));
  return json(200, { challenges });
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
  if (!(await isMember(id, caller.sub))) throw Errors.notFound(); // non-members can't see members
  await rateLimit(caller.sub, 'leaderboard', 120, 3600);
  const meta = await getMeta(id);
  const today = localDateOf(Date.now(), meta.tz);
  const to = today < meta.endDate ? today : meta.endDate;
  const members = await ddb().send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :m)',
      ExpressionAttributeValues: { ':pk': `CHAL#${id}`, ':m': 'MEMBER#' },
    }),
  );
  const subs = (members.Items ?? []).map((m) => m.sub).slice(0, 50);
  const prof = await batchGet(
    subs.map((s) => ({ pk: Keys.user(s), sk: Keys.profile })),
    true,
  );
  const profiles = new Map(prof.map((p) => [String(p.pk).slice('USER#'.length), p]));
  const scored = [];
  // Bound fan-out while avoiding a network round trip per member in series.
  for (let offset = 0; offset < subs.length; offset += 10) {
    const batch = await Promise.all(
      subs.slice(offset, offset + 10).map(async (sub) => {
        const p = profiles.get(sub);
        if (
          !p?.handle ||
          !(await assertActive(sub).then(
            () => true,
            () => false,
          )) ||
          !p.consent?.cloudSync ||
          !p.consent.shareWithFriends ||
          meta.startDate > to
        )
          return null;
        const [days, goal] = await Promise.all([
          memberDays(sub, meta.startDate, to),
          meta.metric === 'goal_days' ? minutesGoal(sub) : Promise.resolve(null),
        ]);
        const score = scoreMember(meta.metric, days, goal);
        return score === null ? null : { userId: p.userId, handle: p.handle, score };
      }),
    );
    scored.push(...batch.filter((member) => member !== null));
  }
  const hidden = subs.length - scored.length;
  const higherIsBetter = meta.metric === 'goal_days';
  scored.sort((a, b) => (higherIsBetter ? b.score - a.score : a.score - b.score));
  const entries = [];
  scored.forEach((s, i) => {
    const prev = entries[i - 1];
    const rank = prev && scored[i - 1].score === s.score ? prev.rank : i + 1;
    entries.push({
      rank,
      userId: s.userId,
      handle: s.handle,
      score: s.score,
      scoreSource: 'device',
    });
  });
  return json(200, {
    challengeId: id,
    asOf: to,
    entries,
    hiddenMembers: hidden,
  });
}
