import { GetCommand, QueryCommand, BatchGetCommand } from '@aws-sdk/lib-dynamodb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLeaderboard } from '../src/modules/challenges.js';
import { ddb, tableName } from '../src/lib/ddb.js';

const id = '11111111-1111-4111-8111-111111111111';
const owner = '22222222-2222-4222-8222-222222222222';
const event = { pathParameters: { id } };
const meta = { metric: 'fewest_minutes', startDate: '2026-10-22', endDate: '2026-10-23', tz: 'UTC' };
const profile = { pk: `USER#${owner}`, sk: 'PROFILE', handle: 'dummy', consent: { cloudSync: true, shareWithFriends: true } };
beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-23T12:00:00Z')));
afterEach(() => vi.restoreAllMocks());
function fake(profileValue = profile) {
  const send = vi.spyOn(ddb(), 'send').mockImplementation(async (command) => {
    if (command instanceof GetCommand) return { Item: command.input.Key.sk === 'META' ? meta : { sub: owner } };
    if (command instanceof BatchGetCommand) return { Responses: { [tableName()]: [profileValue] } };
    if (command instanceof QueryCommand) {
      const values = command.input.ExpressionAttributeValues;
      if (values[':m']) return { Items: [{ sub: owner }] };
      if (values[':a']) {
        const day = { minutes: command.input.ExclusiveStartKey ? 30 : 10, views: null, coverage: 1,
          localDate: command.input.ExclusiveStartKey ? '2026-10-23' : '2026-10-22' };
        return { Items: [day], ...(!command.input.ExclusiveStartKey ? { LastEvaluatedKey: { pk: `USER#${owner}`, sk: 'DAY#cursor' } } : {}) };
      }
    }
    return {};
  });
  return send;
}
describe('leaderboard consistency', () => {
  it('combines all device-day query pages and reads consent strongly', async () => {
    const send = fake();
    const response = await getLeaderboard(event, { sub: owner });
    expect(JSON.parse(response.body).entries[0].score).toBe(20);
    const batch = send.mock.calls.find(([command]) => command instanceof BatchGetCommand)[0];
    expect(batch.input.RequestItems[tableName()].ConsistentRead).toBe(true);
    expect(send.mock.calls.filter(([command]) => command instanceof QueryCommand && command.input.ExpressionAttributeValues[':a'])).toHaveLength(2);
  });
  it('does not fetch or rank a member who withdrew cloud-sync consent', async () => {
    const send = fake({ ...profile, consent: { cloudSync: false, shareWithFriends: true } });
    const response = await getLeaderboard(event, { sub: owner });
    expect(JSON.parse(response.body)).toMatchObject({ entries: [], hiddenMembers: 1 });
    expect(send.mock.calls.some(([command]) => command instanceof QueryCommand && command.input.ExpressionAttributeValues[':a'])).toBe(false);
  });
});
