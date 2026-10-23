import { randomUUID } from 'node:crypto';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { ddb, tableName } from '../src/lib/ddb.js';
import { withDelivery } from '../src/lib/delivery.js';
import { json } from '../src/lib/http.js';
const key = (id) => ({ pk: `PUBSUB#${id}`, sk: 'PUBSUB' });
const read = async (id) =>
  (await ddb().send(new GetCommand({ TableName: tableName(), Key: key(id), ConsistentRead: true })))
    .Item;

describe('recoverable delivery claims', () => {
  it('releases failed work and records completion only after the retry succeeds', async () => {
    const id = randomUUID();
    await expect(
      withDelivery(id, async () => {
        throw new Error('dependency failed');
      }),
    ).rejects.toThrow('dependency failed');
    expect(await read(id)).toBeUndefined();
    expect((await withDelivery(id, async () => json(200, { applied: true }))).statusCode).toBe(200);
    expect((await read(id)).status).toBe('done');
    let called = false;
    const duplicate = await withDelivery(id, async () => {
      called = true;
      return json(200, {});
    });
    expect(called).toBe(false);
    expect(JSON.parse(duplicate.body)).toEqual({ duplicate: true });
  });
  it('does not acknowledge a concurrent in-progress delivery', async () => {
    const id = randomUUID();
    let started;
    const ready = new Promise((resolve) => {
      started = resolve;
    });
    let finish;
    const wait = new Promise((resolve) => {
      finish = resolve;
    });
    const first = withDelivery(id, async () => {
      started();
      await wait;
      return json(200, {});
    });
    await ready;
    try {
      await expect(withDelivery(id, async () => json(200, {}))).rejects.toMatchObject({
        status: 503,
      });
    } finally {
      finish();
      await first;
    }
  });
  it('recovers an abandoned lease and expires completed markers independently of delayed TTL removal', async () => {
    for (const record of [
      { status: 'processing', owner: 'abandoned', leaseUntil: 0, ttl: 9999999999 },
      { status: 'done', owner: 'expired', ttl: 0 },
    ]) {
      const id = randomUUID();
      await ddb().send(new PutCommand({ TableName: tableName(), Item: { ...key(id), ...record } }));
      await withDelivery(id, async () => json(200, {}));
      expect((await read(id)).status).toBe('done');
      expect((await read(id)).owner).not.toBe(record.owner);
    }
  });
  it('honors unexpired legacy completion markers', async () => {
    const id = randomUUID();
    await ddb().send(
      new PutCommand({ TableName: tableName(), Item: { ...key(id), ttl: 9999999999 } }),
    );
    expect(
      JSON.parse(
        (
          await withDelivery(id, async () => {
            throw new Error('must not run');
          })
        ).body,
      ),
    ).toEqual({ duplicate: true });
  });
  it('cannot complete or remove a claim owned by a newer invocation', async () => {
    const id = randomUUID();
    await expect(
      withDelivery(id, async () => {
        await ddb().send(
          new PutCommand({
            TableName: tableName(),
            Item: {
              ...key(id),
              status: 'processing',
              owner: 'replacement',
              leaseUntil: 9999999999,
              ttl: 9999999999,
            },
          }),
        );
        return json(200, {});
      }),
    ).rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
    expect((await read(id)).owner).toBe('replacement');
    expect((await read(id)).status).toBe('processing');
  });
});
