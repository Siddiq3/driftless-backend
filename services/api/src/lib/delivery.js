import { randomUUID } from 'node:crypto';
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, isConditionalFailure, tableName } from './ddb.js';
import { HttpError, json } from './http.js';
import { log } from './log.js';

// Longer than the API Lambda's 10-second deadline. A killed invocation can be retried.
const LEASE_SECONDS = 60;
const MEMORY_SECONDS = 7 * 86_400;
const busy = () => new HttpError(503, 'delivery_in_progress', 'Delivery is still processing');

/** At-least-once processing: only successful work is acknowledged as a duplicate.
 * The owner fences completion/release after an abandoned lease has been acquired again.
 * Business writes must remain safe to retry after a crash between work and completion. */
export async function withDelivery(id, processDelivery) {
  const key = { pk: `PUBSUB#${id}`, sk: 'PUBSUB' };
  const now = Math.floor(Date.now() / 1000);
  const owner = randomUUID();
  try {
    await ddb().send(new PutCommand({
      TableName: tableName(),
      Item: { ...key, status: 'processing', owner, leaseUntil: now + LEASE_SECONDS, ttl: now + MEMORY_SECONDS },
      ConditionExpression: 'attribute_not_exists(pk) OR (#s = :processing AND leaseUntil <= :now) OR #ttl <= :now',
      ExpressionAttributeNames: { '#s': 'status', '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':processing': 'processing', ':now': now },
    }));
  } catch (e) {
    if (!isConditionalFailure(e)) throw e;
    const existing = (await ddb().send(new GetCommand({
      TableName: tableName(), Key: key, ConsistentRead: true,
    }))).Item;
    // Statusless records were completed receipt markers written by the old version.
    if (existing && existing.ttl > now && (existing.status === 'done' || !existing.status))
      return json(200, { duplicate: true });
    throw busy(); // A competing delivery is not evidence of successful processing.
  }
  try {
    const response = await processDelivery();
    if ((response.statusCode ?? 200) < 200 || (response.statusCode ?? 200) >= 300)
      throw new Error('Delivery did not complete');
    await ddb().send(new UpdateCommand({
      TableName: tableName(), Key: key,
      UpdateExpression: 'SET #s = :done REMOVE leaseUntil',
      ConditionExpression: '#owner = :owner AND #s = :processing',
      ExpressionAttributeNames: { '#s': 'status', '#owner': 'owner' },
      ExpressionAttributeValues: { ':done': 'done', ':processing': 'processing', ':owner': owner },
    }));
    return response;
  } catch (error) {
    try {
      await ddb().send(new DeleteCommand({
        TableName: tableName(), Key: key,
        ConditionExpression: '#owner = :owner AND #s = :processing',
        ExpressionAttributeNames: { '#s': 'status', '#owner': 'owner' },
        ExpressionAttributeValues: { ':owner': owner, ':processing': 'processing' },
      }));
    } catch (releaseError) {
      if (!isConditionalFailure(releaseError)) log.error('billing.delivery_release_failed');
      // Preserve the processing error; a failed release remains recoverable after the lease.
    }
    throw error;
  }
}
