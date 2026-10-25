import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, tableName } from './ddb.js';
import { HttpError } from './http.js';

export const accountKey = (userId) => ({ pk: `ACCOUNT#${userId}`, sk: 'STATE' });
export const incarnationKey = (incarnation) => ({ pk: `INCARNATION#${incarnation}`, sk: 'STATE' });
export const inactive = () =>
  new HttpError(409, 'account_inactive', 'Account incarnation is no longer active');
export async function readState(key) {
  return (
    await ddb().send(new GetCommand({ TableName: tableName(), Key: key, ConsistentRead: true }))
  ).Item;
}
export async function activeIncarnation(userId) {
  const state = await readState(accountKey(userId));
  if (state?.state !== 'active') throw inactive();
  return state.incarnation;
}
export async function assertActive(incarnation) {
  if ((await readState(incarnationKey(incarnation)))?.state !== 'active') throw inactive();
}

/** Preserve the original conditions and their cancellation indexes. Append lifecycle barriers
 * to the SAME transaction, including both owners of bilateral USER mutations. No read/write gap. */
export async function activeWrite(incarnation, command, additional = []) {
  const name = command.constructor.name;
  const operation = { PutCommand: 'Put', UpdateCommand: 'Update', DeleteCommand: 'Delete' }[name];
  const items =
    name === 'TransactWriteCommand'
      ? command.input.TransactItems
      : operation
        ? [{ [operation]: command.input }]
        : null;
  if (!items) throw new Error('activeWrite requires a write command');
  const owners = new Set([incarnation, ...additional]);
  for (const item of items) {
    const value = Object.values(item)[0];
    const pk = value.Item?.pk ?? value.Key?.pk;
    if (pk?.startsWith('USER#')) owners.add(pk.slice(5));
  }
  const guards = [...owners].map((owner) => ({
    ConditionCheck: {
      TableName: tableName(),
      Key: incarnationKey(owner),
      ConditionExpression: '#state = :active',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: { ':active': 'active' },
    },
  }));
  if (items.length + guards.length > 100)
    throw new Error('Lifecycle transaction exceeds DynamoDB limit');
  try {
    return await ddb().send(new TransactWriteCommand({ TransactItems: [...items, ...guards] }));
  } catch (error) {
    if (
      error.CancellationReasons?.slice(items.length).some(
        (r) => r.Code === 'ConditionalCheckFailed',
      )
    )
      throw inactive();
    throw error;
  }
}
