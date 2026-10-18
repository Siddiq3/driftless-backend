import { createHash } from 'node:crypto';
import { DeleteCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { v1 } from '@siddiq3/driftless-contracts';
import type { Caller } from '../lib/auth.js';
import { ddb, isConditionalFailure, Keys, tableName } from '../lib/ddb.js';
import { Errors, json, parseBody, type ApiEvent, type ApiResult } from '../lib/http.js';
import { rateLimit } from '../lib/rate.js';

export const MAX_DEVICES = 10;
const IDLE_TTL_SEC = 180 * 86_400; // PRIVACY_AND_DATA_RETENTION §1

const deviceKey = (sub: string, id: string) => ({ pk: Keys.user(sub), sk: `DEVICE#${id}` });

/**
 * Registers a push token for this user's device. The token is stored for delivery and also as a
 * hash so a token can be found (and removed) if it shows up under another account (T8).
 */
export async function postDevice(event: ApiEvent, caller: Caller): Promise<ApiResult> {
  const d = parseBody(event, v1.DeviceRegister);
  await rateLimit(caller.sub, 'device_register', 20, 3600);
  const existing = await ddb().send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :d)',
      ExpressionAttributeValues: { ':pk': Keys.user(caller.sub), ':d': 'DEVICE#' },
      ProjectionExpression: 'sk',
    }),
  );
  const ids = (existing.Items ?? []).map((i) => String(i.sk).slice('DEVICE#'.length));
  if (!ids.includes(d.deviceId) && ids.length >= MAX_DEVICES)
    throw Errors.conflict('too_many_devices', `limit is ${MAX_DEVICES}`);
  const now = Math.floor(Date.now() / 1000);
  await ddb().send(
    new PutCommand({
      TableName: tableName(),
      Item: {
        ...deviceKey(caller.sub, d.deviceId),
        platform: d.platform,
        pushToken: d.pushToken,
        pushTokenHash: createHash('sha256').update(d.pushToken).digest('hex'),
        lastSeen: new Date(now * 1000).toISOString(),
        ttl: now + IDLE_TTL_SEC,
      },
    }),
  );
  return json(200, { ok: true });
}

export async function deleteDevice(event: ApiEvent, caller: Caller): Promise<ApiResult> {
  const id = event.pathParameters?.id ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw Errors.notFound();
  try {
    await ddb().send(
      new DeleteCommand({
        TableName: tableName(),
        Key: deviceKey(caller.sub, id),
        ConditionExpression: 'attribute_exists(pk)',
      }),
    );
  } catch (e) {
    if (isConditionalFailure(e)) throw Errors.notFound();
    throw e;
  }
  return json(200, { ok: true });
}
