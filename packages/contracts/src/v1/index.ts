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

/** Lifecycle discovery never activates or imports a legacy dataset. */
export const AccountState = z.object({
  state: z.enum(['active', 'deleting', 'deleted', 'legacy_quarantined']),
  incarnation: Uuid.nullable(),
});
export const RegisterAccountRequest = z.strictObject({
  registrationId: Uuid,
  expectedIncarnation: Uuid.nullable(),
});

export const MeResponse = z.object({
  userId: z.string(),
  incarnation: Uuid,
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

export const GoalsResponse = z.object({ goals: z.array(Goal) });
export type GoalsResponse = z.infer<typeof GoalsResponse>;

/* ───────────── Usage sync ───────────── */

/**
 * One device's aggregate for one local calendar day.
 * `null` counts mean "not tracked" — never coerce to 0.
 */
export const PersonalAppViews = z.strictObject({
  'com.instagram.android': z.int().min(0).max(100_000).nullable().optional(),
  'com.google.android.youtube': z.int().min(0).max(100_000).nullable().optional(),
});
export const DailyAggregate = z
  .strictObject({
    localDate: LocalDate,
    tz: TimeZone,
    platform: Platform,
    deviceId: Uuid,
    views: z.int().min(0).max(5000).nullable(),
    adViews: z.int().min(0).max(5000).nullable(),
    /** Recorded total for backup/restore and comparisons when separately shared. */
    personalViews: z.int().min(0).max(100_000).nullable().optional(),
    personalAppViews: PersonalAppViews.optional(),
    minutes: z.int().min(0).max(1440).nullable(),
    /** Legacy clients only. Current clients do not send tracking coverage. */
    coverage: z.number().min(0).max(1).optional(),
    rev: Revision,
  })
  .refine(
    (a) =>
      a.platform === 'android' ||
      (a.views === null &&
        a.adViews === null &&
        a.personalViews == null &&
        a.personalAppViews == null),
    {
      message: 'iOS aggregates cannot carry video counts',
      path: ['views'],
    },
  )
  .refine(
    (a) =>
      !a.personalAppViews ||
      a.personalViews == null ||
      Object.values(a.personalAppViews).some((n) => n === null) ||
      Object.values(a.personalAppViews).reduce<number>((sum, n) => sum + (n ?? 0), 0) ===
        a.personalViews,
    { message: 'Platform counts must equal personalViews', path: ['personalAppViews'] },
  );
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

export const HistoryQuery = z.strictObject({
  from: LocalDate,
  to: LocalDate,
  includePersonal: z.enum(['true', 'false']).optional(),
});
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
export type Friend = z.infer<typeof Friend>;
export const FriendsResponse = z.object({ friends: z.array(Friend) });
export const FriendsDailyQuery = z.strictObject({ date: LocalDate });
export const DailyFriendCount = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('eligible'),
    views: z.number().int().nonnegative(),
    updatedAt: z.iso.datetime(),
  }),
  z.object({ status: z.enum(['private', 'unavailable']), views: z.null(), updatedAt: z.null() }),
]);
export const FriendsDailyResponse = z.object({
  localDate: LocalDate,
  self: DailyFriendCount,
  friends: z.array(Friend.extend({ daily: DailyFriendCount })),
});
export type FriendsDailyResponse = z.infer<typeof FriendsDailyResponse>;

/** A one-time code a user shares to let someone add them (expires; 10 chars, no 0/O/1/I). */
export const InviteResponse = z.object({ code: z.string(), expiresAt: z.iso.datetime() });
export const FriendRespond = z.strictObject({ userId: Uuid, accept: z.boolean() });
export const FriendRemove = z.strictObject({ userId: Uuid });
export const FriendRequestResult = z.object({ friend: Friend });

/** Link-based, ongoing daily battle sharing. Neither action changes global friend sharing. */
export const BattleLinkConsent = z.strictObject({ scoreConsent: z.literal(true) });
export const BattleLinkCode = z.string().regex(/^[A-HJ-NP-Z2-9]{10}$/);
export const BattleLinkPreview = z.object({
  code: BattleLinkCode,
  isSelf: z.boolean(),
  expiresAt: z.iso.datetime(),
});

/* ───────────── Challenges ───────────── */

export const ChallengeCreate = z
  .strictObject({
    title: DisplayName,
    metric: z.enum(['fewest_views', 'fewest_minutes', 'goal_days']),
    startDate: LocalDate,
    endDate: LocalDate,
    tz: TimeZone,
    maxMembers: z.int().min(2).max(50),
    targetUserId: Uuid.optional(),
    operationId: Uuid.optional(),
    scoreConsent: z.literal(true).optional(),
  })
  .refine((c) => c.endDate >= c.startDate, {
    message: 'endDate before startDate',
    path: ['endDate'],
  })
  .refine(
    (c) =>
      !c.targetUserId || (c.maxMembers === 2 && Boolean(c.operationId) && c.scoreConsent === true),
    {
      message: 'Direct battles require two places, an operation ID and battle-only score consent',
      path: ['targetUserId'],
    },
  );

export const BattleInvitationState = z.enum([
  'pending',
  'accepted',
  'declined',
  'cancelled',
  'expired',
  'unavailable',
]);
export const ChallengeJoin = z.strictObject({ scoreConsent: z.literal(true).optional() });
export const BattleInvitationAction = z.strictObject({ action: z.enum(['decline', 'cancel']) });
export const BattleScoreConsent = z.strictObject({ share: z.boolean() });
export const ChallengeSummary = z.object({
  challengeId: Uuid,
  /** Null after the creator has deleted their account; other memberships remain intact. */
  ownerId: z.string().nullable(),
  title: DisplayName,
  metric: z.enum(['fewest_views', 'fewest_minutes', 'goal_days']),
  startDate: LocalDate,
  endDate: LocalDate,
  tz: TimeZone,
  maxMembers: z.int().min(2).max(50),
  memberCount: z.int().min(0),
  targetUserId: Uuid.optional(),
  invitationState: BattleInvitationState.optional(),
  ownerName: z.string().nullable().optional(),
  myScoreConsent: z.boolean().optional(),
});
export type ChallengeSummary = z.infer<typeof ChallengeSummary>;
export const ChallengesResponse = z.object({
  challenges: z.array(ChallengeSummary),
  invitations: z.array(ChallengeSummary).optional(),
});

export const LeaderboardEntry = z.object({
  rank: z.int().min(1),
  userId: z.string(),
  handle: Handle,
  score: z.number(),
  /** 'device' = from verified device aggregates; 'self' = self-reported check-in (iOS). */
  scoreSource: z.enum(['device', 'self']),
  availableDays: z.int().min(0).optional(),
});
export const LeaderboardResponse = z.object({
  challengeId: Uuid,
  asOf: LocalDate,
  entries: z.array(LeaderboardEntry).max(50),
  participants: z
    .array(
      z.object({
        userId: z.string(),
        handle: Handle.nullable(),
        status: z.enum([
          'ready',
          'no_data',
          'sharing_off',
          'expired',
          'unavailable',
          'awaiting_opponent',
        ]),
        availableDays: z.int().min(0),
        expectedDays: z.int().min(0),
      }),
    )
    .max(50)
    .optional(),
  /** Members without a currently authorized usable score. Missing is never zero. */
  hiddenMembers: z.int().min(0).optional(),
});
export type LeaderboardResponse = z.infer<typeof LeaderboardResponse>;

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
  pushToken: z.string().min(16).max(4096).optional(),
});

/* ───────────── Account ───────────── */

export const DeletionStatus = z.object({
  state: z.enum(['none', 'requested', 'in_progress', 'completed']),
  requestedAt: z.iso.datetime().nullable(),
});

/* ───────────── Private daily / weekly recaps (aggregate data only) ───────────── */
export const WrapPeriod = z.enum(['daily', 'weekly']);
export const WrapQuery = z.strictObject({ period: WrapPeriod, end: LocalDate });
const WrapMetric = z.object({
  value: z.number().int().nonnegative().nullable(),
  trackedDays: z.number().int().min(0).max(7),
});
export const WrapResponse = z.object({
  period: WrapPeriod,
  source: z.literal('synced'),
  from: LocalDate,
  to: LocalDate,
  previousFrom: LocalDate,
  previousTo: LocalDate,
  expectedDays: z.number().int().min(1).max(7),
  views: WrapMetric,
  minutes: WrapMetric,
  previousViews: WrapMetric,
  changePercent: z.number().int().nullable(),
});
export type WrapResponse = z.infer<typeof WrapResponse>;
