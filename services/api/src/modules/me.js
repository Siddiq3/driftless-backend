import { activeWrite, readState } from '../lib/lifecycle.js';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { v1 } from '@siddiq3/driftless-contracts';
import { computeCapabilities } from './capabilities.js';
import { ddb, isConditionalFailure, Keys, tableName } from '../lib/ddb.js';
import { Errors, header, json, parseBody, validate } from '../lib/http.js';
const FREE = {
  tier: 'free',
  source: 'none',
  state: 'none',
  expiresAt: null,
  verifiedAt: null,
};
export function defaultProfile(sub, now) {
  return {
    pk: Keys.user(sub),
    sk: Keys.profile,
    handle: null,
    displayName: null,
    tz: 'UTC',
    locale: 'en',
    consent: { cloudSync: false, shareWithFriends: false },
    rev: 1,
    createdAt: now,
    updatedAt: now,
  };
}
const toProfile = (p) => ({
  handle: p.handle,
  displayName: p.displayName,
  tz: p.tz,
  locale: p.locale,
  consent: p.consent,
  rev: p.rev,
});
export async function loadProfile(sub) {
  const got = await ddb().send(
    new GetCommand({
      TableName: tableName(),
      Key: { pk: Keys.user(sub), sk: Keys.profile },
      ConsistentRead: true,
    }),
  );
  if (got.Item) return got.Item;
  throw Errors.conflict('profile_missing', 'Explicit account registration is required');
}
/** Entitlement is written only by the billing module after store verification — never by clients. */
async function loadEntitlement(sub) {
  const got = await ddb().send(
    new GetCommand({ TableName: tableName(), Key: { pk: Keys.user(sub), sk: Keys.entitlement } }),
  );
  if (!got.Item) return FREE;
  const { tier, source, state, expiresAt, verifiedAt } = got.Item;
  const ent = { tier, source, state, expiresAt, verifiedAt };
  // Defence in depth: an expired record never grants Pro, even if a reconcile job lags.
  if (
    ent.tier === 'pro' &&
    ent.expiresAt &&
    Date.parse(ent.expiresAt) < Date.now() &&
    ent.state !== 'grace'
  ) {
    return { ...ent, tier: 'free', state: 'expired' };
  }
  return ent;
}
function clientPlatform(event) {
  const q = event.queryStringParameters ?? {};
  if (q.platform === undefined && q.appVersion === undefined) return null;
  return validate(v1.ClientInfo, { platform: q.platform, appVersion: q.appVersion }).platform;
}
export async function getMe(event, caller) {
  const platform = clientPlatform(event);
  const [profile, entitlement] = await Promise.all([
    loadProfile(caller.sub),
    loadEntitlement(caller.sub),
  ]);
  const body = {
    userId: caller.userId,
    incarnation: caller.sub,
    profile: toProfile(profile),
    entitlement,
    capabilities: computeCapabilities(platform, entitlement),
  };
  return json(200, body, { etag: `"${profile.rev}"` });
}
function ifMatchRev(event) {
  const raw = header(event, 'if-match');
  if (!raw) throw Errors.preconditionRequired('If-Match header with the profile rev is required');
  const m = /^"?(\d{1,15})"?$/.exec(raw.trim());
  if (!m) throw Errors.badRequest('If-Match must be the numeric profile rev');
  return Number(m[1]);
}
export async function patchMe(event, caller) {
  const patch = parseBody(event, v1.PatchMeRequest);
  const expectedRev = ifMatchRev(event);
  const accounting=await readState({pk:Keys.user(caller.sub),sk:'ACCOUNTUSAGE#POLICY'});
  if(accounting && patch.tz!==undefined && patch.tz!==accounting.tz) throw Errors.conflict('account_timezone_fixed','Account timezone changes are not supported');
  const current = await loadProfile(caller.sub);
  if (current.rev !== expectedRev)
    throw Errors.preconditionFailed(`profile is at rev ${current.rev}`);
  const next = {
    ...current,
    ...(patch.handle !== undefined ? { handle: patch.handle } : {}),
    ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
    ...(patch.tz !== undefined ? { tz: patch.tz } : {}),
    ...(patch.locale !== undefined ? { locale: patch.locale } : {}),
    consent: { ...current.consent, ...(patch.consent ?? {}) },
    rev: current.rev + 1,
    updatedAt: new Date().toISOString(),
  };
  // Sharing with friends requires cloud sync.
  if (next.consent.shareWithFriends && !next.consent.cloudSync) {
    throw Errors.badRequest('shareWithFriends requires cloudSync', [
      { path: 'consent.shareWithFriends', message: 'enable cloudSync first' },
    ]);
  }
  const items = [
    {
      Put: {
        TableName: tableName(),
        Item: next,
        ConditionExpression: 'rev = :rev',
        ExpressionAttributeValues: { ':rev': expectedRev },
      },
    },
  ];
  const handleChanged = patch.handle !== undefined && patch.handle !== current.handle;
  if (handleChanged) {
    items.push({
      Put: {
        TableName: tableName(),
        Item: { ...Keys.handle(patch.handle), sub: caller.sub },
        // Free, or already ours.
        ConditionExpression: 'attribute_not_exists(pk) OR #sub = :sub',
        ExpressionAttributeNames: { '#sub': 'sub' },
        ExpressionAttributeValues: { ':sub': caller.sub },
      },
    });
    if (current.handle) {
      items.push({
        Delete: {
          TableName: tableName(),
          Key: Keys.handle(current.handle),
          ConditionExpression: '#sub = :sub',
          ExpressionAttributeNames: { '#sub': 'sub' },
          ExpressionAttributeValues: { ':sub': caller.sub },
        },
      });
    }
  }
  // A profile timezone patch must also be safe if fixed-timezone setup committed after
  // the preliminary policy read. Preserve handle/profile cancellation indexes above.
  if(patch.tz!==undefined) items.push({ConditionCheck:{TableName:tableName(),Key:{pk:Keys.user(caller.sub),sk:'ACCOUNTUSAGE#POLICY'},ConditionExpression:'attribute_not_exists(pk) OR tz = :tz',ExpressionAttributeValues:{':tz':patch.tz}}});
  try {
    await activeWrite(caller.sub, new TransactWriteCommand({ TransactItems: items }));
  } catch (e) {
    if (!isConditionalFailure(e)) throw e;
    const reasons = e.CancellationReasons ?? [];
    if (reasons[0]?.Code === 'ConditionalCheckFailed')
      throw Errors.preconditionFailed('profile changed concurrently');
    if (handleChanged && reasons[1]?.Code === 'ConditionalCheckFailed') {
      throw Errors.conflict('handle_taken', 'that handle is already taken');
    }
    throw Errors.conflict('conflict', 'concurrent update, retry');
  }
  const entitlement = await loadEntitlement(caller.sub);
  const body = {
    userId: caller.userId,
    incarnation: caller.sub,
    profile: toProfile(next),
    entitlement,
    capabilities: computeCapabilities(null, entitlement),
  };
  return json(200, body, { etag: `"${next.rev}"` });
}
