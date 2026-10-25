import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { v1 } from '@siddiq3/driftless-contracts';
import { ddb, Keys, tableName } from '../src/lib/ddb.js';
import { route } from '../src/router.js';
import { bodyOf, event, newAccount, ownerOf } from './helpers.js';
const getMe = (sub, query) => route(event({ path: '/v1/me', sub, query }));
const patch = (sub, body, rev = 1, extra = {}) =>
  route(
    event({
      method: 'PATCH',
      path: '/v1/me',
      sub,
      body,
      headers: { ...(rev === null ? {} : { 'if-match': `"${rev}"` }), ...extra },
    }),
  );
describe('authentication', () => {
  it('401 without verified claims', async () => {
    const r = await route(event({ path: '/v1/me', sub: null }));
    expect(r.statusCode).toBe(401);
    expect(r.headers?.['content-type']).toBe('application/problem+json');
  });
  it('401 for a malformed sub', async () => {
    expect((await route(event({ path: '/v1/me', sub: 'invalid/subject' }))).statusCode).toBe(401);
  });
  it('401 for a Cognito token even when passed in verified-claim fixtures', async () => {
    expect((await route(event({ path: '/v1/me', claims: { token_use: 'id' } }))).statusCode).toBe(
      401,
    );
  });
  it('unknown routes are 401 before auth and 404 after (no route enumeration)', async () => {
    expect((await route(event({ path: '/v1/nope', sub: null }))).statusCode).toBe(401);
    expect((await route(event({ path: '/v1/nope' }))).statusCode).toBe(404);
  });
});
describe('GET /v1/me', () => {
  it('reads the private default profile after explicit registration and validates against the contract', async () => {
    const sub = await newAccount();
    const r = await getMe(sub);
    expect(r.statusCode).toBe(200);
    const body = v1.MeResponse.parse(bodyOf(r));
    expect(body.userId).toBe(sub);
    expect(body.profile).toMatchObject({
      handle: null,
      rev: 1,
      consent: { cloudSync: false, shareWithFriends: false },
    });
    expect(body.entitlement.tier).toBe('free');
    expect(r.headers?.etag).toBe('"1"');
    expect(r.headers?.['cache-control']).toBe('no-store');
  });
  it('advertises no capabilities in Phase 1 (nothing verified yet)', async () => {
    const body = v1.MeResponse.parse(
      bodyOf(await getMe(await newAccount(), { platform: 'android', appVersion: '0.1.0' })),
    );
    expect(Object.values(body.capabilities).filter(Boolean)).toEqual([true]); // only socialSharingOfUsage
    expect(body.capabilities.socialSharingOfUsage).toBe(true);
  });
  it('never allows iOS usage sharing', async () => {
    const body = v1.MeResponse.parse(
      bodyOf(await getMe(await newAccount(), { platform: 'ios', appVersion: '0.1.0' })),
    );
    expect(body.capabilities.socialSharingOfUsage).toBe(false);
    expect(body.capabilities.videoCounting).toBe(false);
  });
  it('rejects bad client info', async () => {
    expect(
      (await getMe(await newAccount(), { platform: 'windows', appVersion: '1.0.0' })).statusCode,
    ).toBe(400);
  });
  it('treats an expired Pro record as free', async () => {
    const sub = await newAccount();
    await ddb().send(
      new PutCommand({
        TableName: tableName(),
        Item: {
          pk: Keys.user(ownerOf(sub)),
          sk: Keys.entitlement,
          tier: 'pro',
          source: 'play',
          state: 'active',
          expiresAt: '2020-01-01T00:00:00.000Z',
          verifiedAt: '2020-01-01T00:00:00.000Z',
        },
      }),
    );
    const body = v1.MeResponse.parse(bodyOf(await getMe(sub)));
    expect(body.entitlement).toMatchObject({ tier: 'free', state: 'expired' });
  });
});
describe('PATCH /v1/me', () => {
  it('updates fields and bumps rev', async () => {
    const sub = await newAccount();
    await getMe(sub);
    const r = await patch(sub, { displayName: 'Siddiq', tz: 'Asia/Kolkata' });
    expect(r.statusCode).toBe(200);
    const body = v1.MeResponse.parse(bodyOf(r));
    expect(body.profile).toMatchObject({ displayName: 'Siddiq', tz: 'Asia/Kolkata', rev: 2 });
    expect(v1.MeResponse.parse(bodyOf(await getMe(sub))).profile.rev).toBe(2);
  });
  it('428 without If-Match, 412 on a stale rev', async () => {
    const sub = await newAccount();
    await getMe(sub);
    expect((await patch(sub, { displayName: 'A' }, null)).statusCode).toBe(428);
    expect((await patch(sub, { displayName: 'A' }, 7)).statusCode).toBe(412);
    expect((await patch(sub, { displayName: 'A' }, 1)).statusCode).toBe(200);
    expect((await patch(sub, { displayName: 'B' }, 1)).statusCode).toBe(412); // replay of old rev
  });
  it('cannot set entitlement or unknown fields (no client-supplied Pro)', async () => {
    const sub = await newAccount();
    await getMe(sub);
    const r = await patch(sub, { tier: 'pro' });
    expect(r.statusCode).toBe(400);
    expect(v1.MeResponse.parse(bodyOf(await getMe(sub))).entitlement.tier).toBe('free');
  });
  it("one user's update never touches another user's profile", async () => {
    const a = await newAccount();
    const b = await newAccount();
    await getMe(a);
    await getMe(b);
    await patch(b, { displayName: 'Bee' });
    const aBody = v1.MeResponse.parse(bodyOf(await getMe(a)));
    expect(aBody.profile.displayName).toBeNull();
    expect(aBody.userId).toBe(a);
  });
  it('a userId in the body is rejected, not honoured', async () => {
    const a = await newAccount();
    const b = await newAccount();
    await getMe(a);
    expect((await patch(b, { displayName: 'x', userId: a })).statusCode).toBe(400);
  });
  it('handles are unique; changing a handle frees the old one', async () => {
    const a = await newAccount();
    const b = await newAccount();
    await getMe(a);
    await getMe(b);
    const h = `u${a.replace(/-/g, '').slice(0, 12)}`;
    const h2 = `v${a.replace(/-/g, '').slice(0, 12)}`;
    expect((await patch(a, { handle: h })).statusCode).toBe(200);
    const taken = await patch(b, { handle: h });
    expect(taken.statusCode).toBe(409);
    expect(bodyOf(taken).code).toBe('handle_taken');
    expect((await patch(a, { handle: h2 }, 2)).statusCode).toBe(200);
    expect((await patch(b, { handle: h })).statusCode).toBe(200);
  });
  it('shareWithFriends requires cloudSync', async () => {
    const sub = await newAccount();
    await getMe(sub);
    expect((await patch(sub, { consent: { shareWithFriends: true } })).statusCode).toBe(400);
    expect(
      (await patch(sub, { consent: { cloudSync: true, shareWithFriends: true } })).statusCode,
    ).toBe(200);
  });
  it('rejects oversized, non-JSON and malformed bodies', async () => {
    const sub = await newAccount();
    await getMe(sub);
    const big = await route(
      event({
        method: 'PATCH',
        path: '/v1/me',
        sub,
        rawBody: 'x'.repeat(33 * 1024),
        headers: { 'if-match': '1' },
      }),
    );
    expect(big.statusCode).toBe(413);
    const text = await patch(sub, { displayName: 'a' }, 1, { 'content-type': 'text/plain' });
    expect(text.statusCode).toBe(415);
    const bad = await route(
      event({
        method: 'PATCH',
        path: '/v1/me',
        sub,
        rawBody: '{nope',
        headers: { 'if-match': '1' },
      }),
    );
    expect(bad.statusCode).toBe(400);
  });
});
