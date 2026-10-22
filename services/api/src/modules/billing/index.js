import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { v1 } from '@siddiq3/driftless-contracts';
import { JwtRsaVerifier } from 'aws-jwt-verify';
import { ddb, isConditionalFailure, Keys, tableName } from '../../lib/ddb.js';
import { Errors, header, HttpError, json, parseBody, rawBody } from '../../lib/http.js';
import { log } from '../../lib/log.js';
import { HttpPlayApi } from './play-api.js';
import { entitlementFromPlay, obfuscatedAccountId, REVOKED, tokenHash } from './play-state.js';
export function configFromEnv(env = process.env) {
  return {
    packageName: env.PLAY_PACKAGE_NAME ?? 'com.siddiqkolimi.driftless',
    proProducts: new Set(
      (env.PRO_PRODUCT_IDS ?? 'driftless_pro')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
    rtdnAudience: env.RTDN_AUDIENCE ?? null,
    rtdnServiceAccount: env.RTDN_SERVICE_ACCOUNT ?? null,
  };
}
let deps = null;
/** Tests inject fakes; production builds real clients from env on first use. */
export function setBillingDeps(d) {
  deps = d;
}
function getDeps() {
  if (deps) return deps;
  const config = configFromEnv();
  const secret = process.env.PLAY_SA_SECRET_ARN;
  if (!secret) throw new HttpError(503, 'billing_unconfigured', 'billing is not configured');
  const google = config.rtdnAudience
    ? JwtRsaVerifier.create([
        {
          issuer: 'https://accounts.google.com',
          audience: config.rtdnAudience,
          jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
        },
        {
          issuer: 'accounts.google.com',
          audience: config.rtdnAudience,
          jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
        },
      ])
    : null;
  deps = {
    config,
    play: new HttpPlayApi(secret),
    verifier: {
      verify: async (t) => {
        if (!google) throw new Error('RTDN audience not configured');
        return await google.verify(t);
      },
    },
  };
  return deps;
}
export const purchaseKey = (token) => ({
  pk: `PURCHASE#play#${tokenHash(token)}`,
  sk: 'PURCHASE',
});
/** GSI1 indexes Play entitlements by expiry so the reconcile job can find ones to re-check. */
async function writeEntitlement(sub, e, tokenHashValue) {
  await ddb().send(
    new PutCommand({
      TableName: tableName(),
      Item: {
        pk: Keys.user(sub),
        sk: Keys.entitlement,
        ...e,
        tokenHash: tokenHashValue,
        gsi1pk: 'ENT#play',
        gsi1sk: `${e.expiresAt ?? '9999'}#${sub}`,
      },
    }),
  );
}
/**
 * Re-reads the purchase from Google and applies it. The single path for verify, RTDN and
 * reconcile, so all three always agree.
 */
export async function applyPlayToken(sub, token, productId, sub2) {
  const { play, config } = getDeps();
  const s = sub2 === undefined ? await play.getSubscription(config.packageName, token) : sub2;
  const now = Date.now();
  if (!s) {
    const e = REVOKED(now);
    await writeEntitlement(sub, e, tokenHash(token));
    return e;
  }
  const e = entitlementFromPlay(s, config.proProducts, now);
  await writeEntitlement(sub, e, tokenHash(token));
  await ddb().send(
    new UpdateCommand({
      TableName: tableName(),
      Key: purchaseKey(token),
      UpdateExpression: 'SET #s = :s, updatedAt = :u',
      ExpressionAttributeNames: { '#s': 'state' },
      ExpressionAttributeValues: { ':s': s.subscriptionState, ':u': new Date(now).toISOString() },
    }),
  );
  if (s.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING' && e.tier === 'pro') {
    // Unacknowledged purchases are refunded by Google after a few days.
    await play.acknowledge(config.packageName, productId, token);
  }
  return e;
}
/* ───────────── POST /v1/billing/play/verify ───────────── */
export async function postPlayVerify(event, caller) {
  const { productId, purchaseToken } = parseBody(event, v1.PlayVerifyRequest);
  const { play, config } = getDeps();
  if (!config.proProducts.has(productId)) throw Errors.badRequest('unknown product');
  const s = await play.getSubscription(config.packageName, purchaseToken);
  if (!s) throw new HttpError(404, 'purchase_not_found', 'Google Play does not know this purchase');
  if (!(s.lineItems ?? []).some((l) => l.productId === productId))
    throw Errors.badRequest('token is for a different product');
  // The app sets this to obfuscatedAccountId(sub) when launching the purchase. Anything else
  // means the token belongs to another Driftless account (or was taken from another device).
  if (
    s.externalAccountIdentifiers?.obfuscatedExternalAccountId !== obfuscatedAccountId(caller.sub)
  ) {
    throw new HttpError(
      403,
      'purchase_account_mismatch',
      'this purchase belongs to a different account',
    );
  }
  const now = new Date().toISOString();
  try {
    await ddb().send(
      new PutCommand({
        TableName: tableName(),
        Item: {
          ...purchaseKey(purchaseToken),
          sub: caller.sub,
          productId,
          // Kept (encrypted at rest) so the reconcile job can re-check with Google; never returned to clients.
          token: purchaseToken,
          state: s.subscriptionState,
          updatedAt: now,
        },
        ConditionExpression: 'attribute_not_exists(pk) OR #sub = :sub',
        ExpressionAttributeNames: { '#sub': 'sub' },
        ExpressionAttributeValues: { ':sub': caller.sub },
      }),
    );
  } catch (e) {
    if (isConditionalFailure(e))
      throw Errors.conflict(
        'purchase_bound_elsewhere',
        'this purchase is linked to another account',
      );
    throw e;
  }
  if (s.linkedPurchaseToken) {
    // Upgrade/downgrade/resubscribe: the old token must never grant access again.
    await ddb()
      .send(
        new UpdateCommand({
          TableName: tableName(),
          Key: purchaseKey(s.linkedPurchaseToken),
          UpdateExpression: 'SET supersededBy = :n, updatedAt = :u',
          ConditionExpression: 'attribute_exists(pk)',
          ExpressionAttributeValues: { ':n': tokenHash(purchaseToken), ':u': now },
        }),
      )
      .catch((e) => {
        if (!isConditionalFailure(e)) throw e;
      });
  }
  const entitlement = await applyPlayToken(caller.sub, purchaseToken, productId, s);
  return json(200, { entitlement });
}
export async function postPlayRtdn(event) {
  const { verifier, config } = getDeps();
  const auth = header(event, 'authorization') ?? '';
  const bearer = /^Bearer (.+)$/i.exec(auth)?.[1];
  if (!bearer) throw Errors.unauthorized();
  let claims;
  try {
    claims = await verifier.verify(bearer);
  } catch {
    throw Errors.unauthorized();
  }
  if (
    !config.rtdnServiceAccount ||
    claims.email !== config.rtdnServiceAccount ||
    claims.email_verified !== true
  ) {
    throw Errors.forbidden();
  }
  const push = JSON.parse(rawBody(event) || '{}');
  const id = push.message?.messageId;
  const data = push.message?.data;
  if (!id || !data) throw Errors.badRequest('not a Pub/Sub push');
  // Pub/Sub is at-least-once: process each messageId once (7-day memory).
  try {
    await ddb().send(
      new PutCommand({
        TableName: tableName(),
        Item: { pk: `PUBSUB#${id}`, sk: 'PUBSUB', ttl: Math.floor(Date.now() / 1000) + 7 * 86_400 },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
  } catch (e) {
    if (isConditionalFailure(e)) return json(200, { duplicate: true });
    throw e;
  }
  const n = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
  if (n.packageName && n.packageName !== config.packageName)
    return json(200, { ignored: 'package' });
  const token =
    n.subscriptionNotification?.purchaseToken ?? n.voidedPurchaseNotification?.purchaseToken;
  if (!token) return json(200, { ignored: 'no token' }); // e.g. testNotification
  const p = (await ddb().send(new GetCommand({ TableName: tableName(), Key: purchaseKey(token) })))
    .Item;
  if (!p) return json(200, { ignored: 'unknown token' }); // purchase not yet verified by the app
  if (p.supersededBy) return json(200, { ignored: 'superseded' });
  if (n.voidedPurchaseNotification) {
    await writeEntitlement(p.sub, REVOKED(Date.now()), tokenHash(token));
    log.info('billing.voided', { type: n.voidedPurchaseNotification.productType });
    return json(200, { applied: 'revoked' });
  }
  const e = await applyPlayToken(p.sub, token, p.productId);
  log.info('billing.rtdn', {
    type: n.subscriptionNotification?.notificationType,
    tier: e.tier,
    state: e.state,
  });
  return json(200, { applied: e.state });
}
