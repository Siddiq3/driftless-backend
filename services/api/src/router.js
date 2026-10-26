import {
  postBattleInvite,
  getBattleInvite,
  acceptBattleInvite,
  getBattleDaily,
} from './modules/battle-links.js';
import { joinPage, associationFile } from './modules/join-page.js';
import {
  getAccountUsageHistory,
  getAccountUsage,
  configureAccountUsage,
  reconcileAccountUsage,
  reserveAccountUsage,
} from './modules/account-usage.js';
import { accountKey, readState, inactive, assertActive } from './lib/lifecycle.js';
import { header } from './lib/http.js';
import { getWrapped } from './modules/wrapped.js';
import { requireCaller } from './lib/auth.js';
import { Errors, HttpError, problem } from './lib/http.js';
import { log } from './lib/log.js';
import {
  getAccountState,
  postRegister,
  getDeleteStatus,
  getExport,
  postDeleteAccount,
} from './modules/account.js';
import { postPlayRtdn, postPlayVerify } from './modules/billing/index.js';
import {
  getChallenges,
  getLeaderboard,
  postChallenge,
  postJoin,
  postLeave,
  postInvitation,
  putScoreConsent,
} from './modules/challenges.js';
import { deleteDevice, postDevice } from './modules/devices.js';
import {
  getFriends,
  getFriendsDaily,
  postFriendRemove,
  postFriendRequest,
  postFriendRespond,
  postInvite,
} from './modules/friends.js';
import { getGoals, putGoals } from './modules/goals.js';
import { getMe, patchMe } from './modules/me.js';
import { getUsageHistory, postUsageSync } from './modules/usage.js';
import { getHealth } from './modules/health.js';
/** Routes implemented so far. Routes in contracts.ROUTES not listed here return 404 (by design). */
export const IMPLEMENTED = {
  'POST /v1/battles/invites': postBattleInvite,
  'GET /v1/battles/invites/{code}': getBattleInvite,
  'POST /v1/battles/invites/{code}/accept': acceptBattleInvite,
  'GET /v1/battles/daily': getBattleDaily,
  'GET /v1/usage/account': getAccountUsage,
  'GET /v1/usage/account/history': getAccountUsageHistory,
  'PUT /v1/usage/account': configureAccountUsage,
  'POST /v1/usage/account/reconcile': reconcileAccountUsage,
  'POST /v1/usage/account/reserve': reserveAccountUsage,
  'GET /v1/account': getAccountState,
  'POST /v1/account/register': postRegister,
  'GET /v1/me': getMe,
  'GET /v1/wrapped': getWrapped,
  'PATCH /v1/me': patchMe,
  'GET /v1/goals': getGoals,
  'PUT /v1/goals': putGoals,
  'POST /v1/usage/sync': postUsageSync,
  'POST /v1/billing/play/verify': postPlayVerify,
  'GET /v1/usage/history': getUsageHistory,
  'GET /v1/friends': getFriends,
  'GET /v1/friends/daily': getFriendsDaily,
  'POST /v1/friends/invites': postInvite,
  'POST /v1/friends/requests': postFriendRequest,
  'POST /v1/friends/respond': postFriendRespond,
  'POST /v1/friends/remove': postFriendRemove,
  'GET /v1/challenges': getChallenges,
  'POST /v1/challenges': postChallenge,
  'POST /v1/challenges/{id}/join': postJoin,
  'POST /v1/challenges/{id}/leave': postLeave,
  'POST /v1/challenges/{id}/invitation': postInvitation,
  'PUT /v1/challenges/{id}/score-consent': putScoreConsent,
  'GET /v1/challenges/{id}/leaderboard': getLeaderboard,
  'POST /v1/devices': postDevice,
  'DELETE /v1/devices/{id}': deleteDevice,
  'POST /v1/account/delete': postDeleteAccount,
  'GET /v1/account/delete': getDeleteStatus,
  'GET /v1/account/export': getExport,
};
/** Routes outside the app JWT authorizer; each verifies its caller itself. */
export const WEBHOOKS = {
  'POST /webhooks/play-rtdn': postPlayRtdn,
};
const PATTERNS = Object.entries(IMPLEMENTED)
  .filter(([k]) => k.includes('{'))
  .map(([k, h]) => {
    const [m, path] = k.split(' ');
    const names = [];
    const re = new RegExp(
      '^' + path.replace(/\{(\w+)\}/g, (_x, n) => (names.push(n), '([A-Za-z0-9-]{1,64})')) + '$',
    );
    return { m, re, names, h, key: k };
  });
/** Resolves `/v1/challenges/{id}/join`-style routes and exposes the params as event.pathParameters. */
function matchPattern(method, event) {
  for (const p of PATTERNS) {
    if (p.m !== method) continue;
    const hit = p.re.exec(event.rawPath);
    if (!hit) continue;
    event.pathParameters = Object.fromEntries(p.names.map((n, i) => [n, hit[i + 1]]));
    return { handler: p.h, label: p.key };
  }
  return undefined;
}
export async function route(event) {
  const method = event.requestContext?.http?.method ?? 'GET';
  const key = `${method} ${event.rawPath}`;
  const started = Date.now();
  let label = 'unmatched';
  let status = 500;
  try {
    const join = method === 'GET' && /^\/join\/([A-HJ-NP-Z2-9]{10})$/.exec(event.rawPath);
    if (join) {
      label = 'GET /join/{code}';
      const res = await joinPage(join[1]);
      status = res.statusCode;
      return res;
    }
    if (
      method === 'GET' &&
      ['/.well-known/assetlinks.json', '/.well-known/apple-app-site-association'].includes(
        event.rawPath,
      )
    ) {
      label = 'GET /.well-known/association';
      status = 200;
      return associationFile(event.rawPath);
    }
    if (key === 'GET /health') {
      label = key;
      const res = await getHealth();
      status = res.statusCode ?? 200;
      return res;
    }
    // Store webhooks authenticate with the store's own signed token, not the app session.
    const hook = WEBHOOKS[key];
    if (hook) {
      label = key;
      const res = await hook(event);
      status = res.statusCode ?? 200;
      return res;
    }
    const matched = IMPLEMENTED[key]
      ? { handler: IMPLEMENTED[key], label: key }
      : matchPattern(method, event);
    if (matched) label = matched.label;
    const caller = requireCaller(event); // authenticate before revealing which routes exist
    if (!matched) throw Errors.notFound();
    let bound = caller;
    if (
      ![
        'GET /v1/account',
        'POST /v1/account/register',
        'POST /v1/account/delete',
        'GET /v1/account/delete',
      ].includes(key)
    ) {
      const state = await readState(accountKey(caller.sub));
      const supplied = header(event, 'x-account-incarnation');
      if (
        state?.state !== 'active' ||
        (supplied !== state.incarnation && !(key === 'GET /v1/me' && !supplied))
      )
        throw inactive();
      await assertActive(state.incarnation);
      // Internal storage owner is the incarnation. Public identity remains the Google-derived UUID.
      bound = { ...caller, userId: caller.sub, sub: state.incarnation };
    }
    const res = await matched.handler(event, bound);
    status = res.statusCode ?? 200;
    return res;
  } catch (e) {
    if (e instanceof HttpError) {
      status = e.status;
      return problem(e);
    }
    log.error('unhandled', { route: label, err: e instanceof Error ? e.name : 'unknown' });
    return problem(new HttpError(500, 'internal', 'internal error'));
  } finally {
    log.info('request', {
      route: label,
      status,
      ms: Date.now() - started,
      reqId: event.requestContext?.requestId,
    });
  }
}
