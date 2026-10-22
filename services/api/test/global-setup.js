import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  ResourceNotFoundException,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
/**
 * Integration tests run against DynamoDB Local (CI service container).
 * They fail loudly if it is missing — they are never silently skipped.
 */
export default async function setup() {
  const endpoint = process.env.DDB_ENDPOINT;
  if (!endpoint) {
    throw new Error(
      'DDB_ENDPOINT is not set. Start DynamoDB Local, e.g. docker run -p 8000:8000 amazon/dynamodb-local',
    );
  }
  const TableName = (process.env.TABLE_NAME ??= 'driftless-test');
  const client = new DynamoDBClient({
    endpoint,
    region: 'local',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  try {
    await client.send(new DeleteTableCommand({ TableName }));
  } catch (e) {
    if (!(e instanceof ResourceNotFoundException) && e.name !== 'ResourceNotFoundException')
      throw e;
  }
  // Mirrors serverless.yml — keep in sync (deployment template tests assert the same key schema).
  await client.send(
    new CreateTableCommand({
      TableName,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
        { AttributeName: 'gsi1pk', AttributeType: 'S' },
        { AttributeName: 'gsi1sk', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'gsi1',
          KeySchema: [
            { AttributeName: 'gsi1pk', KeyType: 'HASH' },
            { AttributeName: 'gsi1sk', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    }),
  );
  await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName });
  return async () => {
    await client.send(new DeleteTableCommand({ TableName })).catch(() => undefined);
  };
}
