import { describe, expect, it } from 'vitest';
import {
  buildOpenApi,
  isValidLocalDate,
  isValidTimeZone,
  LocalDate,
  ROUTES,
  v1,
} from '../src/index.js';

const DEVICE = '0192f0a4-7c1e-7a3b-9c2d-1e2f3a4b5c6d';

const day = (over: Record<string, unknown> = {}) => ({
  localDate: '2026-10-18',
  tz: 'Asia/Kolkata',
  platform: 'android',
  deviceId: DEVICE,
  views: 12,
  adViews: 1,
  minutes: 34,
  coverage: 0.97,
  rev: 3,
  ...over,
});

describe('LocalDate', () => {
  it.each(['2026-10-18', '2028-02-29', '2026-12-31'])('accepts %s', (d) => {
    expect(LocalDate.safeParse(d).success).toBe(true);
  });
  it.each(['2026-02-30', '2027-02-29', '2026-13-01', '2026-1-01', '20261018', '2019-12-31', ''])(
    'rejects %s',
    (d) => {
      expect(isValidLocalDate(d)).toBe(false);
      expect(LocalDate.safeParse(d).success).toBe(false);
    },
  );
});

describe('TimeZone', () => {
  it('accepts IANA names', () => {
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true);
    expect(isValidTimeZone('America/Los_Angeles')).toBe(true);
  });
  it('rejects garbage', () => {
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone('x'.repeat(65))).toBe(false);
  });
});

describe('DailyAggregate', () => {
  it('preserves optional personal counts without changing competitive views', () => {
    expect(v1.DailyAggregate.parse(day({ views: null, personalViews: 73 }))).toMatchObject({
      views: null,
      personalViews: 73,
    });
    expect(v1.DailyAggregate.safeParse(day({ personalViews: -1 })).success).toBe(false);
    expect(
      v1.DailyAggregate.safeParse(
        day({ platform: 'ios', views: null, adViews: null, personalViews: 73 }),
      ).success,
    ).toBe(false);
  });
  it('accepts days without coverage and still validates legacy coverage', () => {
    const current: Record<string, unknown> = { ...day() };
    delete current.coverage;
    expect(v1.DailyAggregate.safeParse(current).success).toBe(true);
    expect(v1.DailyAggregate.safeParse({ ...current, coverage: 0.5 }).success).toBe(true);
  });

  it('accepts a valid Android day', () => {
    expect(v1.DailyAggregate.safeParse(day()).success).toBe(true);
  });
  it('accepts null counts (not tracked) and never coerces them', () => {
    const r = v1.DailyAggregate.parse(
      day({ views: null, adViews: null, minutes: null, coverage: 0 }),
    );
    expect(r.views).toBeNull();
  });
  it('rejects video counts on iOS', () => {
    expect(v1.DailyAggregate.safeParse(day({ platform: 'ios' })).success).toBe(false);
    expect(
      v1.DailyAggregate.safeParse(day({ platform: 'ios', views: null, adViews: null })).success,
    ).toBe(true);
  });
  it.each([
    ['negative views', { views: -1 }],
    ['absurd views', { views: 5001 }],
    ['minutes over a day', { minutes: 1441 }],
    ['fractional views', { views: 1.5 }],
    ['coverage > 1', { coverage: 1.01 }],
    ['rev 0', { rev: 0 }],
    ['bad device id', { deviceId: 'abc' }],
    ['unknown field', { userId: 'someone-else' }],
  ])('rejects %s', (_n, over) => {
    expect(v1.DailyAggregate.safeParse(day(over)).success).toBe(false);
  });
});

describe('UsageSyncRequest', () => {
  it('rejects empty and > 31 days', () => {
    expect(v1.UsageSyncRequest.safeParse({ days: [] }).success).toBe(false);
    const many = Array.from({ length: 32 }, (_, i) =>
      day({ localDate: i < 31 ? `2026-01-${String(i + 1).padStart(2, '0')}` : '2026-02-01' }),
    );
    expect(v1.UsageSyncRequest.safeParse({ days: many.slice(0, 31) }).success).toBe(true);
    expect(v1.UsageSyncRequest.safeParse({ days: many }).success).toBe(false);
  });
  it('rejects duplicate device/day pairs in one request', () => {
    expect(v1.UsageSyncRequest.safeParse({ days: [day(), day({ rev: 4 })] }).success).toBe(false);
  });
});

describe('PatchMeRequest', () => {
  it('requires at least one field', () => {
    expect(v1.PatchMeRequest.safeParse({}).success).toBe(false);
  });
  it('rejects attempts to set entitlement or other unknown fields', () => {
    expect(v1.PatchMeRequest.safeParse({ tier: 'pro' }).success).toBe(false);
    expect(v1.PatchMeRequest.safeParse({ displayName: 'Sam', entitlement: {} }).success).toBe(
      false,
    );
  });
  it('validates handle format and display-name control chars', () => {
    expect(v1.PatchMeRequest.safeParse({ handle: 'Sam' }).success).toBe(false);
    expect(v1.PatchMeRequest.safeParse({ handle: 'sam_k' }).success).toBe(true);
    expect(v1.PatchMeRequest.safeParse({ displayName: 'a\u0007b' }).success).toBe(false);
  });
});

describe('Goals', () => {
  it.each(['setup-views', 'setup-minutes'])('rejects legacy onboarding ID %s', (goalId) => {
    expect(
      v1.PutGoalsRequest.safeParse({
        goals: [{ goalId, metric: 'views', dailyLimit: 50, enabled: true, rev: 1 }],
      }).success,
    ).toBe(false);
  });

  const goal = { goalId: DEVICE, metric: 'minutes', dailyLimit: 60, enabled: true, rev: 1 };
  it('enforces minutes ≤ 1440 and unique ids', () => {
    expect(v1.PutGoalsRequest.safeParse({ goals: [goal] }).success).toBe(true);
    expect(v1.PutGoalsRequest.safeParse({ goals: [{ ...goal, dailyLimit: 1500 }] }).success).toBe(
      false,
    );
    expect(v1.PutGoalsRequest.safeParse({ goals: [goal, goal] }).success).toBe(false);
  });
});

describe('ChallengeCreate', () => {
  it('rejects end before start', () => {
    const c = {
      title: 'Oct',
      metric: 'goal_days',
      startDate: '2026-10-20',
      endDate: '2026-10-19',
      tz: 'UTC',
      maxMembers: 5,
    };
    expect(v1.ChallengeCreate.safeParse(c).success).toBe(false);
    expect(v1.ChallengeCreate.safeParse({ ...c, endDate: '2026-10-27' }).success).toBe(true);
  });
});

describe('OpenAPI', () => {
  const doc = buildOpenApi() as {
    openapi: string;
    paths: Record<string, Record<string, { parameters: unknown[] }>>;
  };
  it('covers every route exactly once', () => {
    const keys = ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const r of ROUTES) expect(doc.paths[r.path]?.[r.method]).toBeDefined();
  });
  it('declares Idempotency-Key on mutating idempotent routes', () => {
    expect(doc.paths['/v1/usage/sync']?.post?.parameters).toEqual([
      expect.objectContaining({ in: 'header', name: 'Idempotency-Key', required: true }),
      expect.objectContaining({ in: 'header', name: 'X-Account-Incarnation', required: true }),
    ]);
  });
  it('documents conditional goal writes and goal snapshot ETags', () => {
    expect(doc.paths['/v1/goals']?.put?.parameters).toEqual([
      expect.objectContaining({ in: 'header', name: 'If-Match', required: false }),
      expect.objectContaining({ in: 'header', name: 'X-Account-Incarnation', required: true }),
    ]);
    const paths = buildOpenApi().paths as Record<
      string,
      Record<string, { responses: Record<string, { headers: unknown }> }>
    >;
    for (const method of ['get', 'put']) {
      expect(paths['/v1/goals']?.[method]?.responses['200']?.headers).toHaveProperty('ETag');
    }
  });
  it('is OpenAPI 3.1', () => {
    expect(doc.openapi).toBe('3.1.0');
  });
});
