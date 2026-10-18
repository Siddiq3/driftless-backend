import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { DriftlessStack } from '../lib/driftless-stack.js';

const codeDir = mkdtempSync(path.join(tmpdir(), 'api-'));
writeFileSync(path.join(codeDir, 'index.mjs'), 'export const handler = async () => ({});');

const synth = (stage: 'dev' | 'prod') =>
  Template.fromStack(new DriftlessStack(new App(), `T-${stage}`, { stage, apiCodeDir: codeDir }));

describe('DriftlessStack', () => {
  const prod = synth('prod');
  const dev = synth('dev');

  it('table key schema, GSI, TTL, PITR, encryption match ARCHITECTURE §6', () => {
    prod.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      DeletionProtectionEnabled: true,
      SSESpecification: { SSEEnabled: true },
      GlobalSecondaryIndexes: [
        Match.objectLike({
          IndexName: 'gsi1',
          KeySchema: [
            { AttributeName: 'gsi1pk', KeyType: 'HASH' },
            { AttributeName: 'gsi1sk', KeyType: 'RANGE' },
          ],
        }),
      ],
    });
  });

  it('prod retains the table; dev may delete it', () => {
    prod.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Retain' });
    dev.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Delete' });
  });

  it('every API route requires the JWT authorizer', () => {
    const routes = prod.findResources('AWS::ApiGatewayV2::Route');
    expect(Object.keys(routes).length).toBeGreaterThan(0);
    for (const r of Object.values(routes)) {
      expect(r.Properties.AuthorizationType).toBe('JWT');
      expect(r.Properties.AuthorizerId).toBeDefined();
    }
    prod.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
      AuthorizerType: 'JWT',
      IdentitySource: ['$request.header.Authorization'],
    });
  });

  it('stage is throttled', () => {
    prod.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      DefaultRouteSettings: { ThrottlingBurstLimit: 100, ThrottlingRateLimit: 50 },
    });
  });

  it('mobile app client is public, PKCE code flow, no implicit grant, revocation on', () => {
    prod.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: false,
      AllowedOAuthFlows: ['code'],
      PreventUserExistenceErrors: 'ENABLED',
      EnableTokenRevocation: true,
    });
  });

  it('Lambda runs Node 22 on arm64 with the table name and 30-day logs', () => {
    prod.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      Environment: { Variables: Match.objectLike({ TABLE_NAME: Match.anyValue() }) },
    });
    prod.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 30 });
  });

  it('Lambda gets data access to its own table only (no wildcard resources)', () => {
    const policies = prod.findResources('AWS::IAM::Policy');
    const statements = Object.values(policies).flatMap(
      (p) => p.Properties.PolicyDocument.Statement as Array<{ Resource: unknown; Action: unknown }>,
    );
    const ddbStatements = statements.filter((s) => JSON.stringify(s.Action).includes('dynamodb:'));
    expect(ddbStatements.length).toBeGreaterThan(0);
    for (const s of ddbStatements) expect(JSON.stringify(s.Resource)).not.toBe('"*"');
  });

  it('error alarms exist', () => {
    prod.resourceCountIs('AWS::CloudWatch::Alarm', 2);
  });
});
