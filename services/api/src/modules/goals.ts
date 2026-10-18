import { QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { v1 } from '@siddiq3/driftless-contracts';
import type { Caller } from '../lib/auth.js';
import { ddb, isConditionalFailure, Keys, tableName } from '../lib/ddb.js';
import { Errors, json, parseBody, type ApiEvent, type ApiResult } from '../lib/http.js';

type GoalItem = v1.Goal & { pk: string; sk: string; updatedAt: string };

async function listGoals(sub: string): Promise<v1.Goal[]> {
  const r = await ddb().send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :g)',
      ExpressionAttributeValues: { ':pk': Keys.user(sub), ':g': 'GOAL#' },
      ConsistentRead: true,
    }),
  );
  return (r.Items ?? []).map((i) => {
    const { goalId, metric, dailyLimit, enabled, rev } = i as GoalItem;
    return { goalId, metric, dailyLimit, enabled, rev };
  });
}

export async function getGoals(_event: ApiEvent, caller: Caller): Promise<ApiResult> {
  return json(200, { goals: await listGoals(caller.sub) } satisfies v1.GoalsResponse);
}

/**
 * Replaces the caller's goal set in one transaction. A goal is written only if its rev is not
 * older than the stored one; goals missing from the request are deleted. All-or-nothing.
 */
export async function putGoals(event: ApiEvent, caller: Caller): Promise<ApiResult> {
  const { goals } = parseBody(event, v1.PutGoalsRequest);
  const existing = await listGoals(caller.sub);
  const now = new Date().toISOString();
  const keep = new Set(goals.map((g) => g.goalId));

  const items: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']> =
    [
      ...goals.map((g) => ({
        Put: {
          TableName: tableName(),
          Item: {
            pk: Keys.user(caller.sub),
            sk: Keys.goal(g.goalId),
            ...g,
            updatedAt: now,
          } satisfies GoalItem,
          ConditionExpression: 'attribute_not_exists(pk) OR rev <= :rev',
          ExpressionAttributeValues: { ':rev': g.rev },
        },
      })),
      ...existing
        .filter((g) => !keep.has(g.goalId))
        .map((g) => ({
          Delete: {
            TableName: tableName(),
            Key: { pk: Keys.user(caller.sub), sk: Keys.goal(g.goalId) },
          },
        })),
    ];
  if (items.length > 0) {
    try {
      await ddb().send(new TransactWriteCommand({ TransactItems: items }));
    } catch (e) {
      if (isConditionalFailure(e))
        throw Errors.conflict(
          'goal_conflict',
          'a goal was changed on another device; reload and retry',
        );
      throw e;
    }
  }
  return json(200, { goals: await listGoals(caller.sub) } satisfies v1.GoalsResponse);
}
