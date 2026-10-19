import { getWrapped } from './modules/wrapped.js';
import { requireCaller, type Caller } from './lib/auth.js';
import { Errors, HttpError, problem, type ApiEvent, type ApiResult } from './lib/http.js';
import { log } from './lib/log.js';
import { getDeleteStatus, getExport, postDeleteAccount } from './modules/account.js';
import { postPlayRtdn, postPlayVerify } from './modules/billing/index.js';
import {
  getChallenges,
  getLeaderboard,
  postChallenge,
  postJoin,
  postLeave,
} from './modules/challenges.js';
import { deleteDevice, postDevice } from './modules/devices.js';
import {
  getFriends,
  postFriendRemove,
  postFriendRequest,
  postFriendRespond,
  postInvite,
} from './modules/friends.js';
import { getGoals, putGoals } from './modules/goals.js';
import { getMe, patchMe } from './modules/me.js';
import { getUsageHistory, postUsageSync } from './modules/usage.js';

type Handler = (event: ApiEvent, caller: Caller) => Promise<ApiResult>;

/** Routes implemented so far. Routes in contracts.ROUTES not listed here return 404 (by design). */
export const IMPLEMENTED: Record<string, Handler> = {
  'GET /v1/me': getMe,
  'GET /v1/wrapped': getWrapped,
  'PATCH /v1/me': patchMe,
  'GET /v1/goals': getGoals,
  'PUT /v1/goals': putGoals,
  'POST /v1/usage/sync': postUsageSync,
  'POST /v1/billing/play/verify': postPlayVerify,
  'GET /v1/usage/history': getUsageHistory,
  'GET /v1/friends': getFriends,
  'POST /v1/friends/invites': postInvite,
  'POST /v1/friends/requests': postFriendRequest,
  'POST /v1/friends/respond': postFriendRespond,
  'POST /v1/friends/remove': postFriendRemove,
  'GET /v1/challenges': getChallenges,
  'POST /v1/challenges': postChallenge,
  'POST /v1/challenges/{id}/join': postJoin,
  'POST /v1/challenges/{id}/leave': postLeave,
  'GET /v1/challenges/{id}/leaderboard': getLeaderboard,
  'POST /v1/devices': postDevice,
  'DELETE /v1/devices/{id}': deleteDevice,
  'POST /v1/account/delete': postDeleteAccount,
  'GET /v1/account/delete': getDeleteStatus,
  'GET /v1/account/export': getExport,
};

/** Routes outside the app JWT authorizer; each verifies its caller itself. */
export const WEBHOOKS: Record<string, (event: ApiEvent) => Promise<ApiResult>> = {
  'POST /webhooks/play-rtdn': postPlayRtdn,
};

const PATTERNS = Object.entries(IMPLEMENTED)
  .filter(([k]) => k.includes('{'))
  .map(([k, h]) => {
    const [m, path] = k.split(' ') as [string, string];
    const names: string[] = [];
    const re = new RegExp(
      '^' +
        path.replace(/\{(\w+)\}/g, (_x, n: string) => (names.push(n), '([A-Za-z0-9-]{1,64})')) +
        '$',
    );
    return { m, re, names, h };
  });

/** Resolves `/v1/challenges/{id}/join`-style routes and exposes the params as event.pathParameters. */
function matchPattern(method: string, event: ApiEvent): Handler | undefined {
  for (const p of PATTERNS) {
    if (p.m !== method) continue;
    const hit = p.re.exec(event.rawPath);
    if (!hit) continue;
    event.pathParameters = Object.fromEntries(p.names.map((n, i) => [n, hit[i + 1]!]));
    return p.h;
  }
  return undefined;
}

export async function route(event: ApiEvent): Promise<ApiResult> {
  const method = event.requestContext?.http?.method ?? 'GET';
  const key = `${method} ${event.rawPath}`;
  const started = Date.now();
  let status = 500;
  try {
    // Store webhooks authenticate with the store's own signed token, not the app session.
    const hook = WEBHOOKS[key];
    if (hook) {
      const res = await hook(event);
      status = res.statusCode ?? 200;
      return res;
    }
    const handler = IMPLEMENTED[key] ?? matchPattern(method, event);
    const caller = requireCaller(event); // authenticate before revealing which routes exist
    if (!handler) throw Errors.notFound();
    const res = await handler(event, caller);
    status = res.statusCode ?? 200;
    return res;
  } catch (e) {
    if (e instanceof HttpError) {
      status = e.status;
      return problem(e);
    }
    log.error('unhandled', { route: key, err: e instanceof Error ? e.name : 'unknown' });
    return problem(new HttpError(500, 'internal', 'internal error'));
  } finally {
    log.info('request', {
      route: key,
      status,
      ms: Date.now() - started,
      reqId: event.requestContext?.requestId,
    });
  }
}
