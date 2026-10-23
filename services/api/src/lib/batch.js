import { BatchGetCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, tableName } from './ddb.js';
import { HttpError } from './http.js';

const ATTEMPTS = 5;
const pause = (attempt) =>
  new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 25 * 2 ** attempt)));
const incomplete = () => new HttpError(503, 'database_busy', 'Database is busy. Please retry.');

/** Retry only the unprocessed keys; never silently turn throttling into missing data. */
export async function batchGet(keys, consistentRead = false) {
  const items = [];
  for (let offset = 0; offset < keys.length; offset += 100) {
    let pending = {
      [tableName()]: { Keys: keys.slice(offset, offset + 100), ConsistentRead: consistentRead },
    };
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const result = await ddb().send(new BatchGetCommand({ RequestItems: pending }));
      items.push(...(result.Responses?.[tableName()] ?? []));
      pending = result.UnprocessedKeys ?? {};
      if (!Object.values(pending).some((table) => table.Keys?.length)) break;
      if (attempt === ATTEMPTS - 1) throw incomplete();
      await pause(attempt);
    }
  }
  return items;
}

/** Returning means every requested key was processed. Partial deletion is retryable. */
export async function batchDelete(keys) {
  for (let offset = 0; offset < keys.length; offset += 25) {
    let pending = {
      [tableName()]: keys.slice(offset, offset + 25).map(({ pk, sk }) => ({
        DeleteRequest: { Key: { pk, sk } },
      })),
    };
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const result = await ddb().send(new BatchWriteCommand({ RequestItems: pending }));
      pending = result.UnprocessedItems ?? {};
      if (!Object.values(pending).some((requests) => requests.length)) break;
      if (attempt === ATTEMPTS - 1) throw incomplete();
      await pause(attempt);
    }
  }
}
