import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, tableName } from '../lib/ddb.js';
import { json } from '../lib/http.js';
/** Public readiness probe. Reads a reserved, non-user key; never creates or exports data. */
export async function getHealth() {
  try {
    await ddb().send(
      new GetCommand({
        TableName: tableName(),
        Key: { pk: 'SYSTEM#HEALTH', sk: 'CHECK' },
        ProjectionExpression: 'pk',
      }),
    );
    return json(200, { ok: true });
  } catch {
    return json(503, { ok: false });
  }
}
