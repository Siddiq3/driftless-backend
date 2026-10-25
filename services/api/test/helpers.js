import { randomBytes, randomUUID } from 'node:crypto';
import { googleUserId } from '../src/lib/auth.js';
process.env.TABLE_NAME ??= 'driftless-test';
process.env.GOOGLE_WEB_CLIENT_ID ??= 'test-web.apps.googleusercontent.com';
// Test callers use contract UUIDs; Gateway fixtures contain their actual Google subjects.
const subjects = new Map();
const incarnations = new Map();
export const ownerOf = (sub) => incarnations.get(sub) ?? sub;
export async function newAccount() {
  const sub = newSub();
  const { route } = await import('../src/router.js');
  const response = await route(
    event({
      method: 'POST',
      path: '/v1/account/register',
      sub,
      body: { registrationId: randomUUID(), expectedIncarnation: null },
    }),
  );
  if (response.statusCode !== 200) throw new Error(`Fixture registration failed: ${response.body}`);
  incarnations.set(sub, bodyOf(response).incarnation);
  return sub;
}
export async function newOwner() {
  return ownerOf(await newAccount());
}
export const newSub = () => {
  const googleSub = BigInt('0x' + randomBytes(9).toString('hex')).toString();
  const id = googleUserId(googleSub);
  subjects.set(id, googleSub);
  return id;
};
export function event(o) {
  const body = o.rawBody ?? (o.body === undefined ? undefined : JSON.stringify(o.body));
  const callerSub = o.sub ?? newSub();
  const claims =
    o.sub === null
      ? undefined
      : {
          sub: subjects.get(callerSub) ?? callerSub,
          iss: 'https://accounts.google.com',
          aud: process.env.GOOGLE_WEB_CLIENT_ID,
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 3600,
          ...o.claims,
        };
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: o.path,
    rawQueryString: '',
    headers: {
      'content-type': 'application/json',
      ...(incarnations.has(callerSub) ? { 'x-account-incarnation': ownerOf(callerSub) } : {}),
      ...o.headers,
    },
    queryStringParameters: o.query,
    body,
    isBase64Encoded: false,
    requestContext: {
      accountId: 'test',
      apiId: 'test',
      domainName: 'test',
      domainPrefix: 'test',
      http: {
        method: o.method ?? 'GET',
        path: o.path,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 't',
      },
      requestId: randomUUID(),
      routeKey: '$default',
      stage: '$default',
      time: '',
      timeEpoch: Date.now(),
      authorizer: claims
        ? { principalId: '', integrationLatency: 0, jwt: { claims, scopes: [] } }
        : undefined,
    },
  };
}
export function bodyOf(r) {
  return JSON.parse(r.body ?? 'null');
}
