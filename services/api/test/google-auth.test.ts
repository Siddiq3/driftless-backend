import { afterEach, describe, expect, it, vi } from 'vitest';
import { v1 } from '@siddiq3/driftless-contracts';
import { googleUserId, requireCaller, requireRecentAuth } from '../src/lib/auth.js';
import { event } from './helpers.js';

afterEach(() => vi.unstubAllEnvs());
describe('verified Google identity', () => {
  it('maps Google subjects to stable contract UUIDs without using email', () => {
    const sub = '100000000000000000001';
    const e = event({ path: '/v1/me', sub });
    const first = requireCaller(e);
    expect(first.sub).toBe('78ed776f-d9db-5af0-ab39-89b16ff51bc8');
    expect(first.sub).toBe(googleUserId(sub));
    expect(v1.FriendRemove.shape.userId.safeParse(first.sub).success).toBe(true);
    expect(
      requireCaller(event({ path: '/v1/me', sub, claims: { email: 'changed@example.test' } })).sub,
    ).toBe(first.sub);
    expect(googleUserId('100000000000000000002')).not.toBe(first.sub);
    expect(googleUserId('ABC')).not.toBe(googleUserId('abc'));
  });
  it.each<Record<string, string | number>>([
    { iss: 'https://cognito-idp.ap-south-1.amazonaws.com/old-pool' },
    { aud: 'another-client.apps.googleusercontent.com' },
    { token_use: 'access' },
    { exp: 1 },
    { sub: '' },
    { iat: 0 },
    { iat: 'not-a-time' },
    { iat: Math.floor(Date.now() / 1000) + 3600 },
  ])('rejects invalid or non-Google claims: %j', (claims) => {
    expect(() => requireCaller(event({ path: '/v1/me', claims }))).toThrow(
      'authentication required',
    );
  });
  it('fails closed when the server audience is not configured', () => {
    const e = event({ path: '/v1/me' });
    vi.stubEnv('GOOGLE_WEB_CLIENT_ID', '');
    expect(() => requireCaller(e)).toThrow();
  });
  it('rejects body tokens without verified Gateway claims', () => {
    expect(() =>
      requireCaller(event({ path: '/v1/me', sub: null, body: { sub: '100000000000000000001' } })),
    ).toThrow();
  });
  it('uses Google credential issuance for the delete freshness gate and rejects future times', () => {
    const now = Math.floor(Date.now() / 1000);
    const caller = requireCaller(event({ path: '/v1/account/delete', claims: { iat: now - 301 } }));
    expect(() => requireRecentAuth(caller, now)).toThrow();
    expect(() => requireRecentAuth({ ...caller, authTime: now }, now)).not.toThrow();
    expect(() => requireRecentAuth({ ...caller, authTime: now + 120 }, now)).toThrow();
  });
});
