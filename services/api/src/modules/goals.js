import { activeWrite } from '../lib/lifecycle.js';
import { GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { v1 } from '@siddiq3/driftless-contracts';
import { ddb, isConditionalFailure, Keys, tableName } from '../lib/ddb.js';
import { Errors, header, json, parseBody } from '../lib/http.js';
async function listGoals(sub) {
  const r = await ddb().send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :g)',
      ExpressionAttributeValues: { ':pk': Keys.user(sub), ':g': 'GOAL#' },
      ConsistentRead: true,
    }),
  );
  return (r.Items ?? []).map((i) => {
    const { goalId, metric, dailyLimit, enabled, rev } = i;
    return { goalId, metric, dailyLimit, enabled, rev };
  });
}
// Separate from GOAL# items so existing readers/export/deletion keep their behavior.
const metaKey = (sub) => ({ pk: Keys.user(sub), sk: 'GOALSET#META' });
const revision = async (sub) => {
  const r = await ddb().send(
    new GetCommand({ TableName: tableName(), Key: metaKey(sub), ConsistentRead: true }),
  );
  return r.Item?.rev ?? 0;
};
const etag = (rev) => `"goals-${rev}"`;
async function snapshot(sub) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const rev = await revision(sub);
    const goals = await listGoals(sub);
    if (rev === (await revision(sub))) return { rev, goals };
  }
  throw Errors.conflict('goal_conflict', 'goals changed while reading; retry');
}
export async function getGoals(_event, caller) {
  const current = await snapshot(caller.sub);
  return json(
    200,
    { goals: current.goals },
    {
      etag: etag(current.rev),
    },
  );
}
/** Strict goal validation is unchanged. New clients send If-Match for whole-set safety.
 * Legacy clients may omit it; every write still guards against concurrent transactions.
 */
export async function putGoals(event, caller) {
  const { goals } = parseBody(event, v1.PutGoalsRequest);
  const current = await snapshot(caller.sub);
  const match = header(event, 'if-match');
  if (match !== undefined && match !== etag(current.rev))
    throw Errors.preconditionFailed('goals changed; reload and retry');
  const now = new Date().toISOString();
  const keep = new Set(goals.map((g) => g.goalId));
  const items = [
    {
      Put: {
        TableName: tableName(),
        Item: { ...metaKey(caller.sub), rev: current.rev + 1 },
        ConditionExpression: 'attribute_not_exists(pk) OR rev = :rev',
        ExpressionAttributeValues: { ':rev': current.rev },
      },
    },
    ...goals.map((g) => ({
      Put: {
        TableName: tableName(),
        Item: {
          pk: Keys.user(caller.sub),
          sk: Keys.goal(g.goalId),
          ...g,
          updatedAt: now,
        },
        ConditionExpression: 'attribute_not_exists(pk) OR rev <= :rev',
        ExpressionAttributeValues: { ':rev': g.rev },
      },
    })),
    ...current.goals
      .filter((g) => !keep.has(g.goalId))
      .map((g) => ({
        Delete: {
          TableName: tableName(),
          Key: { pk: Keys.user(caller.sub), sk: Keys.goal(g.goalId) },
        },
      })),
  ];
  try {
    await activeWrite(caller.sub, new TransactWriteCommand({ TransactItems: items }));
  } catch (e) {
    if (isConditionalFailure(e))
      throw Errors.conflict(
        'goal_conflict',
        'a goal was changed on another device; reload and retry',
      );
    throw e;
  }
  return json(200, { goals }, { etag: etag(current.rev + 1) });
}
