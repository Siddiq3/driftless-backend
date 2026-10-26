import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { v1, AccountUsageResponse } from '@siddiq3/driftless-contracts';
import { route } from '../src/router.js';
import { bodyOf, event, newAccount, newSub, ownerOf } from './helpers.js';
const call = (sub, method, path, extra = {}) => route(event({ sub, method, path, ...extra }));
describe('fresh installation account contract', () => {
  it('resolves the same incarnation and restores goals, private history and profile preferences without registration', async () => {
    const sub = await newAccount(),
      incarnation = ownerOf(sub),
      goalId = randomUUID(),
      deviceId = randomUUID();
    const date = new Date().toISOString().slice(0, 10);
    expect(
      (
        await call(sub, 'PATCH', '/v1/me', {
          headers: { 'if-match': '1' },
          body: { locale: 'hi', consent: { cloudSync: true } },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await call(sub, 'PUT', '/v1/goals', {
          headers: { 'if-match': '"goals-0"' },
          body: { goals: [{ goalId, metric: 'views', dailyLimit: 50, enabled: true, rev: 1 }] },
        })
      ).statusCode,
    ).toBe(200);
    const days = [
      {
        localDate: date,
        deviceId,
        tz: 'UTC',
        platform: 'android',
        views: null,
        personalViews: 50,
        adViews: null,
        minutes: 2,
        coverage: 1,
        rev: 1,
      },
    ];
    expect(
      (
        await call(sub, 'POST', '/v1/usage/sync', {
          headers: { 'idempotency-key': randomUUID() },
          body: { days },
        })
      ).statusCode,
    ).toBe(200);
    for (let attempt = 0; attempt < 2; attempt++) {
      const state = bodyOf(
        await call(sub, 'GET', '/v1/account', { headers: { 'x-account-incarnation': '' } }),
      );
      expect(state).toEqual({ state: 'active', incarnation });
      const me = v1.MeResponse.parse(bodyOf(await call(sub, 'GET', '/v1/me')));
      expect(me.incarnation).toBe(incarnation);
      expect(me.profile.locale).toBe('hi');
      const goals = v1.GoalsResponse.parse(bodyOf(await call(sub, 'GET', '/v1/goals')));
      expect(goals.goals).toHaveLength(1);
      expect(goals.goals[0].goalId).toBe(goalId);
      const history = bodyOf(
        await call(sub, 'GET', '/v1/usage/history', {
          query: { from: date, to: date, includePersonal: 'true' },
        }),
      );
      expect(history.days).toHaveLength(1);
      expect(history.days[0].personalViews).toBe(50);
      AccountUsageResponse.parse(bodyOf(await call(sub, 'GET', '/v1/usage/account')));
    }
  });
  it('a missing lifecycle never creates an account through discovery or me', async () => {
    const sub = newSub();
    expect(bodyOf(await call(sub, 'GET', '/v1/account'))).toEqual({
      state: 'legacy_quarantined',
      incarnation: null,
    });
    expect((await call(sub, 'GET', '/v1/me')).statusCode).toBe(409);
    expect(bodyOf(await call(sub, 'GET', '/v1/account')).incarnation).toBeNull();
  });
  it('deleted incarnation cannot be read after explicit fresh registration', async () => {
    const sub = await newAccount(),
      old = ownerOf(sub);
    expect((await call(sub, 'POST', '/v1/account/delete')).statusCode).toBe(200);
    expect(bodyOf(await call(sub, 'GET', '/v1/account')).state).toBe('deleted');
    const fresh = bodyOf(
      await call(sub, 'POST', '/v1/account/register', {
        body: { registrationId: randomUUID(), expectedIncarnation: old },
      }),
    );
    expect(fresh.state).toBe('active');
    expect(fresh.incarnation).not.toBe(old);
    expect(
      (await call(sub, 'GET', '/v1/me', { headers: { 'x-account-incarnation': old } })).statusCode,
    ).toBe(409);
    const me = bodyOf(
      await call(sub, 'GET', '/v1/me', { headers: { 'x-account-incarnation': fresh.incarnation } }),
    );
    expect(me.incarnation).toBe(fresh.incarnation);
  });
});
