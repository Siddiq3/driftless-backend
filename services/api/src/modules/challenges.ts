import { randomUUID } from 'node:crypto';
import {
  BatchGetCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { v1 } from '@siddiq3/driftless-contracts';
import { daysBetween, evaluateDay, localDateOf } from '@siddiq3/driftless-contracts/domain';
import type { Caller } from '../lib/auth.js';
import { ddb, isConditionalFailure, Keys, tableName } from '../lib/ddb.js';
import { Errors, json, parseBody, type ApiEvent, type ApiResult } from '../lib/http.js';
import { rateLimit } from '../lib/rate.js';
import { areFriends } from './friends.js';

export const MAX_CHALLENGE_DAYS = 31;
/** Days below this coverage don't count for video scores (T6: plausibility). */
const MIN_COVERAGE = 0.8;

type Meta = v1.ChallengeSummary & { pk: string; sk: 'META'; ttl: number };

const metaKey = (id: string) => ({ pk: `CHAL#${id}`, sk: 'META' as const });
const memberKey = (id: string, sub: string) => ({ pk: `CHAL#${id}`, sk: `MEMBER#${sub}` });

const toSummary = (m: Meta): v1.ChallengeSummary => ({
  challengeId: m.challengeId,
  ownerId: m.ownerId,
  title: m.title,
  metric: m.metric,
  startDate: m.startDate,
  endDate: m.endDate,
  tz: m.tz,
  maxMembers: m.maxMembers,
  memberCount: m.memberCount,
});

function idParam(e: ApiEvent): string {
  const id = e.pathParameters?.id;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) throw Errors.notFound();
  return id.toLowerCase();
}

async function getMeta(id: string): Promise<Meta> {
  const r = await ddb().send(
    new GetCommand({ TableName: tableName(), Key: metaKey(id), ConsistentRead: true }),
  );
  if (!r.Item) throw Errors.notFound();
  return r.Item as Meta;
}

async function isMember(id: string, sub: string): Promise<boolean> {
  const r = await ddb().send(new GetCommand({ TableName: tableName(), Key: memberKey(id, sub) }));
  return Boolean(r.Item);
}

function memberItem(id: string, sub: string, ttl: number) {
  return {
    ...memberKey(id, sub),
    sub,
    joinedAt: new Date().toISOString(),
    gsi1pk: `MEMBEROF#${sub}`,
    gsi1sk: `CHAL#${id}`,
    ttl,
  };
}

export async function postChallenge(event: ApiEvent, caller: Caller): Promise<ApiResult> {
  const c = parseBody(event, v1.ChallengeCreate);
  await rateLimit(caller.sub, 'challenge_create', 5, 86_400);
  const length = daysBetween(c.startDate, c.endDate) + 1;
  if (length > MAX_CHALLENGE_DAYS)
    throw Errors.badRequest(`a challenge can last at most ${MAX_CHALLENGE_DAYS} days`);
  const today = localDateOf(Date.now(), c.tz);
  if (daysBetween(today, c.startDate) < -1) throw Errors.badRequest('start date is in the past');

  const id = randomUUID();
  const ttl = Math.floor(Date.parse(`${c.endDate}T00:00:00Z`) / 1000) + 90 * 86_400;
  const meta: Meta = {
    ...metaKey(id),
    challengeId: id,
    ownerId: caller.sub,
    ...c,
    memberCount: 1,
    ttl,
  };
  await ddb().send(
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
      ],
    }),
  );
  return json(200, toSummary(meta));
}

export async function postJoin(event: ApiEvent, caller: Caller): Promise<ApiResult> {
  const id = idParam(event);
  const meta = await getMeta(id);
  // Friends-only (D-011): you can join only challenges created by a friend.
  if (meta.ownerId !== caller.sub && !(await areFriends(caller.sub, meta.ownerId)))
    throw Errors.notFound();
  if (await isMember(id, caller.sub)) return json(200, toSummary(meta));
  if (localDateOf(Date.now(), meta.tz) > meta.endDate)
    throw Errors.conflict('challenge_over', 'this challenge has ended');
  try {
    await ddb().send(
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
        ],
      }),
    );
  } catch (e) {
    if (isConditionalFailure(e)) throw Errors.conflict('challenge_full', 'this challenge is full');
    throw e;
  }
  return json(200, toSummary({ ...meta, memberCount: meta.memberCount + 1 }));
}

export async function postLeave(event: ApiEvent, caller: Caller): Promise<ApiResult> {
  const id = idParam(event);
  try {
    await ddb().send(
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
        ],
      }),
    );
  } catch (e) {
    if (isConditionalFailure(e)) throw Errors.notFound();
    throw e;
  }
  return json(200, { ok: true });
}

export async function getChallenges(_e: ApiEvent, caller: Caller): Promise<ApiResult> {
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
  const got = await ddb().send(
    new BatchGetCommand({
      RequestItems: { [tableName()]: { Keys: ids.slice(0, 100).map(metaKey) } },
    }),
  );
  const challenges = ((got.Responses?.[tableName()] ?? []) as Meta[])
    .map(toSummary)
    .sort((a, b) => (a.endDate < b.endDate ? 1 : -1));
  return json(200, { challenges });
}

/* ───────────── leaderboard ───────────── */

type DayRow = { localDate: string; minutes: number | null; views: number | null; coverage: number };

async function memberDays(sub: string, from: string, to: string): Promise<DayRow[]> {
  const r = await ddb().send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: 'pk = :pk AND sk BETWEEN :a AND :b',
      ExpressionAttributeValues: {
        ':pk': Keys.user(sub),
        ':a': Keys.dayRangeStart(from),
        ':b': Keys.dayRangeEnd(to),
      },
    }),
  );
  // Combine devices for the same local day (someone with two phones).
  const byDate = new Map<string, DayRow>();
  for (const it of r.Items ?? []) {
    const d = it as DayRow;
    const cur = byDate.get(d.localDate);
    if (!cur) byDate.set(d.localDate, { ...d });
    else
      byDate.set(d.localDate, {
        localDate: d.localDate,
        minutes:
          cur.minutes === null && d.minutes === null ? null : (cur.minutes ?? 0) + (d.minutes ?? 0),
        views: cur.views === null && d.views === null ? null : (cur.views ?? 0) + (d.views ?? 0),
        coverage: Math.min(cur.coverage, d.coverage),
      });
  }
  return [...byDate.values()];
}

async function minutesGoal(sub: string): Promise<number | null> {
  const r = await ddb().send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :g)',
      ExpressionAttributeValues: { ':pk': Keys.user(sub), ':g': 'GOAL#' },
    }),
  );
  const g = (r.Items ?? []).find((x) => x.metric === 'minutes' && x.enabled);
  return g ? (g.dailyLimit as number) : null;
}

/** Score for one member, or null if they have no usable data. Lower is better except goal_days. */
export function scoreMember(
  metric: v1.ChallengeSummary['metric'],
  days: DayRow[],
  goalMinutes: number | null,
): number | null {
  if (metric === 'fewest_minutes') {
    const t = days.filter((d) => d.minutes !== null);
    return t.length
      ? Math.round((t.reduce((n, d) => n + d.minutes!, 0) / t.length) * 10) / 10
      : null;
  }
  if (metric === 'fewest_views') {
    const t = days.filter((d) => d.views !== null && d.coverage >= MIN_COVERAGE);
    return t.length ? Math.round((t.reduce((n, d) => n + d.views!, 0) / t.length) * 10) / 10 : null;
  }
  if (goalMinutes === null) return null;
  return days.filter(
    (d) => evaluateDay(d, { metric: 'minutes', dailyLimit: goalMinutes }) === 'kept',
  ).length;
}

export async function getLeaderboard(event: ApiEvent, caller: Caller): Promise<ApiResult> {
  const id = idParam(event);
  if (!(await isMember(id, caller.sub))) throw Errors.notFound(); // non-members can't see members
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
  const subs = (members.Items ?? []).map((m) => m.sub as string).slice(0, 50);
  const prof = await ddb().send(
    new BatchGetCommand({
      RequestItems: {
        [tableName()]: { Keys: subs.map((s) => ({ pk: Keys.user(s), sk: Keys.profile })) },
      },
    }),
  );
  const profiles = new Map(
    (prof.Responses?.[tableName()] ?? []).map((p) => [String(p.pk).slice('USER#'.length), p]),
  );

  let hidden = 0;
  const scored: Array<{ userId: string; handle: string; score: number }> = [];
  for (const sub of subs) {
    const p = profiles.get(sub);
    // Only members who chose to share with friends are ranked (consent, D-009/T7).
    if (!p?.handle || !p.consent?.shareWithFriends || meta.startDate > to) {
      hidden++;
      continue;
    }
    const score = scoreMember(
      meta.metric,
      await memberDays(sub, meta.startDate, to),
      meta.metric === 'goal_days' ? await minutesGoal(sub) : null,
    );
    if (score === null) {
      hidden++;
      continue;
    }
    scored.push({ userId: sub, handle: p.handle as string, score });
  }
  const higherIsBetter = meta.metric === 'goal_days';
  scored.sort((a, b) => (higherIsBetter ? b.score - a.score : a.score - b.score));
  const entries: v1.LeaderboardResponse['entries'] = [];
  scored.forEach((s, i) => {
    const prev = entries[i - 1];
    const rank = prev && scored[i - 1]!.score === s.score ? prev.rank : i + 1;
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
  } satisfies v1.LeaderboardResponse);
}
