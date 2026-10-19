import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import {
  CfnOutput,
  CfnParameter,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from 'aws-cdk-lib';
import { HttpApi, HttpMethod, type CfnStage } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Alarm, ComparisonOperator, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';

export type DriftlessStackProps = StackProps & {
  stage: 'dev' | 'prod';
  /** Public Web OAuth client ID; alternatively provided as the GoogleWebClientId stack parameter. */
  googleWebClientId?: string;
  /** Directory containing the bundled handler (services/api/dist/api). */
  apiCodeDir?: string;
  jobsCodeDir?: string;
  /** Pub/Sub push subscription audience and service account for Play RTDN. */
  rtdnAudience?: string;
  rtdnServiceAccount?: string;
};

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_API_CODE_DIR = path.resolve(here, '../../services/api/dist/api');
export const DEFAULT_JOBS_CODE_DIR = path.resolve(here, '../../services/api/dist/jobs');

export class DriftlessStack extends Stack {
  readonly table: ddb.Table;
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

    /* Google signs users in directly. Gateway verifies Google-issued ID tokens. */
    const googleWebClientId =
      props.googleWebClientId ??
      new CfnParameter(this, 'GoogleWebClientId', {
        type: 'String',
        allowedPattern: '[A-Za-z0-9_-]+\\.apps\\.googleusercontent\\.com',
        description: 'Public Google Web OAuth client ID used by the Android app (not a secret)',
      }).valueAsString;

    /* ── Billing secret: created empty; the owner pastes the Play service-account JSON. Never in code. ── */
    const playSecret = new secrets.Secret(this, 'PlayServiceAccount', {
      description: 'Google Play Developer API service account JSON (androidpublisher scope)',
      removalPolicy: prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
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
      environment: {
        TABLE_NAME: this.table.tableName,
        NODE_OPTIONS: '--enable-source-maps',
        PLAY_PACKAGE_NAME: 'com.siddiqkolimi.driftless',
        PRO_PRODUCT_IDS: 'driftless_pro',
        PLAY_SA_SECRET_ARN: playSecret.secretArn,
        // Set after creating the Pub/Sub push subscription (see infra README): audience + push SA email.
        RTDN_AUDIENCE: props.rtdnAudience ?? '',
        RTDN_SERVICE_ACCOUNT: props.rtdnServiceAccount ?? '',
        GOOGLE_WEB_CLIENT_ID: googleWebClientId,
      },
    });
    this.table.grantReadWriteData(fn);
    playSecret.grantRead(fn);

    const authorizer = new HttpJwtAuthorizer('GoogleJwt', 'https://accounts.google.com', {
      jwtAudience: [googleWebClientId],
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
    // Store webhooks: no app session; the handler verifies Google's signed OIDC token itself.
    this.api.addRoutes({
      path: '/webhooks/play-rtdn',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('WebhookIntegration', fn),
    });
    // Coarse abuse protection; per-user limits live in the API (THREAT_MODEL T8/T12).
    const stage = this.api.defaultStage!.node.defaultChild as CfnStage;
    stage.defaultRouteSettings = { throttlingBurstLimit: 100, throttlingRateLimit: 50 };

    /* ── Scheduled jobs: daily Play entitlement reconcile (missed RTDN safety net) ── */
    const jobsFn = new lambda.Function(this, 'JobsFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(props.jobsCodeDir ?? DEFAULT_JOBS_CODE_DIR),
      memorySize: 512,
      timeout: Duration.minutes(5),
      logGroup: new logs.LogGroup(this, 'JobsFnLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      environment: {
        TABLE_NAME: this.table.tableName,
        PLAY_PACKAGE_NAME: 'com.siddiqkolimi.driftless',
        PRO_PRODUCT_IDS: 'driftless_pro',
        PLAY_SA_SECRET_ARN: playSecret.secretArn,
      },
    });
    this.table.grantReadWriteData(jobsFn);
    playSecret.grantRead(jobsFn);
    new events.Rule(this, 'DailyReconcile', {
      schedule: events.Schedule.cron({ minute: '17', hour: '3' }),
      targets: [new targets.LambdaFunction(jobsFn)],
    });

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
    new CfnOutput(this, 'GoogleOAuthClientId', { value: googleWebClientId });
  }
}
