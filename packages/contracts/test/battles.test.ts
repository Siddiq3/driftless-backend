import { describe, expect, it } from 'vitest';
import { v1, buildOpenApi, ROUTES } from '../src/index.js';
const uuid = '00000000-0000-4000-8000-000000000001';
const direct = {
  title: 'Scroll battle',
  metric: 'fewest_views',
  startDate: '2026-10-26',
  endDate: '2026-11-01',
  tz: 'UTC',
  maxMembers: 2,
  targetUserId: uuid,
  operationId: uuid,
  scoreConsent: true,
};
describe('direct battle contract', () => {
  it('requires a targeted creation to include explicit score consent and exactly two places', () => {
    expect(v1.ChallengeCreate.safeParse(direct).success).toBe(true);
    for (const patch of [
      { scoreConsent: undefined },
      { operationId: undefined },
      { maxMembers: 10 },
      { targetUserId: 'bad' },
      { unexpected: 'ignored?' },
    ])
      expect(v1.ChallengeCreate.safeParse({ ...direct, ...patch }).success).toBe(false);
  });
  it('allows legacy generic creation without silently adding consent', () => {
    const { targetUserId, operationId, scoreConsent, ...legacy } = direct;
    expect(v1.ChallengeCreate.parse(legacy)).not.toHaveProperty('scoreConsent');
    expect(targetUserId).toBe(uuid);
    expect(operationId).toBe(uuid);
    expect(scoreConsent).toBe(true);
  });
  it('uses existing challenge membership plus documented invitation and score-consent operations', () => {
    expect(v1.ChallengeJoin.parse({ scoreConsent: true })).toEqual({ scoreConsent: true });
    expect(v1.BattleInvitationAction.safeParse({ action: 'accept' }).success).toBe(false);
    expect(v1.BattleScoreConsent.parse({ share: false })).toEqual({ share: false });
    expect(ROUTES.some((r) => r.path === '/v1/challenges/{id}/invitation')).toBe(true);
    expect(buildOpenApi()).toBeDefined();
  });
  it('represents unavailable participants without a fabricated numeric score', () => {
    const result = v1.LeaderboardResponse.parse({
      challengeId: uuid,
      asOf: '2026-10-26',
      entries: [],
      hiddenMembers: 1,
      participants: [
        { userId: uuid, handle: null, status: 'no_data', availableDays: 0, expectedDays: 1 },
      ],
    });
    expect(result.participants?.[0]).not.toHaveProperty('score');
    expect(v1.BattleInvitationState.options).toEqual([
      'pending',
      'accepted',
      'declined',
      'cancelled',
      'expired',
      'unavailable',
    ]);
  });
});
