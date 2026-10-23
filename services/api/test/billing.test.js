import { createVerify, generateKeyPairSync, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { v1 } from '@siddiq3/driftless-contracts';
import { setBillingDeps } from '../src/modules/billing/index.js';
import { serviceAccountAssertion } from '../src/modules/billing/play-api.js';
import { entitlementFromPlay, obfuscatedAccountId } from '../src/modules/billing/play-state.js';
import { route } from '../src/router.js';
import { bodyOf, event, newSub } from './helpers.js';
const PRO = new Set(['driftless_pro']);
const NOW = Date.parse('2026-10-18T12:00:00Z');
const future = new Date(Date.now() + 30 * 86_400_000).toISOString();
const past = new Date(Date.now() - 86_400_000).toISOString();
const SA = 'rtdn-push@driftless.iam.gserviceaccount.com';
const subscription = (sub, over = {}) => ({
  subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
  lineItems: [{ productId: 'driftless_pro', expiryTime: future }],
  acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
  externalAccountIdentifiers: { obfuscatedExternalAccountId: obfuscatedAccountId(sub) },
  ...over,
});
class FakePlay {
  subs = new Map();
  acked = [];
  async getSubscription(_pkg, token) {
    return this.subs.get(token) ?? null;
  }
  async acknowledge(_pkg, _product, token) {
    this.acked.push(token);
  }
}
let play;
beforeEach(() => {
  play = new FakePlay();
  setBillingDeps({
    play,
    config: {
      packageName: 'com.siddiqkolimi.scrollsnooze',
      proProducts: PRO,
      rtdnAudience: 'aud',
      rtdnServiceAccount: SA,
    },
    verifier: {
      verify: async (t) => {
        if (t === 'good') return { email: SA, email_verified: true };
        if (t === 'other') return { email: 'someone@else.com', email_verified: true };
        throw new Error('bad signature');
      },
    },
  });
});
const verify = (sub, purchaseToken, productId = 'driftless_pro') =>
  route(
    event({
      method: 'POST',
      path: '/v1/billing/play/verify',
      sub,
      body: { productId, purchaseToken },
    }),
  );
const me = async (sub) => v1.MeResponse.parse(bodyOf(await route(event({ path: '/v1/me', sub }))));
const rtdn = (bearer, body) =>
  route(
    event({
      method: 'POST',
      path: '/webhooks/play-rtdn',
      sub: null,
      body,
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    }),
  );
const push = (n, messageId = randomUUID()) => ({
  message: { messageId, data: Buffer.from(JSON.stringify(n)).toString('base64') },
  subscription: 'projects/p/subscriptions/s',
});
describe('entitlementFromPlay (pure)', () => {
  const s = (state, expiry = '2026-11-18T00:00:00Z') => ({
    subscriptionState: state,
    lineItems: [{ productId: 'driftless_pro', expiryTime: expiry }],
  });
  it.each([
    ['SUBSCRIPTION_STATE_ACTIVE', 'pro', 'active'],
    ['SUBSCRIPTION_STATE_CANCELED', 'pro', 'active'], // won't renew, access until expiry
    ['SUBSCRIPTION_STATE_IN_GRACE_PERIOD', 'pro', 'grace'],
    ['SUBSCRIPTION_STATE_ON_HOLD', 'free', 'on_hold'],
    ['SUBSCRIPTION_STATE_PAUSED', 'free', 'paused'],
    ['SUBSCRIPTION_STATE_EXPIRED', 'free', 'expired'],
    ['SUBSCRIPTION_STATE_PENDING', 'free', 'none'],
  ])('%s → %s/%s', (state, tier, st) => {
    expect(entitlementFromPlay(s(state), PRO, NOW)).toMatchObject({
      tier,
      state: st,
      source: 'play',
    });
  });
  it('active or canceled past expiry is free', () => {
    expect(
      entitlementFromPlay(s('SUBSCRIPTION_STATE_ACTIVE', '2026-10-01T00:00:00Z'), PRO, NOW).tier,
    ).toBe('free');
    expect(
      entitlementFromPlay(s('SUBSCRIPTION_STATE_CANCELED', '2026-10-01T00:00:00Z'), PRO, NOW).tier,
    ).toBe('free');
  });
  it('ignores line items for other products', () => {
    const x = {
      subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
      lineItems: [{ productId: 'other', expiryTime: future }],
    };
    expect(entitlementFromPlay(x, PRO, NOW).tier).toBe('free');
  });
});
describe('POST /v1/billing/play/verify', () => {
  it('server-verifies, grants Pro, acknowledges, and /v1/me reflects it', async () => {
    const sub = newSub();
    play.subs.set('tok-1-purchase-token', subscription(sub));
    const r = await verify(sub, 'tok-1-purchase-token');
    expect(r.statusCode).toBe(200);
    expect(v1.VerifyResponse.parse(bodyOf(r)).entitlement).toMatchObject({
      tier: 'pro',
      state: 'active',
    });
    expect(play.acked).toEqual(['tok-1-purchase-token']);
    expect((await me(sub)).entitlement.tier).toBe('pro');
  });
  it('rejects a purchase made for another account (token theft)', async () => {
    const owner = newSub();
    const thief = newSub();
    play.subs.set('tok-2-purchase-token', subscription(owner));
    const r = await verify(thief, 'tok-2-purchase-token');
    expect(r.statusCode).toBe(403);
    expect(bodyOf(r).code).toBe('purchase_account_mismatch');
    expect((await me(thief)).entitlement.tier).toBe('free');
  });
  it('a token already bound to one account cannot be bound to another', async () => {
    const a = newSub();
    const b = newSub();
    play.subs.set('tok-3-purchase-token', subscription(a));
    expect((await verify(a, 'tok-3-purchase-token')).statusCode).toBe(200);
    // Even if Google reported b's id (it won't), the binding check still stops it.
    play.subs.set('tok-3-purchase-token', subscription(b));
    expect((await verify(b, 'tok-3-purchase-token')).statusCode).toBe(409);
  });
  it('unknown token → 404; wrong or unknown product → 400', async () => {
    const sub = newSub();
    expect((await verify(sub, 'nope-token-purchase-token')).statusCode).toBe(404);
    expect((await verify(sub, 'nope-token-purchase-token', 'other_product')).statusCode).toBe(400);
    play.subs.set(
      'tok-4-purchase-token',
      subscription(sub, { lineItems: [{ productId: 'other', expiryTime: future }] }),
    );
    expect((await verify(sub, 'tok-4-purchase-token')).statusCode).toBe(400);
  });
  it('an expired subscription does not grant Pro', async () => {
    const sub = newSub();
    play.subs.set(
      'tok-5-purchase-token',
      subscription(sub, { lineItems: [{ productId: 'driftless_pro', expiryTime: past }] }),
    );
    const r = await verify(sub, 'tok-5-purchase-token');
    expect(v1.VerifyResponse.parse(bodyOf(r)).entitlement.tier).toBe('free');
    expect(play.acked).toEqual([]); // nothing to acknowledge without access
  });
  it('the client cannot claim Pro any other way', async () => {
    const sub = newSub();
    await me(sub);
    const r = await route(
      event({
        method: 'PATCH',
        path: '/v1/me',
        sub,
        body: { entitlement: { tier: 'pro' } },
        headers: { 'if-match': '1' },
      }),
    );
    expect(r.statusCode).toBe(400);
    expect((await me(sub)).entitlement.tier).toBe('free');
  });
});
describe('POST /webhooks/play-rtdn', () => {
  it('requires a valid Google-signed token from the configured push account', async () => {
    expect((await rtdn(null, push({}))).statusCode).toBe(401);
    expect((await rtdn('forged', push({}))).statusCode).toBe(401);
    expect((await rtdn('other', push({}))).statusCode).toBe(403);
  });
  it('a refund (voided purchase) revokes Pro', async () => {
    const sub = newSub();
    play.subs.set('tok-6-purchase-token', subscription(sub));
    await verify(sub, 'tok-6-purchase-token');
    const r = await rtdn(
      'good',
      push({
        packageName: 'com.siddiqkolimi.scrollsnooze',
        voidedPurchaseNotification: { purchaseToken: 'tok-6-purchase-token', productType: 1 },
      }),
    );
    expect(r.statusCode).toBe(200);
    expect((await me(sub)).entitlement).toMatchObject({ tier: 'free', state: 'revoked' });
  });
  it('state changes are re-read from Google (on hold → free, recovered → pro)', async () => {
    const sub = newSub();
    play.subs.set('tok-7-purchase-token', subscription(sub));
    await verify(sub, 'tok-7-purchase-token');
    play.subs.set(
      'tok-7-purchase-token',
      subscription(sub, { subscriptionState: 'SUBSCRIPTION_STATE_ON_HOLD' }),
    );
    await rtdn(
      'good',
      push({
        subscriptionNotification: { notificationType: 5, purchaseToken: 'tok-7-purchase-token' },
      }),
    );
    expect((await me(sub)).entitlement).toMatchObject({ tier: 'free', state: 'on_hold' });
    play.subs.set(
      'tok-7-purchase-token',
      subscription(sub, { acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED' }),
    );
    await rtdn(
      'good',
      push({
        subscriptionNotification: { notificationType: 1, purchaseToken: 'tok-7-purchase-token' },
      }),
    );
    expect((await me(sub)).entitlement).toMatchObject({ tier: 'pro', state: 'active' });
  });
  it('duplicate Pub/Sub deliveries are processed once', async () => {
    const sub = newSub();
    play.subs.set('tok-8-purchase-token', subscription(sub));
    await verify(sub, 'tok-8-purchase-token');
    const msg = push(
      { voidedPurchaseNotification: { purchaseToken: 'tok-8-purchase-token', productType: 1 } },
      'msg-dup-1',
    );
    expect(bodyOf(await rtdn('good', msg))).toEqual({ applied: 'revoked' });
    expect(bodyOf(await rtdn('good', msg))).toEqual({ duplicate: true });
  });
  it('after an upgrade, notifications for the old token are ignored', async () => {
    const sub = newSub();
    play.subs.set('old-tok-purchase-token', subscription(sub));
    await verify(sub, 'old-tok-purchase-token');
    play.subs.set(
      'new-tok-purchase-token',
      subscription(sub, { linkedPurchaseToken: 'old-tok-purchase-token' }),
    );
    await verify(sub, 'new-tok-purchase-token');
    play.subs.set(
      'old-tok-purchase-token',
      subscription(sub, { subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED' }),
    );
    const r = await rtdn(
      'good',
      push({
        subscriptionNotification: { notificationType: 13, purchaseToken: 'old-tok-purchase-token' },
      }),
    );
    expect(bodyOf(r)).toEqual({ ignored: 'superseded' });
    expect((await me(sub)).entitlement.tier).toBe('pro');
  });
  it('ignores other packages, test notifications and unknown tokens', async () => {
    expect(bodyOf(await rtdn('good', push({ packageName: 'com.other' })))).toEqual({
      ignored: 'package',
    });
    expect(bodyOf(await rtdn('good', push({ testNotification: { version: '1.0' } })))).toEqual({
      ignored: 'no token',
    });
    expect(
      bodyOf(
        await rtdn(
          'good',
          push({
            subscriptionNotification: {
              notificationType: 4,
              purchaseToken: 'never-seen-purchase-token',
            },
          }),
        ),
      ),
    ).toEqual({
      ignored: 'unknown token',
    });
  });
});
describe('service account assertion', () => {
  it('is an RS256 JWT for the androidpublisher scope, signed by the key', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwt = serviceAccountAssertion(
      {
        client_email: 'sa@x.iam.gserviceaccount.com',
        private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      },
      1_000,
    );
    const [h, c, sig] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(c, 'base64url').toString())).toMatchObject({
      iss: 'sa@x.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/androidpublisher',
      aud: 'https://oauth2.googleapis.com/token',
      exp: 4_600,
    });
    expect(
      createVerify('RSA-SHA256')
        .update(`${h}.${c}`)
        .verify(publicKey, Buffer.from(sig, 'base64url')),
    ).toBe(true);
  });
});
describe('reconcile job', () => {
  it('re-checks expiring Pro entitlements with Google and applies changes', async () => {
    const { reconcilePlay } = await import('../src/modules/billing/reconcile.js');
    const sub = newSub();
    const soon = new Date(Date.now() + 3_600_000).toISOString();
    play.subs.set(
      'reconcile-purchase-token',
      subscription(sub, { lineItems: [{ productId: 'driftless_pro', expiryTime: soon }] }),
    );
    await verify(sub, 'reconcile-purchase-token');
    expect((await me(sub)).entitlement.tier).toBe('pro');
    // Google says it lapsed, but the notification never arrived.
    play.subs.set(
      'reconcile-purchase-token',
      subscription(sub, { subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED' }),
    );
    const r = await reconcilePlay();
    expect(r.changed).toBeGreaterThanOrEqual(1);
    expect((await me(sub)).entitlement).toMatchObject({ tier: 'free', state: 'expired' });
  });
});
