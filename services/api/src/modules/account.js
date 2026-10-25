import { randomUUID } from 'node:crypto';
import { QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { v1 } from '@siddiq3/driftless-contracts';
import { requireRecentAuth } from '../lib/auth.js';
import { ddb, Keys, tableName } from '../lib/ddb.js';
import { accountKey, incarnationKey, readState, inactive } from '../lib/lifecycle.js';
import { header, json, parseBody, Errors } from '../lib/http.js';
import { defaultProfile } from './me.js';

const Register = v1.RegisterAccountRequest;
async function queryAll(params) {
  const out = [];
  let start;
  do {
    const r = await ddb().send(new QueryCommand({ ...params, ExclusiveStartKey: start }));
    out.push(...(r.Items ?? []));
    start = r.LastEvaluatedKey;
  } while (start);
  return out;
}
export async function getAccountState(_event, caller) {
  const current = await readState(accountKey(caller.sub));
  // Absence is ambiguous even without a profile: old deletion markers expired. Never import.
  return json(200, {
    state: current?.state ?? 'legacy_quarantined',
    incarnation: current?.incarnation ?? null,
  });
}
export async function postRegister(event, caller) {
  requireRecentAuth(caller, Math.floor(Date.now() / 1000));
  const req = parseBody(event, Register);
  const current = await readState(accountKey(caller.sub));
  if (
    current?.state === 'active' &&
    current.registrationId === req.registrationId &&
    current.previousIncarnation === req.expectedIncarnation
  )
    return getAccountState(event, caller);
  if (
    (current?.incarnation ?? null) !== req.expectedIncarnation ||
    (current && current.state !== 'deleted')
  )
    throw Errors.conflict('registration_conflict', 'Refresh account status before registering');
  const incarnation = randomUUID();
  const now = new Date().toISOString();
  const state = {
    state: 'active',
    incarnation,
    userId: caller.sub,
    registrationId: req.registrationId,
    previousIncarnation: req.expectedIncarnation,
    createdAt: now,
  };
  try {
    await ddb().send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName(),
              Item: { ...accountKey(caller.sub), ...state },
              ConditionExpression: current
                ? 'incarnation = :previous AND #s = :deleted'
                : 'attribute_not_exists(pk)',
              ...(current
                ? {
                    ExpressionAttributeNames: { '#s': 'state' },
                    ExpressionAttributeValues: {
                      ':previous': req.expectedIncarnation,
                      ':deleted': 'deleted',
                    },
                  }
                : {}),
            },
          },
          {
            Put: {
              TableName: tableName(),
              Item: { ...incarnationKey(incarnation), ...state },
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
          {
            Put: {
              TableName: tableName(),
              Item: { ...defaultProfile(incarnation, now), userId: caller.sub },
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (error.name !== 'TransactionCanceledException') throw error;
    const winner = await readState(accountKey(caller.sub));
    if (
      winner?.state === 'active' &&
      winner.registrationId === req.registrationId &&
      winner.previousIncarnation === req.expectedIncarnation
    )
      return getAccountState(event, caller);
    throw Errors.conflict('registration_conflict', 'Refresh account status before registering');
  }
  return getAccountState(event, caller);
}
function deletionGuard(incarnation) {
  return {
    ConditionCheck: {
      TableName: tableName(),
      Key: incarnationKey(incarnation),
      ConditionExpression: '#s = :deleting',
      ExpressionAttributeNames: { '#s': 'state' },
      ExpressionAttributeValues: { ':deleting': 'deleting' },
    },
  };
}
async function cleanupWrite(incarnation, items) {
  await ddb().send(
    new TransactWriteCommand({ TransactItems: [...items, deletionGuard(incarnation)] }),
  );
}
const del = (Key) => ({ Delete: { TableName: tableName(), Key } });
const conditionalFailure = (e) =>
  e.name === 'TransactionCanceledException' &&
  e.CancellationReasons?.some((r) => r.Code === 'ConditionalCheckFailed');
/** Every external reference has an owner-side journal written in its creation transaction.
 * Delete references and their journals together; interruptions cannot erase the retry inventory.
 * This covers incarnation-era data only. Historical legacy inventory is deliberately deferred. */
export async function deleteAccountData(incarnation) {
  const own = await queryAll({
    TableName: tableName(),
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: { ':pk': Keys.user(incarnation) },
    ConsistentRead: true,
  });
  const profile = own.find((i) => i.sk === Keys.profile);
  if (profile?.handle) {
    try {
      await cleanupWrite(incarnation, [
        {
          Delete: {
            TableName: tableName(),
            Key: Keys.handle(profile.handle),
            ConditionExpression: '#sub = :sub',
            ExpressionAttributeNames: { '#sub': 'sub' },
            ExpressionAttributeValues: { ':sub': incarnation },
          },
        },
      ]);
    } catch (e) {
      if (!conditionalFailure(e)) throw e;
    }
  }
  for (const row of own) {
    const key = { pk: row.pk, sk: row.sk };
    if (row.sk.startsWith('FRIEND#')) {
      await cleanupWrite(incarnation, [
        del({ pk: Keys.user(row.otherSub), sk: `FRIEND#${incarnation}` }),
        del(key),
      ]);
    } else if (row.sk.startsWith('MEMBERSHIP#')) {
      const member = { pk: `CHAL#${row.challengeId}`, sk: `MEMBER#${incarnation}` };
      const present = await readState(member);
      if (present) {
        const meta = { pk: member.pk, sk: 'META' };
        const items = [del(member), del(key)];
        if (await readState(meta))
          items.push({
            Update: {
              TableName: tableName(),
              Key: meta,
              UpdateExpression: 'SET memberCount = memberCount - :one',
              ConditionExpression: 'memberCount > :zero',
              ExpressionAttributeValues: { ':one': 1, ':zero': 0 },
            },
          });
        // Two concurrent cleaners must not decrement the same membership twice.
        items[0].Delete.ConditionExpression = 'attribute_exists(pk)';
        try {
          await cleanupWrite(incarnation, items);
        } catch (e) {
          if (!conditionalFailure(e) || (await readState(member))) throw e;
        }
      } else await cleanupWrite(incarnation, [del(key)]);
    } else if (row.sk.startsWith('OWNEDCHALLENGE#')) {
      const meta = { pk: `CHAL#${row.challengeId}`, sk: 'META' };
      try {
        await cleanupWrite(incarnation, [
          {
            Update: {
              TableName: tableName(),
              Key: meta,
              UpdateExpression: 'REMOVE ownerId, ownerUserId',
              ConditionExpression: 'ownerId = :owner',
              ExpressionAttributeValues: { ':owner': incarnation },
            },
          },
          del(key),
        ]);
      } catch (error) {
        if (!conditionalFailure(error) || (await readState(meta))?.ownerId === incarnation)
          throw error;
        await cleanupWrite(incarnation, [del(key)]);
      }
    } else if (row.sk.startsWith('PURCHASE#')) {
      try {
        await cleanupWrite(incarnation, [
          {
            Update: {
              TableName: tableName(),
              Key: { pk: row.sk, sk: 'PURCHASE' },
              UpdateExpression: 'SET disabled = :yes REMOVE #token',
              ConditionExpression: '#sub = :sub',
              ExpressionAttributeNames: { '#sub': 'sub', '#token': 'token' },
              ExpressionAttributeValues: { ':sub': incarnation, ':yes': true },
            },
          },
          del(key),
        ]);
      } catch (e) {
        if (!conditionalFailure(e)) throw e;
        const purchase = await readState({ pk: row.sk, sk: 'PURCHASE' });
        if (purchase?.sub === incarnation) throw e;
        await cleanupWrite(incarnation, [del(key)]);
      }
    } else if (row.sk.startsWith('INVITE#')) {
      const invite = { pk: row.sk, sk: 'INVITE' };
      try {
        await cleanupWrite(incarnation, [
          {
            Delete: {
              TableName: tableName(),
              Key: invite,
              ConditionExpression: '#sub = :sub',
              ExpressionAttributeNames: { '#sub': 'sub' },
              ExpressionAttributeValues: { ':sub': incarnation },
            },
          },
          del(key),
        ]);
      } catch (error) {
        if (!conditionalFailure(error) || (await readState(invite))?.sub === incarnation)
          throw error;
        await cleanupWrite(incarnation, [del(key)]);
      }
    }
  }
  // External cleanup completed before bulk owner removal; no remaining reference inventory lost.
  for (let offset = 0; offset < own.length; offset += 50)
    await cleanupWrite(
      incarnation,
      own.slice(offset, offset + 50).map((row) => del({ pk: row.pk, sk: row.sk })),
    );
}
async function deletionState(event, caller) {
  const incarnation = header(event, 'x-account-incarnation');
  if (!Register.shape.registrationId.safeParse(incarnation).success) throw inactive();
  const state = await readState(incarnationKey(incarnation));
  if (state?.userId !== caller.sub) throw inactive();
  return state;
}
export async function postDeleteAccount(event, caller) {
  requireRecentAuth(caller, Math.floor(Date.now() / 1000));
  let state = await deletionState(event, caller);
  const incarnation = state.incarnation;
  if (state.state === 'active') {
    const requestedAt = new Date().toISOString();
    const values = { ':active': 'active', ':deleting': 'deleting', ':time': requestedAt };
    try {
      await ddb().send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: tableName(),
                Key: accountKey(caller.sub),
                UpdateExpression: 'SET #s = :deleting, requestedAt = :time',
                ConditionExpression: '#s = :active AND incarnation = :inc',
                ExpressionAttributeNames: { '#s': 'state' },
                ExpressionAttributeValues: { ...values, ':inc': incarnation },
              },
            },
            {
              Update: {
                TableName: tableName(),
                Key: incarnationKey(incarnation),
                UpdateExpression: 'SET #s = :deleting, requestedAt = :time',
                ConditionExpression: '#s = :active',
                ExpressionAttributeNames: { '#s': 'state' },
                ExpressionAttributeValues: values,
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (!conditionalFailure(error)) throw error;
    }
    state = await deletionState(event, caller);
  }
  if (state.state === 'deleting') {
    try {
      await deleteAccountData(incarnation);
    } catch (error) {
      // Another retry may have completed the same cleanup. It can never authorize a new owner.
      if (!conditionalFailure(error) || (await deletionState(event, caller)).state !== 'deleted')
        throw error;
      return getDeleteStatus(event, caller);
    }
    const values = { ':deleting': 'deleting', ':deleted': 'deleted' };
    try {
      await ddb().send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: tableName(),
                Key: accountKey(caller.sub),
                UpdateExpression: 'SET #s = :deleted',
                ConditionExpression: '#s = :deleting AND incarnation = :inc',
                ExpressionAttributeNames: { '#s': 'state' },
                ExpressionAttributeValues: { ...values, ':inc': incarnation },
              },
            },
            {
              Update: {
                TableName: tableName(),
                Key: incarnationKey(incarnation),
                UpdateExpression: 'SET #s = :deleted',
                ConditionExpression: '#s = :deleting',
                ExpressionAttributeNames: { '#s': 'state' },
                ExpressionAttributeValues: values,
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (!conditionalFailure(error) || (await deletionState(event, caller)).state !== 'deleted')
        throw error;
    }
  }
  return getDeleteStatus(event, caller);
}
export async function getDeleteStatus(event, caller) {
  const state = await deletionState(event, caller);
  return json(200, {
    state:
      state.state === 'deleted' ? 'completed' : state.state === 'deleting' ? 'in_progress' : 'none',
    requestedAt: state.requestedAt ?? null,
  });
}
/** Everything we hold about the caller, as JSON (data portability). Push tokens are redacted. */
export async function getExport(_e, caller) {
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
  const strip = (i) => ({
    kind: String(i.sk).split('#')[0].toLowerCase(),
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
    userId: caller.userId,
    items: own.map(strip),
    challenges: memberships.map((m) => String(m.gsi1sk).slice('CHAL#'.length)),
  });
}
