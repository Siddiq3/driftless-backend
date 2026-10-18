import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

let doc: DynamoDBDocumentClient | null = null;

export function ddb(): DynamoDBDocumentClient {
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

export function tableName(): string {
  const t = process.env.TABLE_NAME;
  if (!t) throw new Error('TABLE_NAME is not set');
  return t;
}

/** Key builders — the only place key formats are defined (ARCHITECTURE §6). */
export const Keys = {
  user: (sub: string) => `USER#${sub}`,
  profile: 'PROFILE',
  entitlement: 'ENTITLEMENT',
  handle: (h: string) => ({ pk: `HANDLE#${h.toLowerCase()}`, sk: 'HANDLE' }),
  idem: (sub: string, key: string) => ({ pk: `IDEM#${sub}#${key}`, sk: 'IDEM' }),
} as const;

export function isConditionalFailure(e: unknown): boolean {
  const name = (e as { name?: string })?.name;
  return name === 'ConditionalCheckFailedException' || name === 'TransactionCanceledException';
}
