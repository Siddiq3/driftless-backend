import { requireCaller, type Caller } from './lib/auth.js';
import { Errors, HttpError, problem, type ApiEvent, type ApiResult } from './lib/http.js';
import { log } from './lib/log.js';
import { postPlayRtdn, postPlayVerify } from './modules/billing/index.js';
import { getGoals, putGoals } from './modules/goals.js';
import { getMe, patchMe } from './modules/me.js';
import { getUsageHistory, postUsageSync } from './modules/usage.js';

type Handler = (event: ApiEvent, caller: Caller) => Promise<ApiResult>;

/** Routes implemented so far. Routes in contracts.ROUTES not listed here return 404 (by design). */
export const IMPLEMENTED: Record<string, Handler> = {
  'GET /v1/me': getMe,
  'PATCH /v1/me': patchMe,
  'GET /v1/goals': getGoals,
  'PUT /v1/goals': putGoals,
  'POST /v1/usage/sync': postUsageSync,
  'POST /v1/billing/play/verify': postPlayVerify,
  'GET /v1/usage/history': getUsageHistory,
};

/** Unauthenticated-by-Cognito routes; each verifies its caller itself. */
export const WEBHOOKS: Record<string, (event: ApiEvent) => Promise<ApiResult>> = {
  'POST /webhooks/play-rtdn': postPlayRtdn,
};

export async function route(event: ApiEvent): Promise<ApiResult> {
  const method = event.requestContext?.http?.method ?? 'GET';
  const key = `${method} ${event.rawPath}`;
  const started = Date.now();
  let status = 500;
  try {
    // Store webhooks authenticate with the store's own signed token, not Cognito.
    const hook = WEBHOOKS[key];
    if (hook) {
      const res = await hook(event);
      status = res.statusCode ?? 200;
      return res;
    }
    const handler = IMPLEMENTED[key];
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
