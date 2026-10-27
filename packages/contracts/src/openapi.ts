import {
  AccountUsageHistory,
  AccountUsageHistoryQuery,
  AccountUsageConfigure,
  AccountUsageReconcile,
  AccountUsageReserve,
  AccountUsageResponse,
} from './account-usage.js';
import { z } from 'zod';
import { Problem } from './common.js';
import * as v1 from './v1/index.js';

type Route = {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  summary: string;
  request?: z.ZodType;
  query?: z.ZodObject;
  response?: z.ZodType;
  idempotent?: boolean;
  auth?: boolean;
};

/** Single source of truth for the v1 HTTP surface. The API router is tested against this list. */
export const ROUTES: readonly Route[] = [
  {
    method: 'post',
    path: '/v1/battles/invites',
    summary:
      'Create a seven-day link granting holders the choice to join ongoing daily battle sharing',
    request: v1.BattleLinkConsent,
    response: v1.InviteResponse,
  },
  {
    method: 'get',
    path: '/v1/battles/invites/{code}',
    summary: 'Preview a battle invitation without accepting',
    response: v1.BattleLinkPreview,
  },
  {
    method: 'post',
    path: '/v1/battles/invites/{code}/accept',
    summary: 'Accept daily battle sharing and reciprocal friendship; retries are idempotent',
    request: v1.BattleLinkConsent,
  },
  {
    method: 'get',
    path: '/v1/battles/daily',
    summary: 'Daily totals of mutually accepted battle friends from acceptance onward',
    query: v1.FriendsDailyQuery,
    response: v1.FriendsDailyResponse,
  },
  {
    method: 'get',
    path: '/v1/usage/account/history',
    summary: 'Retained account period summaries with requesting device baseline',
    query: AccountUsageHistoryQuery,
    response: AccountUsageHistory,
  },
  {
    method: 'get',
    path: '/v1/usage/account',
    summary: 'Authoritative account period and usage',
    response: AccountUsageResponse,
  },
  {
    method: 'put',
    path: '/v1/usage/account',
    summary: 'Fixed timezone setup or next-day limits',
    request: AccountUsageConfigure,
    response: AccountUsageResponse,
  },
  {
    method: 'post',
    path: '/v1/usage/account/reconcile',
    summary: 'Cumulative device accounting contributions',
    request: AccountUsageReconcile,
  },
  {
    method: 'post',
    path: '/v1/usage/account/reserve',
    summary: 'Reserve period allowance atomically',
    request: AccountUsageReserve,
    response: AccountUsageResponse,
  },
  {
    method: 'get',
    path: '/v1/account',
    summary: 'Discover lifecycle without activating legacy data',
    response: v1.AccountState,
  },
  {
    method: 'post',
    path: '/v1/account/register',
    summary: 'Explicitly register an empty incarnation',
    request: v1.RegisterAccountRequest,
    response: v1.AccountState,
  },
  {
    method: 'get',
    path: '/v1/wrapped',
    summary: 'Private daily or weekly recap of synced aggregates',
    response: v1.WrapResponse,
  },
  {
    method: 'get',
    path: '/v1/me',
    summary: 'Profile, entitlement, capabilities',
    response: v1.MeResponse,
  },
  {
    method: 'patch',
    path: '/v1/me',
    summary: 'Update profile (If-Match: rev)',
    request: v1.PatchMeRequest,
    response: v1.MeResponse,
  },
  {
    method: 'get',
    path: '/v1/goals',
    summary: 'List goals with a whole-set ETag',
    response: v1.GoalsResponse,
  },
  {
    method: 'put',
    path: '/v1/goals',
    summary: 'Replace goals (If-Match: goal-set ETag; per-goal rev guards also apply)',
    request: v1.PutGoalsRequest,
    response: v1.GoalsResponse,
  },
  {
    method: 'post',
    path: '/v1/usage/sync',
    summary: 'Push daily aggregates',
    request: v1.UsageSyncRequest,
    response: v1.UsageSyncResponse,
    idempotent: true,
  },
  {
    method: 'get',
    path: '/v1/usage/history',
    summary: 'History range (opt in to personal recorded counts)',
    query: v1.HistoryQuery,
    response: v1.HistoryResponse,
  },
  { method: 'get', path: '/v1/friends', summary: 'List friends', response: v1.FriendsResponse },
  {
    method: 'get',
    path: '/v1/friends/daily',
    summary: 'Compare consented eligible counts for a local date',
    query: v1.FriendsDailyQuery,
    response: v1.FriendsDailyResponse,
  },
  {
    method: 'post',
    path: '/v1/friends/requests',
    summary: 'Send friend request (by handle) or connect instantly (by invite code)',
    request: v1.FriendRequestCreate,
    response: v1.FriendRequestResult,
    idempotent: true,
  },
  {
    method: 'post',
    path: '/v1/friends/invites',
    summary: 'Create a one-time invite code',
    response: v1.InviteResponse,
  },
  {
    method: 'post',
    path: '/v1/friends/respond',
    summary: 'Accept or decline a friend request',
    request: v1.FriendRespond,
  },
  {
    method: 'post',
    path: '/v1/friends/remove',
    summary: 'Remove a friend or cancel a request',
    request: v1.FriendRemove,
  },
  {
    method: 'get',
    path: '/v1/challenges',
    summary: 'My challenges',
    response: v1.ChallengesResponse,
  },
  {
    method: 'post',
    path: '/v1/challenges/{id}/join',
    summary: 'Join a friend’s challenge; targeted invitation acceptance needs score consent',
    request: v1.ChallengeJoin,
    response: v1.ChallengeSummary,
  },
  {
    method: 'post',
    path: '/v1/challenges/{id}/leave',
    summary: 'Leave a challenge',
  },
  {
    method: 'post',
    path: '/v1/challenges/{id}/invitation',
    summary: 'Decline a targeted invitation or cancel your direct battle',
    request: v1.BattleInvitationAction,
    response: v1.ChallengeSummary,
  },
  {
    method: 'put',
    path: '/v1/challenges/{id}/score-consent',
    summary: 'Set battle-only score visibility until the end date',
    request: v1.BattleScoreConsent,
    response: v1.ChallengeSummary,
  },
  { method: 'delete', path: '/v1/devices/{id}', summary: 'Unregister a push device' },
  {
    method: 'post',
    path: '/v1/challenges',
    summary:
      'Create challenge; operationId durably deduplicates creation (required for direct battles)',
    request: v1.ChallengeCreate,
    response: v1.ChallengeSummary,
  },
  {
    method: 'get',
    path: '/v1/challenges/{id}/leaderboard',
    summary: 'Leaderboard',
    response: v1.LeaderboardResponse,
  },
  {
    method: 'post',
    path: '/v1/billing/play/verify',
    summary: 'Verify Play purchase',
    request: v1.PlayVerifyRequest,
    response: v1.VerifyResponse,
    idempotent: true,
  },
  {
    method: 'post',
    path: '/v1/devices',
    summary: 'Register push device',
    request: v1.DeviceRegister,
  },
  {
    method: 'post',
    path: '/v1/account/delete',
    summary: 'Request account deletion',
    response: v1.DeletionStatus,
    idempotent: true,
  },
  { method: 'get', path: '/v1/account/export', summary: 'Export all my data (JSON)' },
  {
    method: 'get',
    path: '/v1/account/delete',
    summary: 'Deletion status',
    response: v1.DeletionStatus,
  },
];

const schema = (s: z.ZodType) => z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' });

export function buildOpenApi(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of ROUTES) {
    const op: Record<string, unknown> = {
      summary: r.summary,
      security: r.auth === false ? [] : [{ cognito: [] }],
      parameters: r.idempotent
        ? [
            {
              in: 'header',
              name: 'Idempotency-Key',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
          ]
        : [],
      responses: {
        '200': r.response
          ? { description: 'OK', content: { 'application/json': { schema: schema(r.response) } } }
          : { description: 'OK' },
        default: {
          description: 'Error',
          content: { 'application/problem+json': { schema: schema(Problem) } },
        },
      },
    };
    if (r.query) {
      const q = schema(r.query);
      (op.parameters as unknown[]).push(
        ...Object.entries(q.properties ?? {}).map(([name, value]) => ({
          in: 'query',
          name,
          required: q.required?.includes(name) ?? false,
          schema: value,
        })),
      );
    }
    if (r.path === '/v1/goals') {
      if (r.method === 'put')
        op.parameters = [
          {
            in: 'header',
            name: 'If-Match',
            required: false,
            description:
              'ETag from GET /v1/goals. Use for safe whole-set replacement; stale snapshots return 412. Optional for legacy clients.',
            schema: { type: 'string' },
          },
        ];
      const responses = op.responses as Record<string, Record<string, unknown>>;
      responses['200']!.headers = {
        ETag: { description: 'Current goal-set revision', schema: { type: 'string' } },
      };
    }
    if (r.request) {
      op.requestBody = {
        required: true,
        content: { 'application/json': { schema: schema(r.request) } },
      };
    }
    if (r.auth !== false && !['/v1/account', '/v1/account/register'].includes(r.path)) {
      (op.parameters as unknown[]).push({
        in: 'header',
        name: 'X-Account-Incarnation',
        required: !(r.path === '/v1/me' && r.method === 'get'),
        description:
          'Exact incarnation returned by lifecycle discovery/registration. Required for account data and deletion; never inferred for writes.',
        schema: { type: 'string', format: 'uuid' },
      });
    }
    (paths[r.path] ??= {})[r.method] = op;
  }
  return {
    openapi: '3.1.0',
    info: { title: 'Driftless API', version: '1.0.0' },
    components: {
      securitySchemes: { cognito: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    },
    paths,
  };
}
