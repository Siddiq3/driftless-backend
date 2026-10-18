import { z } from 'zod';

/** Maximum accepted request body size for any JSON endpoint (bytes). */
export const MAX_BODY_BYTES = 32 * 1024;

const LOCAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True when `s` is a real calendar date in YYYY-MM-DD form (rejects 2026-02-30). */
export function isValidLocalDate(s: string): boolean {
  const m = LOCAL_DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 2020 || y > 2100 || mo < 1 || mo > 12 || d < 1) return false;
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return d <= daysInMonth;
}

/** Device-local calendar day, e.g. "2026-10-18". */
export const LocalDate = z
  .string()
  .regex(LOCAL_DATE_RE, 'expected YYYY-MM-DD')
  .refine(isValidLocalDate, 'not a real calendar date');

/** True when `tz` is an IANA time-zone name known to the runtime. */
export function isValidTimeZone(tz: string): boolean {
  if (tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const TimeZone = z.string().min(1).max(64).refine(isValidTimeZone, 'unknown IANA time zone');

export const Platform = z.enum(['android', 'ios']);
export type Platform = z.infer<typeof Platform>;

export const Uuid = z.uuid();

/** Optimistic-concurrency revision. Starts at 1 and only increases. */
export const Revision = z.int().min(1).max(Number.MAX_SAFE_INTEGER);

/** Public handle: 3–20 chars, lowercase letters, digits, underscore; must start with a letter. */
export const Handle = z
  .string()
  .min(3)
  .max(20)
  .regex(/^[a-z][a-z0-9_]{2,19}$/, 'lowercase letters, digits and _ only; start with a letter');

/** Free-text display name; control characters rejected. */
export const DisplayName = z
  .string()
  .trim()
  .min(1)
  .max(40)
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\u0000-\u001f\u007f]+$/, 'control characters are not allowed');

/** RFC 9457 problem details returned on every error. */
export const Problem = z.object({
  type: z.string(),
  title: z.string(),
  status: z.int().min(400).max(599),
  detail: z.string().optional(),
  code: z.string(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type Problem = z.infer<typeof Problem>;

/** Idempotency-Key header: client-generated UUID. */
export const IdempotencyKey = Uuid;
