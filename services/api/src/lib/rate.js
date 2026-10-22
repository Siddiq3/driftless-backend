import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, isConditionalFailure, tableName } from './ddb.js';
import { HttpError } from './http.js';
/**
 * Fixed-window per-user rate limit (THREAT_MODEL T8/T12). One atomic conditional increment;
 * counters expire via TTL.
 */
export async function rateLimit(sub, action, limit, windowSec, nowMs = Date.now()) {
  const window = Math.floor(nowMs / 1000 / windowSec);
  try {
    await ddb().send(
      new UpdateCommand({
        TableName: tableName(),
        Key: { pk: `RATE#${sub}#${action}#${window}`, sk: 'RATE' },
        UpdateExpression: 'ADD #c :one SET #t = if_not_exists(#t, :ttl)',
        ConditionExpression: 'attribute_not_exists(#c) OR #c < :limit',
        ExpressionAttributeNames: { '#c': 'count', '#t': 'ttl' },
        ExpressionAttributeValues: { ':one': 1, ':limit': limit, ':ttl': (window + 2) * windowSec },
      }),
    );
  } catch (e) {
    if (isConditionalFailure(e)) {
      throw new HttpError(429, 'rate_limited', 'too many requests, try again later', undefined, {
        'retry-after': String(windowSec),
      });
    }
    throw e;
  }
}
