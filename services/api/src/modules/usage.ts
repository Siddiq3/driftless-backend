import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { v1 } from '@siddiq3/driftless-contracts';
import { daysBetween } from '@siddiq3/driftless-contracts/domain';
import type { Caller } from '../lib/auth.js';
import { ddb, isConditionalFailure, Keys, tableName } from '../lib/ddb.js';
import {
  Errors,
  HttpError,
  json,
  parseBody,
  rawBody,
  validate,
  type ApiEvent,
  type ApiResult,
} from '../lib/http.js';
import { withIdempotency } from '../lib/idempotency.js';
import { loadOrCreateProfile } from './me.js';

/** Aggregates expire 400 days after their local date (PRIVACY_AND_DATA_RETENTION §1). */
export const AGGREGATE_RETENTION_DAYS = 400;
export const MAX_HISTORY_DAYS = 400;
/** Clients may not report days in the future beyond the widest time-zone offset (+14 h). */
const MAX_FUTURE_MS = 14 * 3600_000;

type DayItem = v1.DailyAggregate & { pk: string; sk: string; ttl: number; receivedAt: string };

function ttlFor(localDate: string): number {
  return (
    Math.floor(Date.parse(`${localDate}T00:00:00Z`) / 1000) + AGGREGATE_RETENTION_DAYS * 86_400
  );
}

function assertNotFuture(localDate: string, nowMs: number): void {
  if (Date.parse(`${localDate}T00:00:00Z`) > nowMs + MAX_FUTURE_MS) {
    throw Errors.badRequest('localDate is in the future', [
      { path: 'days.localDate', message: localDate },
    ]);
  }
}

/**
 * Applies one device-day aggregate. Monotonic `rev`: a write only wins if its rev is higher than
 * what is stored, so retries, reordering and duplicates converge to the latest client state.
 */
async function applyDay(
  sub: string,
  d: v1.DailyAggregate,
  now: string,
): Promise<v1.UsageSyncResponse['results'][number]> {
  const key = { pk: Keys.user(sub), sk: Keys.day(d.localDate, d.deviceId) };
  const item: DayItem = { ...key, ...d, ttl: ttlFor(d.localDate), receivedAt: now };
  try {
    await ddb().send(
      new PutCommand({
        TableName: tableName(),
        Item: item,
        ConditionExpression: 'attribute_not_exists(pk) OR rev < :rev',
        ExpressionAttributeValues: { ':rev': d.rev },
      }),
    );
    return { localDate: d.localDate, deviceId: d.deviceId, status: 'applied', serverRev: d.rev };
  } catch (e) {
    if (!isConditionalFailure(e)) throw e;
    const cur = (
      await ddb().send(new GetCommand({ TableName: tableName(), Key: key, ConsistentRead: true }))
    ).Item as DayItem | undefined;
    const serverRev = cur?.rev ?? d.rev;
    return {
      localDate: d.localDate,
      deviceId: d.deviceId,
      status: serverRev === d.rev ? 'unchanged' : 'stale',
      serverRev,
    };
  }
}

export async function postUsageSync(event: ApiEvent, caller: Caller): Promise<ApiResult> {
  // Validate before taking the idempotency lock so malformed requests never hold a key.
  const req = parseBody(event, v1.UsageSyncRequest);
  const body = rawBody(event);
  return withIdempotency(event, caller.sub, body, async () => {
    const profile = await loadOrCreateProfile(caller.sub);
    if (!profile.consent.cloudSync) {
      throw new HttpError(403, 'consent_required', 'cloud sync is off for this account');
    }
    const nowMs = Date.now();
    for (const d of req.days) assertNotFuture(d.localDate, nowMs);
    const now = new Date(nowMs).toISOString();
    const results = [];
    for (const d of req.days) results.push(await applyDay(caller.sub, d, now));
    return json(200, { results } satisfies v1.UsageSyncResponse);
  });
}

export async function getUsageHistory(event: ApiEvent, caller: Caller): Promise<ApiResult> {
  const q = event.queryStringParameters ?? {};
  const { from, to } = validate(v1.HistoryQuery, { from: q.from, to: q.to });
  const span = daysBetween(from, to);
  if (span < 0) throw Errors.badRequest('from must not be after to');
  if (span + 1 > MAX_HISTORY_DAYS)
    throw Errors.badRequest(`range exceeds ${MAX_HISTORY_DAYS} days`);

  const days: v1.DailyAggregate[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await ddb().send(
      new QueryCommand({
        TableName: tableName(),
        KeyConditionExpression: 'pk = :pk AND sk BETWEEN :a AND :b',
        ExpressionAttributeValues: {
          ':pk': Keys.user(caller.sub),
          ':a': Keys.dayRangeStart(from),
          ':b': Keys.dayRangeEnd(to),
        },
        ExclusiveStartKey: start,
      }),
    );
    for (const it of page.Items ?? []) {
      const { localDate, tz, platform, deviceId, views, adViews, minutes, coverage, rev } =
        it as DayItem;
      days.push({ localDate, tz, platform, deviceId, views, adViews, minutes, coverage, rev });
    }
    start = page.LastEvaluatedKey;
  } while (start);
  return json(200, { days } satisfies { days: v1.DailyAggregate[] });
}
