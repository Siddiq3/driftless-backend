import { activeWrite } from './lifecycle.js';
import { createHash } from 'node:crypto';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { IdempotencyKey } from '@siddiq3/driftless-contracts';
import { ddb, isConditionalFailure, Keys, tableName } from './ddb.js';
import { Errors, header, HttpError } from './http.js';
/** Records live 24 h (ARCHITECTURE §6). */
export const IDEMPOTENCY_TTL_SEC = 24 * 3600;
/** An in-progress lock older than this is considered abandoned (Lambda crashed). */
export const IN_PROGRESS_LEASE_SEC = 60;
export function requestHash(method, path, body) {
  return createHash('sha256').update(`${method}\n${path}\n${body}`).digest('hex');
}
/**
 * Executes `fn` at most once per (caller, Idempotency-Key).
 * - same key + same request → stored response replayed (header `idempotent-replayed: true`)
 * - same key + different request → 422 idempotency_key_reuse
 * - same key while first attempt still running → 409 request_in_progress
 * Only 2xx responses are stored; failed attempts release the key so the client can retry.
 */
export async function withIdempotency(
  event,
  sub,
  body,
  fn,
  nowSec = () => Math.floor(Date.now() / 1000),
) {
  const raw = header(event, 'idempotency-key');
  if (!raw) throw Errors.preconditionRequired('Idempotency-Key header is required');
  if (!IdempotencyKey.safeParse(raw).success)
    throw Errors.badRequest('Idempotency-Key must be a UUID');
  const key = Keys.idem(sub, raw.toLowerCase());
  const hash = requestHash(event.requestContext.http.method, event.rawPath, body);
  const now = nowSec();
  try {
    await activeWrite(
      sub,
      new PutCommand({
        TableName: tableName(),
        Item: {
          ...key,
          status: 'in_progress',
          hash,
          startedAt: now,
          ttl: now + IDEMPOTENCY_TTL_SEC,
        },
        ConditionExpression:
          'attribute_not_exists(pk) OR (#s = :ip AND startedAt < :stale AND #h = :h)',
        ExpressionAttributeNames: { '#s': 'status', '#h': 'hash' },
        ExpressionAttributeValues: {
          ':ip': 'in_progress',
          ':stale': now - IN_PROGRESS_LEASE_SEC,
          ':h': hash,
        },
      }),
    );
  } catch (e) {
    if (!isConditionalFailure(e)) throw e;
    const existing = (
      await ddb().send(new GetCommand({ TableName: tableName(), Key: key, ConsistentRead: true }))
    ).Item;
    if (!existing) throw Errors.conflict('request_in_progress', 'retry shortly');
    if (existing.hash !== hash) {
      throw new HttpError(
        422,
        'idempotency_key_reuse',
        'Idempotency-Key was used for a different request',
      );
    }
    if (existing.status === 'done' && existing.response) {
      return {
        ...existing.response,
        headers: { ...(existing.response.headers ?? {}), 'idempotent-replayed': 'true' },
      };
    }
    throw Errors.conflict('request_in_progress', 'the original request is still being processed');
  }
  let result;
  try {
    result = await fn();
  } catch (e) {
    await release(sub, key);
    throw e;
  }
  const status = result.statusCode ?? 200;
  if (status >= 200 && status < 300) {
    await activeWrite(
      sub,
      new UpdateCommand({
        TableName: tableName(),
        Key: key,
        UpdateExpression: 'SET #s = :done, #r = :r',
        ExpressionAttributeNames: { '#s': 'status', '#r': 'response' },
        ExpressionAttributeValues: { ':done': 'done', ':r': result },
      }),
    );
  } else {
    await release(sub, key);
  }
  return result;
}
async function release(sub, key) {
  // Mark as stale so the same request can be retried immediately.
  await activeWrite(
    sub,
    new UpdateCommand({
      TableName: tableName(),
      Key: key,
      UpdateExpression: 'SET startedAt = :zero',
      ConditionExpression: '#s = :ip',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':zero': 0, ':ip': 'in_progress' },
    }),
  ).catch(() => undefined);
}
