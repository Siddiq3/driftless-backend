import { describe, it, expect } from 'vitest';
import { accountPeriod, accountPeriodForDate } from '../src/domain/account-period.js';

describe('fixed account calendar periods', () => {
  it.each([
    ['2026-03-08T16:00:00Z', 'America/New_York', 23],
    ['2026-11-01T16:00:00Z', 'America/New_York', 25],
    ['2026-10-25T12:00:00Z', 'Asia/Kolkata', 24],
  ])('uses DST-aware UTC boundaries for %s', (at, tz, hours) => {
    const p = accountPeriod(Date.parse(at), tz, 'incarnation');
    expect(p.endMs - p.startMs).toBe(hours * 3600000);
    expect(accountPeriod(p.startMs - 1, tz, 'incarnation').periodId).not.toBe(p.periodId);
    expect(accountPeriod(p.startMs, tz, 'incarnation').periodId).toBe(p.periodId);
    expect(accountPeriod(p.endMs - 1, tz, 'incarnation').periodId).toBe(p.periodId);
    expect(accountPeriod(p.endMs, tz, 'incarnation').periodId).not.toBe(p.periodId);
  });
  it('does not depend on host timezone and separates incarnations', () => {
    const at = Date.parse('2026-10-25T00:00:00Z');
    expect(accountPeriod(at, 'America/Los_Angeles', 'a').localDate).toBe('2026-10-24');
    expect(accountPeriod(at, 'Asia/Kolkata', 'a').localDate).toBe('2026-10-25');
    expect(accountPeriod(at, 'Asia/Kolkata', 'b').periodId).not.toBe(
      accountPeriod(at, 'Asia/Kolkata', 'a').periodId,
    );
  });
  it.each(['Pacific/Kiritimati', 'Pacific/Honolulu', 'America/New_York'])(
    'resolves named historical dates in %s',
    (tz) => {
      const p = accountPeriodForDate('2026-11-01', tz, 'a');
      expect(p.localDate).toBe('2026-11-01');
      expect(accountPeriod(p.startMs, tz, 'a')).toEqual(p);
    },
  );
});
