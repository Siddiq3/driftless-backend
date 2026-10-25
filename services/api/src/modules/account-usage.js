import { createHash } from 'node:crypto';
import { QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import {
  AccountUsageConfigure,
  AccountUsageReconcile,
  AccountUsageReserve,
  AccountUsageHistoryQuery,
} from '@siddiq3/driftless-contracts';
import { accountPeriod, accountPeriodForDate, addDays } from '@siddiq3/driftless-contracts/domain';
import { activeWrite, readState } from '../lib/lifecycle.js';
import { ddb, Keys, tableName } from '../lib/ddb.js';
import { rateLimit } from '../lib/rate.js';
import { withIdempotency } from '../lib/idempotency.js';
import { Errors, json, parseBody, rawBody, validate } from '../lib/http.js';

const key = (sub, sk) => ({ pk: Keys.user(sub), sk });
const policyKey = (sub) => key(sub, 'ACCOUNTUSAGE#POLICY');
const dayKey = (sub, date) => key(sub, `ACCOUNTUSAGE#DAY#${date}`);
const planKey = (sub, date) => key(sub, `ACCOUNTUSAGE#PLAN#${date}`);
const hash = (body) => createHash('sha256').update(JSON.stringify(body)).digest('hex');
const put = (Item, previous) => ({
  Put: {
    TableName: tableName(),
    Item,
    ConditionExpression: previous ? 'rev = :rev' : 'attribute_not_exists(pk)',
    ...(previous ? { ExpressionAttributeValues: { ':rev': previous.rev } } : {}),
  },
});
const conflict = () =>
  Errors.conflict('account_usage_conflict', 'Account usage changed; retry the same operation');
const raced = (e) =>
  e.name === 'TransactionCanceledException' &&
  e.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed';
async function plan(sub, date) {
  const response = await ddb().send(
    new QueryCommand({
      TableName: tableName(),
      ConsistentRead: true,
      KeyConditionExpression: 'pk = :pk AND sk BETWEEN :a AND :b',
      ExpressionAttributeValues: {
        ':pk': Keys.user(sub),
        ':a': 'ACCOUNTUSAGE#PLAN#',
        ':b': `ACCOUNTUSAGE#PLAN#${date}`,
      },
      ScanIndexForward: false,
      Limit: 1,
    }),
  );
  return response.Items?.[0];
}
async function context(sub) {
  const policy = await readState(policyKey(sub));
  if (!policy)
    throw Errors.conflict(
      'account_usage_setup_required',
      'Confirm your fixed account timezone first',
    );
  const current = accountPeriod(Date.now(), policy.tz, sub);
  const tomorrow = accountPeriod(current.endMs, policy.tz, sub);
  const active = await plan(sub, current.localDate);
  const pending = await readState(planKey(sub, tomorrow.localDate));
  return { policy, current, active, pending };
}
function publicPolicy(c) {
  return {
    incarnation: c.policy.incarnation,
    tz: c.policy.tz,
    activeFromMs: c.policy.activeFromMs,
    rev: c.policy.rev,
    policies: [c.active, c.pending]
      .filter(Boolean)
      .map((p) => ({ effectiveDate: p.effectiveDate, limits: p.limits })),
  };
}
/** Device cumulative high-water marks. Retrying/reordering never adds a whole snapshot twice.
 * A downward OS revision cannot refund already consumed allowance. Unknown remains unavailable. */
function amounts(apps) {
  const used = {},
    unknown = [];
  for (const [name, field] of [
    ['views', 'views'],
    ['minutes', 'usageMs'],
  ]) {
    const entries = Object.entries(apps);
    for (const [pkg, value] of entries) {
      if (value[field] === null) unknown.push(`${name}:${pkg}`);
      else used[`${name}:${pkg}`] = value[field];
    }
    if (!entries.length || entries.some(([, a]) => a[field] === null)) unknown.push(name);
    else used[name] = entries.reduce((sum, [, a]) => sum + a[field], 0);
  }
  return { used, unknown };
}
function snapshot(period, limits, previous) {
  const devices = previous?.devices ?? {};
  const used = {},
    allocated = {},
    unavailable = new Set();
  for (const device of Object.values(devices)) {
    const measured = amounts(device.apps);
    for (const k of Object.keys(limits)) if (measured.used[k] === undefined) unavailable.add(k);
    for (const k of amounts(device.apps).unknown) unavailable.add(k);
    for (const [k, value] of Object.entries(device.used)) used[k] = (used[k] ?? 0) + value;
    for (const k of new Set([...Object.keys(device.used), ...Object.keys(device.granted)]))
      allocated[k] = (allocated[k] ?? 0) + Math.max(device.used[k] ?? 0, device.granted[k] ?? 0);
  }
  if (!Object.keys(devices).length) {
    unavailable.add('views');
    unavailable.add('minutes');
  }
  return {
    incarnation: period.periodId.split(':')[0],
    ...period,
    rev: previous?.rev ?? 0,
    limits,
    used,
    allocated,
    devices,
    unavailable: [...unavailable],
    serverTimeMs: Date.now(),
  };
}
async function sealDay(sub, date) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const existing = await readState(dayKey(sub, date));
    if (existing) return existing;
    const selected = await plan(sub, date);
    if (!selected) return null;
    const policy = await readState(policyKey(sub));
    if (!policy) throw conflict();
    const period = accountPeriodForDate(date, policy.tz, sub);
    const fresh = {
      ...dayKey(sub, date),
      rev: 1,
      devices: {},
      limits: selected.limits,
      ttl: Math.floor(period.endMs / 1000) + 400 * 86400,
    };
    try {
      await activeWrite(
        sub,
        new TransactWriteCommand({
          TransactItems: [
            put(fresh, null),
            {
              ConditionCheck: {
                TableName: tableName(),
                Key: { pk: selected.pk, sk: selected.sk },
                ConditionExpression: 'rev = :rev',
                ExpressionAttributeValues: { ':rev': selected.rev },
              },
            },
          ],
        }),
      );
      return fresh;
    } catch (error) {
      if (error.name !== 'TransactionCanceledException') throw error;
    }
  }
  throw conflict();
}
export async function getAccountUsage(_event, caller) {
  const policy = await readState(policyKey(caller.sub));
  if (!policy) return json(200, { policy: null, snapshot: null, serverTimeMs: Date.now() });
  const c = await context(caller.sub);
  const sealed = c.active ? await sealDay(caller.sub, c.current.localDate) : null;
  return json(200, {
    serverTimeMs: Date.now(),
    policy: publicPolicy(c),
    snapshot:
      c.active && Date.now() >= policy.activeFromMs
        ? snapshot(c.current, sealed.limits, sealed)
        : null,
  });
}
export async function configureAccountUsage(event, caller) {
  const body = parseBody(event, AccountUsageConfigure);
  await rateLimit(caller.sub, 'account_policy', 30, 3600);
  const previous = await readState(policyKey(caller.sub));
  if ((previous?.rev ?? 0) !== body.expectedRev) throw conflict();
  if (previous && previous.tz !== body.tz)
    throw Errors.conflict('account_timezone_fixed', 'Account timezone changes are not supported');
  const current = accountPeriod(Date.now(), body.tz, caller.sub);
  const next = accountPeriod(current.endMs, body.tz, caller.sub);
  const policy = {
    ...policyKey(caller.sub),
    incarnation: caller.sub,
    tz: body.tz,
    activeFromMs: previous?.activeFromMs ?? next.startMs,
    rev: (previous?.rev ?? 0) + 1,
  };
  const profile = await readState({ pk: Keys.user(caller.sub), sk: Keys.profile });
  if (!profile) throw conflict();
  try {
    await activeWrite(
      caller.sub,
      new TransactWriteCommand({
        TransactItems: [
          put(policy, previous),
          {
            Put: {
              TableName: tableName(),
              Item: {
                ...planKey(caller.sub, next.localDate),
                effectiveDate: next.localDate,
                limits: body.limits,
                rev: policy.rev,
              },
            },
          },
          {
            ConditionCheck: {
              TableName: tableName(),
              Key: dayKey(caller.sub, next.localDate),
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
          {
            Update: {
              TableName: tableName(),
              Key: { pk: Keys.user(caller.sub), sk: Keys.profile },
              UpdateExpression: 'SET tz = :tz, rev = rev + :one',
              ConditionExpression: 'rev = :rev',
              ExpressionAttributeValues: { ':tz': body.tz, ':one': 1, ':rev': profile.rev },
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (
      error.name === 'TransactionCanceledException' &&
      error.CancellationReasons?.some((r) => r.Code === 'ConditionalCheckFailed')
    )
      throw conflict();
    throw error;
  }
  return getAccountUsage(event, caller);
}
function validContribution(c, request, sub) {
  if (request.incarnation !== sub || request.periodId !== `${sub}:${request.localDate}`)
    throw Errors.conflict(
      'account_period_mismatch',
      'Contribution retains its original incarnation and period',
    );
  const date = request.localDate;
  if (date > c.current.localDate || date < addDays(c.current.localDate, -399))
    throw Errors.badRequest('Contribution date is outside retained periods');
}
export async function reconcileAccountUsage(event, caller) {
  parseBody(event, AccountUsageReconcile);
  return withIdempotency(event, caller.sub, rawBody(event), () => reconcile(event, caller));
}
async function reconcile(event, caller) {
  const { contributions } = parseBody(event, AccountUsageReconcile);
  await rateLimit(caller.sub, 'account_reconcile', 240, 3600);
  const c = await context(caller.sub);
  const results = [];
  for (const request of contributions) {
    validContribution(c, request, caller.sub);
    const selectedPlan = await plan(caller.sub, request.localDate);
    if (!selectedPlan)
      throw Errors.conflict(
        'account_period_not_active',
        'Historical totals cannot be migrated into account accounting',
      );
    await sealDay(caller.sub, request.localDate);
    const receiptHash = hash(request);
    let applied = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      const previous = await readState(dayKey(caller.sub, request.localDate));
      const device = previous?.devices?.[request.deviceId];
      if (device && request.rev <= device.rev) {
        if (request.rev === device.rev && receiptHash !== device.hash)
          throw Errors.conflict('usage_revision_reused', 'A frozen revision cannot change payload');
        results.push({
          deviceId: request.deviceId,
          periodId: request.periodId,
          rev: device.rev,
          status: request.rev === device.rev ? 'unchanged' : 'stale',
        });
        applied = true;
        break;
      }
      if (device && request.resetGeneration < device.resetGeneration)
        throw Errors.conflict(
          'reset_generation_stale',
          'An earlier reset generation cannot change accounting',
        );
      const merged = JSON.parse(JSON.stringify(device?.apps ?? {}));
      for (const [pkg, row] of Object.entries(request.apps)) {
        const old = merged[pkg];
        merged[pkg] = Object.fromEntries(
          ['views', 'usageMs'].map((field) => [
            field,
            row[field] === null ? null : Math.max(row[field], old?.[field] ?? 0),
          ]),
        );
      }
      const values = amounts(merged).used;
      const used = { ...device?.used };
      for (const [k, v] of Object.entries(values)) used[k] = Math.max(used[k] ?? 0, v);
      const devices = {
        ...previous?.devices,
        [request.deviceId]: {
          rev: request.rev,
          resetGeneration: request.resetGeneration,
          apps: merged,
          used,
          granted: device?.granted ?? {},
          hash: receiptHash,
        },
      };
      if (Object.keys(devices).length > 10)
        throw Errors.conflict('too_many_devices', 'At most ten accounting devices per period');
      const item = {
        ...dayKey(caller.sub, request.localDate),
        rev: (previous?.rev ?? 0) + 1,
        devices,
        limits: previous?.limits ?? selectedPlan.limits,
        ttl: previous.ttl,
      };
      try {
        await activeWrite(
          caller.sub,
          new TransactWriteCommand({
            TransactItems: [
              put(item, previous),
              {
                ConditionCheck: {
                  TableName: tableName(),
                  Key: { pk: Keys.user(caller.sub), sk: `DEVICE#${request.deviceId}` },
                  ConditionExpression: 'attribute_exists(pk)',
                },
              },
            ],
          }),
        );
        results.push({
          deviceId: request.deviceId,
          periodId: request.periodId,
          rev: request.rev,
          status: 'applied',
        });
        applied = true;
        break;
      } catch (error) {
        if (error.CancellationReasons?.[1]?.Code === 'ConditionalCheckFailed')
          throw Errors.conflict(
            'device_not_registered',
            'Register this accounting device before synchronization',
          );
        if (!raced(error)) throw error;
      }
    }
    if (!applied) throw conflict();
  }
  const current = await getAccountUsage(event, caller);
  return json(200, { ...JSON.parse(current.body), results });
}
export async function reserveAccountUsage(event, caller) {
  const request = parseBody(event, AccountUsageReserve);
  await rateLimit(caller.sub, 'account_reserve', 240, 3600);
  const c = await context(caller.sub);
  if (
    request.incarnation !== caller.sub ||
    request.periodId !== c.current.periodId ||
    !c.active ||
    Date.now() < c.policy.activeFromMs
  )
    throw Errors.conflict(
      'account_period_mismatch',
      'New reservations require the active account period',
    );
  await sealDay(caller.sub, c.current.localDate);
  const receiptKey = key(caller.sub, `ACCOUNTUSAGE#GRANT#${request.operationId}`);
  const receiptHash = hash(request);
  for (let attempt = 0; attempt < 6; attempt++) {
    const receipt = await readState(receiptKey);
    if (receipt) {
      if (receipt.hash !== receiptHash)
        throw Errors.conflict(
          'reservation_key_reused',
          'Reservation operation ID belongs to a different payload',
        );
      return json(200, receipt.response);
    }
    const previous = await readState(dayKey(caller.sub, c.current.localDate));
    const limits = previous?.limits ?? c.active.limits;
    const device = previous?.devices?.[request.deviceId] ?? {
      rev: 0,
      resetGeneration: 0,
      apps: {},
      used: {},
      granted: {},
    };
    const before = snapshot(c.current, limits, previous);
    const granted = { ...device.granted };
    for (const [k, count] of Object.entries(request.requested)) {
      if (!(k in limits)) throw Errors.badRequest('Reservation metric has no active limit');
      granted[k] =
        (granted[k] ?? 0) + Math.min(count, Math.max(0, limits[k] - (before.allocated[k] ?? 0)));
    }
    const devices = { ...previous?.devices, [request.deviceId]: { ...device, granted } };
    if (Object.keys(devices).length > 10)
      throw Errors.conflict('too_many_devices', 'At most ten accounting devices per period');
    const item = {
      ...dayKey(caller.sub, c.current.localDate),
      limits,
      devices,
      rev: (previous?.rev ?? 0) + 1,
      ttl: previous.ttl,
    };
    const response = {
      serverTimeMs: Date.now(),
      policy: publicPolicy(c),
      snapshot: snapshot(c.current, limits, item),
    };
    try {
      await activeWrite(
        caller.sub,
        new TransactWriteCommand({
          TransactItems: [
            put(item, previous),
            {
              Put: {
                TableName: tableName(),
                Item: { ...receiptKey, hash: receiptHash, response, ttl: previous.ttl },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
            {
              ConditionCheck: {
                TableName: tableName(),
                Key: { pk: Keys.user(caller.sub), sk: `DEVICE#${request.deviceId}` },
                ConditionExpression: 'attribute_exists(pk)',
              },
            },
          ],
        }),
      );
      return json(200, response);
    } catch (error) {
      if (error.CancellationReasons?.[2]?.Code === 'ConditionalCheckFailed')
        throw Errors.conflict(
          'device_not_registered',
          'Register this accounting device before requesting credit',
        );
      if (!raced(error) && error.CancellationReasons?.[1]?.Code !== 'ConditionalCheckFailed')
        throw error;
    }
  }
  throw conflict();
}

/** Bounded account summaries; paginate DynamoDB internally and retain only the requesting
 * device's accepted baseline. Global totals still include every accounting device. */
export async function getAccountUsageHistory(event, caller) {
  const query = validate(AccountUsageHistoryQuery, event.queryStringParameters ?? {});
  const c = await context(caller.sub);
  if (query.to > c.current.localDate || query.from < addDays(c.current.localDate, -399))
    throw Errors.badRequest('History range is outside retained periods');
  const days = [];
  let cursor;
  do {
    const page = await ddb().send(
      new QueryCommand({
        TableName: tableName(),
        ConsistentRead: true,
        KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
        ExpressionAttributeValues: {
          ':pk': Keys.user(caller.sub),
          ':from': `ACCOUNTUSAGE#DAY#${query.from}`,
          ':to': `ACCOUNTUSAGE#DAY#${query.to}`,
        },
        ExclusiveStartKey: cursor,
        Limit: 100,
      }),
    );
    for (const row of page.Items ?? []) {
      const date = row.sk.slice('ACCOUNTUSAGE#DAY#'.length);
      const result = snapshot(accountPeriodForDate(date, c.policy.tz, caller.sub), row.limits, row);
      result.devices = result.devices[query.deviceId]
        ? { [query.deviceId]: result.devices[query.deviceId] }
        : {};
      days.push(result);
    }
    cursor = page.LastEvaluatedKey;
  } while (cursor && days.length < 400);
  return json(200, { days, serverTimeMs: Date.now() });
}
