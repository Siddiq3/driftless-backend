import { Errors, type ApiEvent } from './http.js';

/** Cognito `sub` is a UUID. Anything else means the authorizer is misconfigured. */
const SUB_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Caller = { sub: string; authTime: number | null };

/**
 * The only source of the caller's identity. API Gateway's JWT authorizer has already verified
 * signature, issuer, audience and expiry; we read `sub` from the verified claims.
 * User IDs in paths, queries or bodies are never trusted for ownership (THREAT_MODEL T1).
 */
export function requireCaller(event: ApiEvent): Caller {
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  const sub = claims?.sub;
  if (typeof sub !== 'string' || !SUB_RE.test(sub)) throw Errors.unauthorized();
  // Cognito access tokens carry token_use=access; reject ID tokens used as bearer tokens.
  if (claims?.token_use !== undefined && claims.token_use !== 'access') throw Errors.unauthorized();
  const at = Number(claims?.auth_time);
  return { sub: sub.toLowerCase(), authTime: Number.isFinite(at) ? at : null };
}

/** For destructive actions (account deletion): require a sign-in within `maxAgeSec`. */
export function requireRecentAuth(caller: Caller, nowSec: number, maxAgeSec = 300): void {
  if (caller.authTime === null || nowSec - caller.authTime > maxAgeSec) {
    throw Errors.forbidden();
  }
}
