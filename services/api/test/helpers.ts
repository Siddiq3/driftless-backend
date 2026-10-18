import { randomUUID } from 'node:crypto';
import type { ApiEvent, ApiResult } from '../src/lib/http.js';

process.env.TABLE_NAME ??= 'driftless-test';

export const newSub = () => randomUUID();

type EventOpts = {
  method?: string;
  path: string;
  sub?: string | null;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  claims?: Record<string, string | number>;
};

export function event(o: EventOpts): ApiEvent {
  const body = o.rawBody ?? (o.body === undefined ? undefined : JSON.stringify(o.body));
  const claims =
    o.sub === null
      ? undefined
      : {
          sub: o.sub ?? newSub(),
          token_use: 'access',
          auth_time: Math.floor(Date.now() / 1000),
          ...o.claims,
        };
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: o.path,
    rawQueryString: '',
    headers: { 'content-type': 'application/json', ...o.headers },
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
  } as unknown as ApiEvent;
}

export function bodyOf<T = Record<string, unknown>>(r: ApiResult): T {
  return JSON.parse(r.body ?? 'null') as T;
}
