import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ddb } from '../src/lib/ddb.js';
import { batchDelete, batchGet } from '../src/lib/batch.js';

let send;
beforeEach(() => {
  send = vi.spyOn(ddb(), 'send');
  vi.spyOn(Math, 'random').mockReturnValue(0);
});
afterEach(() => vi.restoreAllMocks());

describe('partial DynamoDB batch responses', () => {
  it('retries only unread keys and preserves strong read settings', async () => {
    const table = process.env.TABLE_NAME;
    const keys = [
      { pk: 'USER#dummy', sk: 'PROFILE' },
      { pk: 'USER#other', sk: 'PROFILE' },
    ];
    const pending = { [table]: { Keys: [keys[1]], ConsistentRead: true } };
    send
      .mockResolvedValueOnce({
        Responses: { [table]: [{ ...keys[0], rev: 1 }] },
        UnprocessedKeys: pending,
      })
      .mockResolvedValueOnce({ Responses: { [table]: [{ ...keys[1], rev: 2 }] } });
    expect(await batchGet(keys, true)).toHaveLength(2);
    expect(send.mock.calls[0][0].input.RequestItems[table].ConsistentRead).toBe(true);
    expect(send.mock.calls[1][0].input.RequestItems).toEqual(pending);
  });
  it('fails rather than returning an incomplete profile list after bounded retries', async () => {
    const table = process.env.TABLE_NAME;
    const keys = [{ pk: 'USER#dummy', sk: 'PROFILE' }];
    send.mockResolvedValue({ UnprocessedKeys: { [table]: { Keys: keys } } });
    await expect(batchGet(keys)).rejects.toMatchObject({ status: 503, code: 'database_busy' });
    expect(send).toHaveBeenCalledTimes(5);
  });
  it('does not treat an empty unprocessed table map as pending', async () => {
    send.mockResolvedValue({ UnprocessedItems: { [process.env.TABLE_NAME]: [] } });
    await expect(batchDelete([{ pk: 'USER#dummy', sk: 'PROFILE' }])).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('rejects incomplete deletion after five responses retaining the same request', async () => {
    send.mockImplementation(async (command) => ({ UnprocessedItems: command.input.RequestItems }));
    await expect(batchDelete([{ pk: 'USER#dummy', sk: 'PROFILE' }])).rejects.toMatchObject({
      status: 503,
    });
    expect(send).toHaveBeenCalledTimes(5);
  });
});
