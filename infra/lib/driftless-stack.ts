import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { HttpApi, HttpMethod, type CfnStage } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Alarm, ComparisonOperator, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';

export type DriftlessStackProps = StackProps & {
  stage: 'dev' | 'prod';
  /** Directory containing the bundled handler (services/api/dist/api). */
  apiCodeDir?: string;
};

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_API_CODE_DIR = path.resolve(here, '../../services/api/dist/api');

export class DriftlessStack extends Stack {
  readonly table: ddb.Table;
  readonly userPool: cognito.UserPool;
  readonly api: HttpApi;

  constructor(scope: Construct, id: string, props: DriftlessStackProps) {
    super(scope, id, props);
    const prod = props.stage === 'prod';

    /* ── Data (ARCHITECTURE §6) ── */
    this.table = new ddb.Table(this, 'Main', {
      partitionKey: { name: 'pk', type: ddb.AttributeType.STRING },
      sortKey: { name: 'sk', type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: prod,
      encryption: ddb.TableEncryption.AWS_MANAGED,
      removalPolicy: prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    this.table.addGlobalSecondaryIndex({
      indexName: 'gsi1',
      partitionKey: { name: 'gsi1pk', type: ddb.AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: ddb.AttributeType.STRING },
      projectionType: ddb.ProjectionType.ALL,
    });

    /* ── Identity (D-003). Google / Sign in with Apple IdPs are added when their secrets exist. ── */
    this.userPool = new cognito.UserPool(this, 'Users', {
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      passwordPolicy: {
        minLength: 10,
        requireLowercase: true,
        requireDigits: true,
        requireUppercase: false,
        requireSymbols: false,
      },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { sms: false, otp: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      deletionProtection: prod,
      removalPolicy: prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    const client = this.userPool.addClient('Mobile', {
      generateSecret: false, // public mobile client → PKCE
      authFlows: { userSrp: true },
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      accessTokenValidity: Duration.minutes(60),
      idTokenValidity: Duration.minutes(60),
      refreshTokenValidity: Duration.days(30),
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
        callbackUrls: ['driftless://auth/callback'],
        logoutUrls: ['driftless://auth/logout'],
      },
    });

    /* ── API ── */
    const logGroup = new logs.LogGroup(this, 'ApiFnLogs', {
      retention: logs.RetentionDays.ONE_MONTH, // PRIVACY_AND_DATA_RETENTION §1
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const fn = new lambda.Function(this, 'ApiFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(props.apiCodeDir ?? DEFAULT_API_CODE_DIR),
      memorySize: 512,
      timeout: Duration.seconds(10),
      logGroup,
      environment: { TABLE_NAME: this.table.tableName, NODE_OPTIONS: '--enable-source-maps' },
    });
    this.table.grantReadWriteData(fn);

    const authorizer = new HttpJwtAuthorizer('Jwt', this.userPool.userPoolProviderUrl, {
      jwtAudience: [client.userPoolClientId],
      identitySource: ['$request.header.Authorization'],
    });
    this.api = new HttpApi(this, 'Api', { createDefaultStage: true });
    this.api.addRoutes({
      path: '/v1/{proxy+}',
      methods: [
        HttpMethod.GET,
        HttpMethod.POST,
        HttpMethod.PUT,
        HttpMethod.PATCH,
        HttpMethod.DELETE,
      ],
      integration: new HttpLambdaIntegration('ApiIntegration', fn),
      authorizer,
    });
    // Coarse abuse protection; per-user limits live in the API (THREAT_MODEL T8/T12).
    const stage = this.api.defaultStage!.node.defaultChild as CfnStage;
    stage.defaultRouteSettings = { throttlingBurstLimit: 100, throttlingRateLimit: 50 };

    /* ── Ops ── */
    new Alarm(this, 'ApiFnErrors', {
      metric: fn.metricErrors({ period: Duration.minutes(5) }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    new Alarm(this, 'Api5xx', {
      metric: this.api.metricServerError({ period: Duration.minutes(5) }),
      threshold: 5,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    new CfnOutput(this, 'ApiUrl', { value: this.api.apiEndpoint });
    new CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: client.userPoolClientId });
  }
}
