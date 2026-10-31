import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

const template = JSON.parse(readFileSync('.serverless/cloudformation-template-update-stack.json'));
const resources = template.Resources;
const ofType = (type) => Object.values(resources).filter((item) => item.Type === type);

test('browser access is limited to the deletion page routes, not the whole API', () => {
  const api = Object.values(resources).find((r) => r.Type === 'AWS::ApiGatewayV2::Api');
  assert.equal(api.Properties.CorsConfiguration, undefined);
  const options = ofType('AWS::ApiGatewayV2::Route')
    .map((route) => route.Properties)
    .filter((route) => route.RouteKey.startsWith('OPTIONS '));
  assert.deepEqual(options.map((route) => route.RouteKey).sort(), [
    'OPTIONS /v1/account',
    'OPTIONS /v1/account/delete',
  ]);
});

test('application routes require JWT; only health, webhook and invitation landing/association routes are public', () => {
  const routes = ofType('AWS::ApiGatewayV2::Route').map((route) => route.Properties);
  const privateRoutes = routes.filter(
    (route) => route.RouteKey.includes('/v1/') && !route.RouteKey.startsWith('OPTIONS '),
  );
  assert.equal(privateRoutes.length, 5);
  for (const route of privateRoutes) {
    assert.equal(route.AuthorizationType, 'JWT');
    assert.deepEqual(route.AuthorizerId, { Ref: 'HttpApiAuthorizerGoogleJwt' });
  }
  assert.deepEqual(
    routes
      .filter((route) => !route.AuthorizationType)
      .map((route) => route.RouteKey)
      .sort(),
    [
      'GET /health',
      'OPTIONS /v1/account',
      'OPTIONS /v1/account/delete',
      'POST /webhooks/play-rtdn',
      'GET /join/{code}',
      'GET /.well-known/assetlinks.json',
      'GET /.well-known/apple-app-site-association',
    ].sort(),
  );
  const jwt = resources.HttpApiAuthorizerGoogleJwt.Properties.JwtConfiguration;
  assert.equal(jwt.Issuer, 'https://accounts.google.com');
  assert.equal(jwt.Audience.length, 1);
  assert.match(jwt.Audience[0], /^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/);
  assert.equal(
    resources.ApiLambdaFunction.Properties.Environment.Variables.GOOGLE_WEB_CLIENT_ID,
    jwt.Audience[0],
  );
});

test('database retains data, backups, encryption, TTL and the application index', () => {
  const table = resources.MainTable;
  assert.equal(table.DeletionPolicy, 'Retain');
  assert.equal(table.UpdateReplacePolicy, 'Retain');
  assert.deepEqual(template.Conditions.IsProduction, { 'Fn::Equals': ['prod', 'prod'] });
  assert.deepEqual(table.Properties.DeletionProtectionEnabled, {
    'Fn::If': ['IsProduction', true, false],
  });
  assert.equal(table.Properties.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled, true);
  assert.equal(table.Properties.SSESpecification.SSEEnabled, true);
  assert.deepEqual(table.Properties.TimeToLiveSpecification, {
    AttributeName: 'ttl',
    Enabled: true,
  });
  assert.deepEqual(table.Properties.KeySchema, [
    { AttributeName: 'pk', KeyType: 'HASH' },
    { AttributeName: 'sk', KeyType: 'RANGE' },
  ]);
  assert.deepEqual(table.Properties.GlobalSecondaryIndexes, [
    {
      IndexName: 'gsi1',
      KeySchema: [
        { AttributeName: 'gsi1pk', KeyType: 'HASH' },
        { AttributeName: 'gsi1sk', KeyType: 'RANGE' },
      ],
      Projection: { ProjectionType: 'ALL' },
    },
  ]);
  assert.equal(table.Properties.BillingMode, 'PAY_PER_REQUEST');
});

test('both deployable archives contain their ESM handler and use Node 22 ARM64', () => {
  for (const name of ['api', 'jobs']) {
    const lambda = resources[`${name === 'api' ? 'Api' : 'Jobs'}LambdaFunction`].Properties;
    assert.equal(lambda.Runtime, 'nodejs22.x');
    assert.deepEqual(lambda.Architectures, ['arm64']);
    assert.equal(lambda.Handler, `services/api/dist/${name}/index.handler`);
    const entries = execFileSync('unzip', ['-Z1', `.serverless/${name}.zip`], { encoding: 'utf8' })
      .trim()
      .split('\n');
    assert.deepEqual(entries.sort(), [
      `services/api/dist/${name}/index.mjs`,
      `services/api/dist/${name}/index.mjs.map`,
    ]);
  }
});

test('IAM data access stays scoped to this stack and billing secret is retained', () => {
  const statements =
    resources.IamRoleLambdaExecution.Properties.Policies[0].PolicyDocument.Statement;
  const data = statements.find((item) => item.Action.includes('dynamodb:GetItem'));
  assert.equal(data.Action.includes('dynamodb:Scan'), false);
  assert.deepEqual(data.Resource, [
    { 'Fn::GetAtt': ['MainTable', 'Arn'] },
    { 'Fn::Join': ['', [{ 'Fn::GetAtt': ['MainTable', 'Arn'] }, '/index/*']] },
  ]);
  assert.deepEqual(
    statements.find((item) => item.Action.includes('secretsmanager:GetSecretValue')).Resource,
    { Ref: 'PlayServiceAccount' },
  );
  assert.equal(resources.PlayServiceAccount.DeletionPolicy, 'Retain');
});

test('scheduled reconciliation, logs, throttling and error alarms remain enabled', () => {
  assert.equal(resources.JobsLambdaFunction.Properties.Timeout, 300);
  const schedule = ofType('AWS::Events::Rule')[0].Properties;
  assert.equal(schedule.ScheduleExpression, 'cron(17 3 * * ? *)');
  assert.equal(schedule.State, 'ENABLED');
  for (const log of ofType('AWS::Logs::LogGroup')) assert.equal(log.Properties.RetentionInDays, 30);
  assert.equal(ofType('AWS::CloudWatch::Alarm').length, 5);
  assert.equal(resources.ApiP95Latency.Properties.ExtendedStatistic, 'p95');
  assert.equal(resources.ApiThrottles.Properties.MetricName, 'Throttles');
  assert.equal(resources.JobErrors.Properties.MetricName, 'Errors');
  assert.equal(template.Parameters.AlertTopicArn.Default, '');
  for (const alarm of ofType('AWS::CloudWatch::Alarm')) {
    assert.deepEqual(alarm.Properties.AlarmActions, {
      'Fn::If': ['HasAlertTopic', [{ Ref: 'AlertTopicArn' }], { Ref: 'AWS::NoValue' }],
    });
  }
  assert.deepEqual(resources.HttpApiStage.Properties.DefaultRouteSettings, {
    ThrottlingBurstLimit: 100,
    ThrottlingRateLimit: 50,
  });
  assert.deepEqual(template.Outputs.ApiUrl.Value, { 'Fn::GetAtt': ['HttpApi', 'ApiEndpoint'] });
});
