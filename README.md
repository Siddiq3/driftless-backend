# Driftless — backend

AWS serverless backend for [Driftless](https://github.com/Siddiq3/driftless), plus the shared
contracts package the app consumes. Product docs, architecture and decisions live in the app repo's
`docs/` folder (see D-016 for the repo split).

| Path | What |
|---|---|
| `packages/contracts` | `@siddiq3/driftless-contracts` — zod v1 API schemas, OpenAPI, and `./domain` (dates, goals, streaks, Wick, reference view-counting rule). Published to GitHub Packages. |
| `services/api` | Lambda HTTP API (Node 22, TypeScript) |
| `infra` | AWS CDK app — synth only; nothing is deployed without an explicit owner decision |

## Develop

```sh
pnpm install
pnpm build && pnpm lint && pnpm typecheck
docker run -d -p 8000:8000 amazon/dynamodb-local
DDB_ENDPOINT=http://localhost:8000 pnpm test
pnpm --filter @driftless/infra synth
```

## Releasing the contracts package

1. Bump `version` in `packages/contracts/package.json` (semver; breaking schema change = major).
2. Merge to `main`. The `publish-contracts` workflow builds, tests, publishes to GitHub Packages
   and tags the commit `contracts-v<version>`. Versions already published are skipped.
3. In the app repo, bump `@siddiq3/driftless-contracts` to the new version.

CI publishes step logs for each push to `main` to the `ci-results` branch.
