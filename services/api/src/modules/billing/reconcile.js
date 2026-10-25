import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, tableName } from '../../lib/ddb.js';
import { log } from '../../lib/log.js';
import { applyPlayToken } from './index.js';
/**
 * Daily safety net for missed Play notifications: re-reads from Google every Play entitlement that
 * expires within [horizonMs], or has already expired but still says pro, or is in grace/on hold.
 */
export async function reconcilePlay(nowMs = Date.now(), horizonMs = 2 * 86_400_000) {
  const until = new Date(nowMs + horizonMs).toISOString();
  let checked = 0;
  let changed = 0;
  let start;
  do {
    const page = await ddb().send(
      new QueryCommand({
        TableName: tableName(),
        IndexName: 'gsi1',
        KeyConditionExpression: 'gsi1pk = :p AND gsi1sk <= :u',
        ExpressionAttributeValues: { ':p': 'ENT#play', ':u': `${until}#~` },
        ExclusiveStartKey: start,
      }),
    );
    for (const e of page.Items ?? []) {
      if (e.tier !== 'pro' && e.state !== 'grace' && e.state !== 'on_hold') continue;
      const sub = String(e.pk).slice('USER#'.length);
      const p = (
        await ddb().send(
          new GetCommand({
            TableName: tableName(),
            Key: { pk: `PURCHASE#play#${String(e.tokenHash)}`, sk: 'PURCHASE' },
          }),
        )
      ).Item;
      if (!p?.token || p.supersededBy || p.sub !== sub) continue;
      checked++;
      try {
        const next = await applyPlayToken(sub, p.token, p.productId);
        if (next.tier !== e.tier || next.state !== e.state) changed++;
      } catch (error) {
        if (error.code !== 'account_inactive') throw error;
      }
    }
    start = page.LastEvaluatedKey;
  } while (start);
  log.info('billing.reconcile', { checked, changed });
  return { checked, changed };
}
