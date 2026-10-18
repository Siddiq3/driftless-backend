import { z } from 'zod';
import { DisplayName, Handle, LocalDate, Platform, Revision, TimeZone, Uuid } from '../common.js';

/* ───────────── Profile & capabilities ───────────── */

export const Tier = z.enum(['free', 'pro']);

export const Entitlement = z.object({
  tier: Tier,
  source: z.enum(['none', 'play', 'appstore']),
  state: z.enum(['none', 'active', 'grace', 'on_hold', 'paused', 'expired', 'revoked']),
  expiresAt: z.iso.datetime().nullable(),
  verifiedAt: z.iso.datetime().nullable(),
});
export type Entitlement = z.infer<typeof Entitlement>;

/** Capabilities are decided by the server, never by the client. */
export const Capabilities = z.object({
  videoCounting: z.boolean(),
  minutesTracking: z.boolean(),
  blocking: z.boolean(),
  schedules: z.boolean(),
  advancedAnalytics: z.boolean(),
  socialSharingOfUsage: z.boolean(),
});
export type Capabilities = z.infer<typeof Capabilities>;

export const Profile = z.object({
  handle: Handle.nullable(),
  displayName: DisplayName.nullable(),
  tz: TimeZone,
  locale: z.string().min(2).max(35),
  consent: z.object({
    cloudSync: z.boolean(),
    shareWithFriends: z.boolean(),
  }),
  rev: Revision,
});
export type Profile = z.infer<typeof Profile>;

export const MeResponse = z.object({
  userId: z.string(),
  profile: Profile,
  entitlement: Entitlement,
  capabilities: Capabilities,
});
export type MeResponse = z.infer<typeof MeResponse>;

export const PatchMeRequest = z
  .strictObject({
    handle: Handle.optional(),
    displayName: DisplayName.optional(),
    tz: TimeZone.optional(),
    locale: z.string().min(2).max(35).optional(),
    consent: z
      .strictObject({ cloudSync: z.boolean().optional(), shareWithFriends: z.boolean().optional() })
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'at least one field is required');
export type PatchMeRequest = z.infer<typeof PatchMeRequest>;

/** Query parameters sent with GET /v1/me so the server can compute capabilities. */
export const ClientInfo = z.strictObject({
  platform: Platform,
  appVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
});

/* ───────────── Goals ───────────── */

export const Goal = z.strictObject({
  goalId: Uuid,
  metric: z.enum(['views', 'minutes']),
  /** Daily ceiling. views ≤ 2000, minutes ≤ 1440. */
  dailyLimit: z.int().min(1).max(2000),
  enabled: z.boolean(),
  rev: Revision,
});
export type Goal = z.infer<typeof Goal>;

export const PutGoalsRequest = z.strictObject({
  goals: z
    .array(Goal)
    .max(10)
    .refine((gs) => gs.every((g) => g.metric !== 'minutes' || g.dailyLimit <= 1440), {
      message: 'minutes limit must be ≤ 1440',
    })
    .refine((gs) => new Set(gs.map((g) => g.goalId)).size === gs.length, {
      message: 'duplicate goalId',
    }),
});

/* ───────────── Usage sync ───────────── */

/**
 * One device's aggregate for one local calendar day.
 * `null` counts mean "not tracked" — never coerce to 0.
 */
export const DailyAggregate = z
  .strictObject({
    localDate: LocalDate,
    tz: TimeZone,
    platform: Platform,
    deviceId: Uuid,
    views: z.int().min(0).max(5000).nullable(),
    adViews: z.int().min(0).max(5000).nullable(),
    minutes: z.int().min(0).max(1440).nullable(),
    /** Fraction of the day during which tracking was healthy. */
    coverage: z.number().min(0).max(1),
    rev: Revision,
  })
  .refine((a) => a.platform === 'android' || (a.views === null && a.adViews === null), {
    message: 'iOS aggregates cannot carry video counts',
    path: ['views'],
  });
export type DailyAggregate = z.infer<typeof DailyAggregate>;

export const UsageSyncRequest = z.strictObject({
  days: z
    .array(DailyAggregate)
    .min(1)
    .max(31)
    .refine(
      (ds) => new Set(ds.map((d) => `${d.deviceId}|${d.localDate}`)).size === ds.length,
      'duplicate (deviceId, localDate) in one request',
    ),
});
export type UsageSyncRequest = z.infer<typeof UsageSyncRequest>;

export const UsageSyncResult = z.object({
  localDate: LocalDate,
  deviceId: Uuid,
  status: z.enum(['applied', 'stale', 'unchanged']),
  serverRev: Revision,
});
export const UsageSyncResponse = z.object({ results: z.array(UsageSyncResult) });
export type UsageSyncResponse = z.infer<typeof UsageSyncResponse>;

export const HistoryQuery = z.strictObject({ from: LocalDate, to: LocalDate });
export const HistoryResponse = z.object({ days: z.array(DailyAggregate) });

/* ───────────── Friends ───────────── */

export const FriendRequestCreate = z.union([
  z.strictObject({ handle: Handle }),
  z.strictObject({ inviteCode: z.string().regex(/^[A-HJ-NP-Z2-9]{10}$/) }),
]);
export const Friend = z.object({
  userId: z.string(),
  handle: Handle,
  displayName: DisplayName.nullable(),
  status: z.enum(['pending_out', 'pending_in', 'accepted']),
  since: z.iso.datetime(),
});
export const FriendsResponse = z.object({ friends: z.array(Friend) });

/* ───────────── Challenges ───────────── */

export const ChallengeCreate = z
  .strictObject({
    title: DisplayName,
    metric: z.enum(['fewest_views', 'fewest_minutes', 'goal_days']),
    startDate: LocalDate,
    endDate: LocalDate,
    tz: TimeZone,
    maxMembers: z.int().min(2).max(50),
  })
  .refine((c) => c.endDate >= c.startDate, {
    message: 'endDate before startDate',
    path: ['endDate'],
  });

export const LeaderboardEntry = z.object({
  rank: z.int().min(1),
  userId: z.string(),
  handle: Handle,
  score: z.number(),
  /** 'device' = from verified device aggregates; 'self' = self-reported check-in (iOS). */
  scoreSource: z.enum(['device', 'self']),
});
export const LeaderboardResponse = z.object({
  challengeId: Uuid,
  asOf: LocalDate,
  entries: z.array(LeaderboardEntry).max(50),
});

/* ───────────── Billing ───────────── */

export const PlayVerifyRequest = z.strictObject({
  productId: z.string().min(1).max(150),
  purchaseToken: z.string().min(10).max(4096),
});
export const AppStoreVerifyRequest = z.strictObject({
  signedTransaction: z.string().min(10).max(16384),
});
export const VerifyResponse = z.object({ entitlement: Entitlement });

/* ───────────── Devices / push ───────────── */

export const DeviceRegister = z.strictObject({
  deviceId: Uuid,
  platform: Platform,
  pushToken: z.string().min(16).max(4096),
});

/* ───────────── Account ───────────── */

export const DeletionStatus = z.object({
  state: z.enum(['none', 'requested', 'in_progress', 'completed']),
  requestedAt: z.iso.datetime().nullable(),
});
