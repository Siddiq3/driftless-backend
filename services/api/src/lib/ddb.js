import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
let doc = null;
export function ddb() {
  if (!doc) {
    const endpoint = process.env.DDB_ENDPOINT;
    const client = new DynamoDBClient(
      endpoint
        ? {
            endpoint,
            region: process.env.AWS_REGION ?? 'local',
            credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
          }
        : {},
    );
    doc = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  return doc;
}
export function tableName() {
  const t = process.env.TABLE_NAME;
  if (!t) throw new Error('TABLE_NAME is not set');
  return t;
}
/** Key builders — the only place key formats are defined (ARCHITECTURE §6). */
export const Keys = {
  user: (sub) => `USER#${sub}`,
  profile: 'PROFILE',
  entitlement: 'ENTITLEMENT',
  handle: (h) => ({ pk: `HANDLE#${h.toLowerCase()}`, sk: 'HANDLE' }),
  idem: (sub, key) => ({ pk: `IDEM#${sub}#${key}`, sk: 'IDEM' }),
  /** One aggregate per device per local day (ARCHITECTURE §6, refined: per device, not per platform). */
  day: (localDate, deviceId) => `DAY#${localDate}#${deviceId}`,
  goal: (goalId) => `GOAL#${goalId}`,
  dayRangeStart: (from) => `DAY#${from}#`,
  dayRangeEnd: (to) => `DAY#${to}#~`,
};
export function isConditionalFailure(e) {
  const name = e?.name;
  return name === 'ConditionalCheckFailedException' || name === 'TransactionCanceledException';
}
