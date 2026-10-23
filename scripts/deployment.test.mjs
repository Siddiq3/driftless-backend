import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { apiUrlFromOutputs, smoke, validateConfig } from './deployment.mjs';

const config = {
  AWS_REGION: 'ap-south-1',
  GOOGLE_WEB_CLIENT_ID: 'test-web.apps.googleusercontent.com',
  AWS_ROLE_ARN: 'arn:aws:iam::123456789012:role/driftless-deploy',
};
const url = 'https://example123.execute-api.ap-south-1.amazonaws.com';
const reply = (status, ok) => ({ status, json: async () => ({ ok }) });

test('accepts OIDC or ecommerce-style keys without a separate account ID', () => {
  assert.doesNotThrow(() => validateConfig(config));
  assert.doesNotThrow(() =>
    validateConfig({
      ...config,
      AWS_ROLE_ARN: '',
      AWS_ACCESS_KEY_ID: 'example',
      AWS_SECRET_ACCESS_KEY: 'example',
    }),
  );
});
test('rejects missing settings, incomplete keys and malformed role ARNs', () => {
  assert.throws(() => validateConfig({}), /AWS_REGION/);
  assert.throws(
    () => validateConfig({ ...config, AWS_ROLE_ARN: '', AWS_ACCESS_KEY_ID: 'example' }),
    /both AWS_ACCESS_KEY_ID/,
  );
  assert.throws(
    () => validateConfig({ ...config, AWS_ROLE_ARN: 'arn:aws:iam::invalid:role/deploy' }),
    /valid IAM role ARN/,
  );
  assert.throws(() => validateConfig({ ...config, GOOGLE_WEB_CLIENT_ID: 'wrong' }), /Web OAuth/);
});
test('reads only the production HTTPS API URL and rejects output injection', () => {
  assert.equal(apiUrlFromOutputs([{ OutputKey: 'ApiUrl', OutputValue: `${url}/` }]), url);
  assert.throws(() => apiUrlFromOutputs([{ OutputKey: 'OtherOutput', OutputValue: url }]));
  assert.throws(() =>
    apiUrlFromOutputs([{ OutputKey: 'ApiUrl', OutputValue: `${url}\ninjected=1` }]),
  );
});
test('checks database readiness and protected-route authentication', async () => {
  const requests = [];
  await smoke(url, {
    fetchImpl: async (target) => {
      requests.push(target);
      return target.endsWith('/health') ? reply(200, true) : reply(401);
    },
  });
  assert.deepEqual(requests, [`${url}/health`, `${url}/v1/me?platform=android&appVersion=0.1.0`]);
});
test('retries transient startup failures', async () => {
  let calls = 0;
  await smoke(url, {
    wait: async () => {},
    fetchImpl: async (target) => {
      if (++calls === 1) throw new Error('network');
      return target.endsWith('/health') ? reply(200, true) : reply(401);
    },
  });
  assert.equal(calls, 3);
});
test('fails the deployment for unhealthy APIs or unprotected application routes', async () => {
  await assert.rejects(
    smoke(url, { attempts: 1, fetchImpl: async () => reply(503, false) }),
    /503/,
  );
  await assert.rejects(
    smoke(url, { attempts: 1, fetchImpl: async () => reply(200, true) }),
    /Expected.*401/,
  );
});

test('legacy-stack guard allows only a confirmed absent stack, failing closed on AWS errors', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'driftless-guard-'));
  try {
    const run = (script) => {
      writeFileSync(join(dir, 'aws'), `#!/bin/sh\n${script}\n`, { mode: 0o700 });
      return spawnSync('bash', ['scripts/check-legacy-stack.sh'], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
        encoding: 'utf8',
      });
    };
    assert.equal(run('echo existing-stack; exit 0').status, 1);
    assert.equal(
      run(
        'echo "An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id Driftless-prod does not exist" >&2; exit 254',
      ).status,
      0,
    );
    assert.equal(run('echo AccessDenied >&2; exit 254').status, 1);
    assert.equal(run('echo "Could not connect to endpoint" >&2; exit 255').status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
