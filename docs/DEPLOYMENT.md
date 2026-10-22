# Push-to-main AWS deployment

The backend uses GitHub Actions in `.github/workflows/ci.yml`. A push or merge to `main` runs checks, then deploys **driftless-api-prod** to AWS. You do not need Docker, an AWS CLI, CDK or a local database on your computer. GitHub hosts the temporary integration-test database; production is API Gateway + Lambda + DynamoDB, not a Docker service. API handlers, application modules, tests and build configuration use JavaScript ESM. The shared contracts package remains TypeScript for the mobile app.

This follows the ecommerce backend's test → deploy → smoke-check flow, using `serverless.yml` and Serverless Framework v3, like ecommerce. Unlike that repository's current manual trigger, Driftless has automatic main-branch deployment. Manual reruns on `main` are also available through Actions → **ci** → **Run workflow**.

## One-time GitHub setup

Open **Siddiq3/driftless-backend → Settings → Environments → New environment**, named exactly **prod**. Restrict its deployment branches to **main**. Leave required reviewers disabled if pushes should deploy without manual approval. Repository/organization approval policies may still apply.

Under that environment, add these **variables**:

| Name | Value |
| --- | --- |
| `AWS_ACCOUNT_ID` | Your intended 12-digit AWS account ID |
| `AWS_REGION` | `ap-south-1`, or your selected region |
| `GOOGLE_WEB_CLIENT_ID` | The Web OAuth client ID ending in `.apps.googleusercontent.com`, matching the Android app |

Choose one AWS authentication method below. Never paste AWS secrets into chat, source files, commit messages or workflow YAML.

### Same credential setup as ecommerce

Add **environment secrets**:

| Name | Value |
| --- | --- |
| `AWS_ACCESS_KEY_ID` | Access key for your AWS deployment IAM identity |
| `AWS_SECRET_ACCESS_KEY` | Its matching secret access key |
| `AWS_SESSION_TOKEN` | Only when using temporary session credentials; omit for ordinary IAM access keys |

Leave the `AWS_ROLE_ARN` variable unset. Use a deployment identity with permission to provision the resources in `serverless.yml`. Do not use AWS root access keys. The workflow checks that credentials belong to `AWS_ACCOUNT_ID` before deployment.

### Alternatively: temporary credentials through OIDC

Add the variable `AWS_ROLE_ARN` with an AWS IAM role ARN in the same account. Access-key secrets are then unnecessary. The workflow requests GitHub's OIDC token and assumes this role.

In AWS IAM, add or reuse the OIDC provider `https://token.actions.githubusercontent.com`, audience `sts.amazonaws.com`. The role's trust policy should restrict the audience and this exact repository/environment, replacing `YOUR_AWS_ACCOUNT_ID`:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {
      "Federated": "arn:aws:iam::YOUR_AWS_ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"
    },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        "token.actions.githubusercontent.com:sub": "repo:Siddiq3/driftless-backend:environment:prod"
      }
    }
  }]
}
```

Because the job uses a GitHub environment, the OIDC subject names `environment:prod`, not `ref:refs/heads/main`. The environment's branch restriction and the workflow's main-branch condition enforce the branch boundary. See [GitHub's AWS OIDC documentation](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws).

## AWS permissions and first deployment

An AWS administrator must grant the deployment identity provisioning permissions once. A role trust policy alone does not grant those permissions. Serverless needs CloudFormation, S3 deployment artifacts, IAM/pass-role, Lambda, API Gateway, DynamoDB, Secrets Manager, EventBridge and CloudWatch/Logs permissions for the resources declared in `serverless.yml`. Lambda execution permissions are scoped separately to this stack's table/index and billing secret.

No CDK bootstrap or Docker production container is involved. Serverless creates an encrypted, private S3 deployment bucket and the CloudFormation stack `driftless-api-prod`. Keep the account, region, stage and service name fixed once production contains data. The database has point-in-time recovery, production deletion protection and retain-on-delete/replace policies. After deployment, the workflow enables CloudFormation termination protection on the production stack. The workflow never runs `serverless remove` or clears data to recover from a failed deployment.

Serverless is pinned to v3 to match ecommerce. Its runtime schema predates Node 22, so `resources.extensions` explicitly sets both generated Lambda resources to `nodejs22.x`; generated-template checks verify the deployed runtime. The provider's Node 20 schema value is overridden before deployment. See [Serverless resource overrides](https://www.serverless.com/framework/docs/providers/aws/guide/resources).

### Existing CDK deployment

The production workflow checks for the legacy `Driftless-prod` stack in the target account/region and stops if it exists. It also stops if that check fails due to missing permissions or a network error. This change does not migrate deployed resources or data automatically. Do not delete the old stack to bypass this check: a fresh Serverless stack would have a different table and API URL. A deployed CDK installation needs a reviewed CloudFormation resource-import/data migration and traffic cutover before enabling this deployment. The old resources remain untouched by this workflow.

For a new installation with no CDK production stack, deployment proceeds automatically. CDK source and dependencies have been removed from this repository.

Once settings exist and this workflow is on `main`, push any backend change or select **Run workflow** on `main`. GitHub performs:

1. Frozen-lockfile dependency installation, build, formatting, lint, typecheck, deployment-helper tests, contract/API tests, package checks, Serverless packaging and generated-template tests and secret scanning.
2. A fresh Lambda bundle from that same commit. AWS credentials are configured only after dependency installation/build.
3. Account validation, a legacy-stack safety check, then `serverless deploy --stage prod`.
4. Readiness check: public `GET /health` must return `200` and `{"ok":true}`. This tests API/Lambda execution and a read of a reserved DynamoDB key without exposing or creating user records.
5. Auth check: `GET /v1/me` without a token must return `401`.

The production job waits for the test job and never runs on pull requests or other branches. Deployments are serialized; main-branch pushes do not interrupt a CloudFormation update already running. A failed smoke check marks deployment red but does not automatically roll back an otherwise completed stack update. The probes do not substitute for a real Android Google login, cloud-backup and account-isolation check.

## Find and use the API URL

Open **Actions → ci → the completed run → Summary**. The production job writes the API base URL there and uploads `deployment-prod-<commit>` containing `deployment-outputs.json`. Confirm the deployment and smoke steps are green.

In the **mobile repository**, set public build configuration:

```dotenv
EXPO_PUBLIC_API_URL=https://YOUR_API_ID.execute-api.ap-south-1.amazonaws.com
EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=YOUR_WEB_CLIENT_ID.apps.googleusercontent.com
```

Do not append `/v1`. Build the Android app with those values. Backend deployment does not build or distribute the mobile app. Configure Google's Android OAuth client for `com.siddiqkolimi.driftless` and the relevant signing certificates; see the app's `docs/GOOGLE_SIGN_IN.md`.

## What is and is not enabled

Subscriptions are not required for implemented features. Leave Google Play service-account/RTDN billing configuration unset until billing is deliberately reintroduced; the current infrastructure still provisions its billing resources. Rollout/accuracy gates are separate and remain unchanged. No seed users, database import, Cognito pool or Firebase Authentication setup is required. First authenticated use creates a profile. Cloud backup and friend sharing remain explicit preferences.

Deploying does not implement the pending guest-to-account data migration or certify the mobile release. Existing accounts are never linked by email. Contract publication and mobile release remain separate workflows.

## Troubleshooting

| Failure | Check |
| --- | --- |
| Configuration step lists missing settings | Add variables/secrets to `prod`, using the exact names above. Values are not printed. |
| AWS account mismatch | Correct `AWS_ACCOUNT_ID` or the deployment identity; do not change the expected account just to bypass the check. |
| OIDC assumption denied | Check the provider, role trust audience, exact repository/environment subject and main-only environment rule. |
| Deployment AccessDenied | Have the AWS administrator grant provisioning permissions for the resources in `serverless.yml`, including `iam:PassRole`. |
| Existing CDK stack detected | Follow the migration note above; do not delete the old stack or data to bypass the guard. |
| Checks fail | Open the failing step or download `logs-node`; no deployment occurs. Existing CI also publishes main-push test logs to `ci-results`. |
| CloudFormation fails | Inspect the failed stack event and correct its cause before rerunning. Do not delete retained production tables. |
| Health fails | Inspect the API Lambda logs in CloudWatch. A `503` means its readiness read failed; no internal database details are returned. |
| Google sign-in fails | Match the Web client ID across GitHub variables and the app, and register the app's signing certificate SHA-1 in Google Cloud. |

Automation becomes active after these source changes are pushed. Provisioning AWS identities, configuring GitHub settings and the first live deployment are external setup steps; writing this workflow does not perform them.
