# Driftless — backend

AWS serverless backend for [Driftless](https://github.com/Siddiq3/driftless), plus the shared
contracts package the app consumes. Product docs, architecture and decisions live in the app repo's
`docs/` folder (see D-016 for the repo split).

| Path | What |
|---|---|
| `packages/contracts` | `@siddiq3/driftless-contracts` — zod v1 API schemas, OpenAPI, and `./domain` (dates, goals, streaks, Wick, reference view-counting rule). Published to GitHub Packages. |
| `services/api` | Lambda HTTP API (Node 22, JavaScript ESM) |
| `serverless.yml` | AWS resources and deployment configuration — production deploys automatically after main-branch checks pass |

## Automatic AWS deployment

Push or merge to `main` → GitHub Actions checks → deploy `driftless-api-prod` → check API readiness and authentication.
No local Docker, database server, AWS CLI or deployment commands are required. GitHub runs the temporary test database and Serverless Framework for you.

One-time setup: create the GitHub environment `prod`, add AWS/Google configuration, and grant the deployment identity access to AWS. See [Deployment setup](docs/DEPLOYMENT.md) for exact variable/secret names, AWS authentication options and where to find the API URL. Workflow files must be committed and pushed before this automation is active.

## Develop

```sh
pnpm install
pnpm build && pnpm lint && pnpm typecheck
docker run -d -p 8000:8000 amazon/dynamodb-local
DDB_ENDPOINT=http://localhost:8000 pnpm test
GOOGLE_WEB_CLIENT_ID=YOUR_WEB_CLIENT_ID.apps.googleusercontent.com pnpm package:aws --stage prod
```

The API source, tests and Vitest configuration in `services/api` use JavaScript ESM. Its build bundles JavaScript for Lambda. `pnpm typecheck` checks the shared TypeScript contracts consumed by the mobile app; API validation runs through lint, build and integration tests. Runtime request validation still uses the shared Zod schemas.

## Releasing the contracts package

1. Bump `version` in `packages/contracts/package.json` (semver; breaking schema change = major).
2. Merge to `main`. The `publish-contracts` workflow builds, tests, publishes to GitHub Packages
   and tags the commit `contracts-v<version>`. Versions already published are skipped.
3. In the app repo, bump `@siddiq3/driftless-contracts` to the new version.

CI publishes step logs for each push to `main` to the `ci-results` branch.

## Google-only account authentication

The API accepts Google ID tokens directly through API Gateway's Google JWT authorizer. No Cognito pool or Hosted UI is provisioned. Set `GOOGLE_WEB_CLIENT_ID` for Serverless deployment (the GitHub `prod` environment variable for automatic deploys); the Android app must use the same Web OAuth client ID.

See the app's `docs/GOOGLE_SIGN_IN.md` for OAuth/signing-certificate setup, identity mapping, account-deletion behavior and migration considerations. Existing Cognito IDs are not automatically linked to Google subjects. No deployment was performed as part of this change.

Daily/weekly recaps are served by `GET /v1/wrapped?period=daily|weekly&end=YYYY-MM-DD`. This read-only route requires Google auth and cloud-sync consent, derives totals and previous-period comparison from the caller's existing day aggregates, and preserves missing days as unknown. Session/hourly details remain local to the app; no new table or raw event upload is needed. Shared contracts are version 0.4.0; publish/link that version before installing the matching app dependency.
