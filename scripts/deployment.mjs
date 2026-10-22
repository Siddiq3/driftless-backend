import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function validateConfig(env) {
  const errors = [];
  if (!/^\d{12}$/.test(env.AWS_ACCOUNT_ID ?? ''))
    errors.push('AWS_ACCOUNT_ID must contain 12 digits');
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(env.AWS_REGION ?? '')) errors.push('AWS_REGION is invalid');
  if (!/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(env.GOOGLE_WEB_CLIENT_ID ?? ''))
    errors.push('GOOGLE_WEB_CLIENT_ID must be your Google Web OAuth client ID');
  if (env.AWS_ROLE_ARN) {
    if (
      !new RegExp(`^arn:aws:iam::${env.AWS_ACCOUNT_ID}:role/[A-Za-z0-9_+=,.@/-]+$`).test(
        env.AWS_ROLE_ARN,
      )
    )
      errors.push('AWS_ROLE_ARN must identify a role in AWS_ACCOUNT_ID');
  } else if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
    errors.push(
      'Set AWS_ROLE_ARN for OIDC, or both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY secrets',
    );
  }
  if (errors.length) throw new Error(errors.join('\n'));
}

export function apiUrlFromOutputs(outputs) {
  const url = Array.isArray(outputs)
    ? outputs.find((item) => item.OutputKey === 'ApiUrl')?.OutputValue
    : undefined;
  if (
    typeof url !== 'string' ||
    !/^https:\/\/[a-z0-9]+\.execute-api\.[a-z0-9-]+\.amazonaws\.com\/?$/.test(url)
  )
    throw new Error('CloudFormation ApiUrl is missing or is not an API Gateway HTTPS endpoint');
  return url.replace(/\/$/, '');
}

export async function smoke(
  apiUrl,
  {
    fetchImpl = fetch,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    attempts = 6,
  } = {},
) {
  // Revalidate before using a URL in requests or the GitHub summary.
  const base = apiUrlFromOutputs([{ OutputKey: 'ApiUrl', OutputValue: apiUrl }]);
  let last = 'No response';
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetchImpl(`${base}/health`, {
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
      });
      const body = await response.json();
      if (response.status !== 200 || body.ok !== true)
        throw new Error(`Readiness returned HTTP ${response.status}`);
      const protectedResponse = await fetchImpl(`${base}/v1/me?platform=android&appVersion=0.1.0`, {
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
      });
      if (protectedResponse.status !== 401)
        throw new Error(
          `Expected unauthenticated profile to return 401, got ${protectedResponse.status}`,
        );
      return;
    } catch (error) {
      last = error instanceof Error ? error.message : 'Network failure';
      if (i < attempts - 1) await wait(5_000);
    }
  }
  throw new Error(`Deployment smoke check failed: ${last}`);
}

async function main() {
  switch (process.argv[2]) {
    case 'check-config':
      validateConfig(process.env);
      console.log('Deployment configuration is complete.');
      break;
    case 'outputs': {
      const url = apiUrlFromOutputs(JSON.parse(readFileSync(process.argv[3], 'utf8')));
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `api_url=${url}\n`);
      if (process.env.GITHUB_STEP_SUMMARY)
        appendFileSync(
          process.env.GITHUB_STEP_SUMMARY,
          `### Driftless production\n\nAPI URL: ${url}\n\nUse this base URL in EXPO_PUBLIC_API_URL (without /v1).\n\nThe next step verifies readiness and authentication; consult its result before using this deployment.\n`,
        );
      console.log(`API URL: ${url}`);
      break;
    }
    case 'smoke':
      await smoke(process.env.API_URL);
      console.log('Passed: GET /health is ready; unauthenticated GET /v1/me returns 401.');
      if (process.env.GITHUB_STEP_SUMMARY)
        appendFileSync(
          process.env.GITHUB_STEP_SUMMARY,
          '\nReadiness and authentication smoke checks passed.\n',
        );
      break;
    default:
      throw new Error('Usage: node scripts/deployment.mjs check-config | outputs <file> | smoke');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
