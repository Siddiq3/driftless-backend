import { z } from 'zod';
import { LocalDate, TimeZone, Uuid } from './common.js';

const AccountTimeZone = TimeZone.refine((tz) => !/^[+-]/.test(tz), 'Select an IANA timezone');

/** Counts are observations, not a claim of validated detector accuracy. Minutes are charged
 * in integer milliseconds and added across devices, including simultaneous use. */
export const AllowanceKey = z.string().regex(/^(views|minutes)(:[a-zA-Z][a-zA-Z0-9_.]{1,150})?$/);
export const AllowanceLimits = z
  .record(AllowanceKey, z.int().min(1).max(86_400_000))
  .refine((m) => Object.keys(m).length <= 16);
export const AccountUsageConfigure = z.strictObject({
  tz: AccountTimeZone,
  limits: AllowanceLimits,
  expectedRev: z.int().min(0),
});
export const AccountUsagePolicy = z.object({
  incarnation: Uuid,
  tz: AccountTimeZone,
  activeFromMs: z.int(),
  rev: z.int().min(1),
  policies: z.array(z.object({ effectiveDate: LocalDate, limits: AllowanceLimits })),
});
export const AccountUsageContribution = z.strictObject({
  incarnation: Uuid,
  periodId: z.string().min(38).max(64),
  localDate: LocalDate,
  deviceId: Uuid,
  rev: z.int().min(1),
  resetGeneration: z.int().min(0),
  // Stable cumulative event counters per package. Native SQLite deduplicates the source events.
  apps: z
    .record(
      z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.]{1,150}$/),
      z.strictObject({
        views: z.int().min(0).max(100_000).nullable(),
        usageMs: z.int().min(0).max(172_800_000).nullable(),
      }),
    )
    .refine((a) => Object.keys(a).length <= 8),
});
export const AccountUsageReconcile = z.strictObject({
  contributions: z.array(AccountUsageContribution).min(1).max(16),
});
export const AccountUsageReserve = z.strictObject({
  incarnation: Uuid,
  periodId: z.string().min(38).max(64),
  deviceId: Uuid,
  // A stable operation ID makes a lost grant response safe to retry.
  operationId: Uuid,
  requested: z.record(AllowanceKey, z.int().min(1).max(86_400_000)),
});
export const AccountUsageSnapshot = z.object({
  incarnation: Uuid,
  periodId: z.string(),
  localDate: LocalDate,
  tz: AccountTimeZone,
  startMs: z.int(),
  endMs: z.int(),
  rev: z.int().min(0),
  limits: AllowanceLimits,
  used: z.record(z.string(), z.int().min(0)),
  allocated: z.record(z.string(), z.int().min(0)),
  devices: z.record(
    z.string(),
    z.object({
      rev: z.int(),
      resetGeneration: z.int(),
      apps: AccountUsageContribution.shape.apps,
      used: z.record(z.string(), z.int().min(0)),
      granted: z.record(z.string(), z.int().min(0)),
    }),
  ),
  unavailable: z.array(z.string()),
  serverTimeMs: z.int(),
});
export const AccountUsageResponse = z.object({
  policy: AccountUsagePolicy.nullable(),
  snapshot: AccountUsageSnapshot.nullable(),
  serverTimeMs: z.int(),
});

export const AccountUsageHistoryQuery = z
  .strictObject({ from: LocalDate, to: LocalDate, deviceId: Uuid })
  .refine(
    (q) =>
      q.from <= q.to &&
      Date.parse(`${q.to}T00:00:00Z`) - Date.parse(`${q.from}T00:00:00Z`) < 400 * 86_400_000,
  );
export const AccountUsageHistory = z.object({
  days: z.array(AccountUsageSnapshot).max(400),
  serverTimeMs: z.int(),
});
