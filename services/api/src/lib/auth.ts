import { createHash } from 'node:crypto';
import { Errors, type ApiEvent } from './http.js';

export const GOOGLE_ISSUER = 'https://accounts.google.com';
const GOOGLE_SUB = /^[A-Za-z0-9_-]{1,255}$/;
// Fixed, app-specific namespace: changing this would change every Google user's Driftless ID.
const NAMESPACE = Buffer.from('9fdd66c140b84ed39d587a94c058a52d', 'hex');

/** RFC 4122 UUIDv5 keeps the existing UUID contracts without identifying users by mutable email. */
export function googleUserId(googleSub: string): string {
  const bytes = createHash('sha1')
    .update(NAMESPACE)
    .update(`${GOOGLE_ISSUER}\0${googleSub}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export type Caller = { sub: string; authTime: number | null };

/**
 * Gateway verifies the Google signature, issuer, audience and expiry before invoking this route.
 * Only these verified claims identify a caller; body/path IDs and email never establish ownership.
 */
export function requireCaller(event: ApiEvent): Caller {
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  const expectedAudience = process.env.GOOGLE_WEB_CLIENT_ID;
  const subject = claims?.sub;
  const issued = Number(claims?.iat);
  const expires = Number(claims?.exp);
  const now = Math.floor(Date.now() / 1000);
  if (
    !expectedAudience ||
    claims?.iss !== GOOGLE_ISSUER ||
    claims.aud !== expectedAudience ||
    typeof subject !== 'string' ||
    !GOOGLE_SUB.test(subject) ||
    claims.token_use !== undefined ||
    !Number.isSafeInteger(issued) ||
    issued <= 0 ||
    issued > now + 60 ||
    !Number.isSafeInteger(expires) ||
    expires <= now ||
    expires <= issued
  )
    throw Errors.unauthorized();
  // Google ID tokens expose iat, not Cognito auth_time. This proves a recently issued credential,
  // not a password/MFA challenge or recent interactive presence.
  return { sub: googleUserId(subject), authTime: issued };
}

/** Destructive actions require a fresh Google identity credential (at most five minutes old). */
export function requireRecentAuth(caller: Caller, nowSec: number, maxAgeSec = 300): void {
  if (
    caller.authTime === null ||
    caller.authTime > nowSec + 60 ||
    nowSec - caller.authTime > maxAgeSec
  )
    throw Errors.forbidden();
}
