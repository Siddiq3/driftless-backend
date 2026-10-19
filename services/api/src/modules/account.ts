import {
  BatchWriteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { v1 } from '@siddiq3/driftless-contracts';
import { requireRecentAuth, type Caller } from '../lib/auth.js';
import { ddb, isConditionalFailure, Keys, tableName } from '../lib/ddb.js';
import { json, type ApiEvent, type ApiResult } from '../lib/http.js';
import { log } from '../lib/log.js';
import { deleteAllFriendships } from './friends.js';

// Google owns the sign-in identity. Deletion removes Driftless data, not the Google account.
// The app revokes its Google grant and signs out after the API confirms deletion.

const jobKey = (sub: string) => ({ pk: `DELETE#${sub}`, sk: 'JOB' });

type Item = Record<string, unknown> & { pk: string; sk: string };

async function queryAll(params: ConstructorParameters<typeof QueryCommand>[0]): Promise<Item[]> {
  const out: Item[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const r = await ddb().send(new QueryCommand({ ...params, ExclusiveStartKey: start }));
    out.push(...((r.Items ?? []) as Item[]));
    start = r.LastEvaluatedKey;
  } while (start);
  return out;
}

async function batchDelete(keys: Array<{ pk: string; sk: string }>): Promise<void> {
  for (let i = 0; i < keys.length; i += 25) {
    let req:
      | Record<string, Array<{ DeleteRequest: { Key: { pk: string; sk: string } } }>>
      | undefined = {
      [tableName()]: keys
        .slice(i, i + 25)
        .map((k) => ({ DeleteRequest: { Key: { pk: k.pk, sk: k.sk } } })),
    };
    for (let attempt = 0; req && Object.keys(req).length && attempt < 5; attempt++) {
      const r = await ddb().send(new BatchWriteCommand({ RequestItems: req }));
      req = r.UnprocessedItems as typeof req;
    }
  }
}

/**
 * Deletes everything tied to `sub` (THREAT_MODEL T9). Idempotent: safe to re-run if interrupted.
 * Backups (PITR) still hold deleted items for up to 35 days, as disclosed in the privacy policy.
 */
export async function deleteAccountData(sub: string): Promise<void> {
  const own = await queryAll({
    TableName: tableName(),
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: { ':pk': Keys.user(sub) },
  });

  // 1. Release the handle so the name can be reused.
  const profile = own.find((i) => i.sk === Keys.profile);
  if (profile?.handle) {
    await ddb()
      .send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Delete: {
                TableName: tableName(),
                Key: Keys.handle(String(profile.handle)),
                ConditionExpression: '#s = :s',
                ExpressionAttributeNames: { '#s': 'sub' },
                ExpressionAttributeValues: { ':s': sub },
              },
            },
          ],
        }),
      )
      .catch((e) => {
        if (!isConditionalFailure(e)) throw e;
      });
  }

  // 2. Friendships on both sides.
  await deleteAllFriendships(sub);

  // 3. Challenge memberships (and keep member counts right).
  const memberships = await queryAll({
    TableName: tableName(),
    IndexName: 'gsi1',
    KeyConditionExpression: 'gsi1pk = :p',
    ExpressionAttributeValues: { ':p': `MEMBEROF#${sub}` },
  });
  for (const m of memberships) {
    const chal = String(m.pk);
    await ddb()
      .send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Delete: {
                TableName: tableName(),
                Key: { pk: chal, sk: `MEMBER#${sub}` },
                ConditionExpression: 'attribute_exists(pk)',
              },
            },
            {
              Update: {
                TableName: tableName(),
                Key: { pk: chal, sk: 'META' },
                UpdateExpression: 'SET memberCount = memberCount - :one',
                ConditionExpression: 'memberCount > :zero',
                ExpressionAttributeValues: { ':one': 1, ':zero': 0 },
              },
            },
          ],
        }),
      )
      .catch((e) => {
        if (!isConditionalFailure(e)) throw e;
      });
  }

  // 4. Store purchases: unlink from the user (records needed for refunds keep no user id).
  const ent = own.find((i) => i.sk === Keys.entitlement);
  if (ent?.tokenHash) {
    await ddb()
      .send(
        new UpdateCommand({
          TableName: tableName(),
          Key: { pk: `PURCHASE#play#${String(ent.tokenHash)}`, sk: 'PURCHASE' },
          UpdateExpression: 'SET #s = :d REMOVE gsi1pk, gsi1sk',
          ConditionExpression: 'attribute_exists(pk)',
          ExpressionAttributeNames: { '#s': 'sub' },
          ExpressionAttributeValues: { ':d': 'deleted' },
        }),
      )
      .catch((e) => {
        if (!isConditionalFailure(e)) throw e;
      });
  }

  // 5. Everything under USER#sub: profile, goals, days, devices, friends (already), entitlement.
  await batchDelete(own.map((i) => ({ pk: i.pk, sk: i.sk })));
}

export async function postDeleteAccount(_e: ApiEvent, caller: Caller): Promise<ApiResult> {
  requireRecentAuth(caller, Math.floor(Date.now() / 1000));
  const requestedAt = new Date().toISOString();
  await ddb().send(
    new PutCommand({
      TableName: tableName(),
      Item: {
        ...jobKey(caller.sub),
        state: 'in_progress',
        requestedAt,
        ttl: Math.floor(Date.now() / 1000) + 30 * 86_400,
      },
    }),
  );
  await deleteAccountData(caller.sub);
  await ddb().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: jobKey(caller.sub),
      UpdateExpression: 'SET #s = :c, completedAt = :t',
      ExpressionAttributeNames: { '#s': 'state' },
      ExpressionAttributeValues: { ':c': 'completed', ':t': new Date().toISOString() },
    }),
  );
  log.info('account.deleted', { ok: true });
  return json(200, { state: 'completed', requestedAt } satisfies {
    state: 'completed';
    requestedAt: string;
  });
}

export async function getDeleteStatus(_e: ApiEvent, caller: Caller): Promise<ApiResult> {
  const r = await ddb().send(new GetCommand({ TableName: tableName(), Key: jobKey(caller.sub) }));
  const body = r.Item
    ? {
        state: r.Item.state as 'in_progress' | 'completed',
        requestedAt: r.Item.requestedAt as string,
      }
    : { state: 'none' as const, requestedAt: null };
  return json(200, v1.DeletionStatus.parse(body));
}

/** Everything we hold about the caller, as JSON (data portability). Push tokens are redacted. */
export async function getExport(_e: ApiEvent, caller: Caller): Promise<ApiResult> {
  const own = await queryAll({
    TableName: tableName(),
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: { ':pk': Keys.user(caller.sub) },
  });
  const HIDDEN = new Set([
    'pk',
    'sk',
    'gsi1pk',
    'gsi1sk',
    'ttl',
    'pushToken',
    'pushTokenHash',
    'tokenHash',
  ]);
  const strip = (i: Item) => ({
    kind: String(i.sk).split('#')[0]!.toLowerCase(),
    ...Object.fromEntries(Object.entries(i).filter(([k]) => !HIDDEN.has(k))),
  });
  const memberships = await queryAll({
    TableName: tableName(),
    IndexName: 'gsi1',
    KeyConditionExpression: 'gsi1pk = :p',
    ExpressionAttributeValues: { ':p': `MEMBEROF#${caller.sub}` },
  });
  return json(200, {
    exportedAt: new Date().toISOString(),
    userId: caller.sub,
    items: own.map(strip),
    challenges: memberships.map((m) => String(m.gsi1sk).slice('CHAL#'.length)),
  });
}
