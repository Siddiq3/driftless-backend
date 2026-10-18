import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { v1 } from '@siddiq3/driftless-contracts';
import { route } from '../src/router.js';
import { bodyOf, event, newSub } from './helpers.js';

const goal = (over: Partial<v1.Goal> = {}): v1.Goal => ({
  goalId: randomUUID(),
  metric: 'minutes',
  dailyLimit: 45,
  enabled: true,
  rev: 1,
  ...over,
});
const put = (sub: string, goals: unknown[]) =>
  route(event({ method: 'PUT', path: '/v1/goals', sub, body: { goals } }));
const get = (sub: string) => route(event({ path: '/v1/goals', sub }));

describe('goals', () => {
  it('starts empty, then stores the set', async () => {
    const sub = newSub();
    expect(v1.GoalsResponse.parse(bodyOf(await get(sub))).goals).toEqual([]);
    const g = goal();
    const r = await put(sub, [g]);
    expect(r.statusCode).toBe(200);
    expect(v1.GoalsResponse.parse(bodyOf(await get(sub))).goals).toEqual([g]);
  });

  it('replaces the set: missing goals are deleted', async () => {
    const sub = newSub();
    const a = goal();
    const b = goal({ metric: 'views', dailyLimit: 30 });
    await put(sub, [a, b]);
    await put(sub, [{ ...b, rev: 2, dailyLimit: 20 }]);
    const goals = v1.GoalsResponse.parse(bodyOf(await get(sub))).goals;
    expect(goals).toHaveLength(1);
    expect(goals[0]).toMatchObject({ goalId: b.goalId, dailyLimit: 20, rev: 2 });
  });

  it('rejects an older rev of a goal with 409 and changes nothing', async () => {
    const sub = newSub();
    const a = goal({ rev: 3 });
    await put(sub, [a]);
    const r = await put(sub, [{ ...a, rev: 2, dailyLimit: 999 }]);
    expect(r.statusCode).toBe(409);
    expect(bodyOf(r).code).toBe('goal_conflict');
    expect(v1.GoalsResponse.parse(bodyOf(await get(sub))).goals[0]!.dailyLimit).toBe(45);
  });

  it('validates limits, count and duplicates', async () => {
    const sub = newSub();
    expect((await put(sub, [goal({ dailyLimit: 1441 })])).statusCode).toBe(400);
    expect(
      (
        await put(
          sub,
          Array.from({ length: 11 }, () => goal()),
        )
      ).statusCode,
    ).toBe(400);
    const g = goal();
    expect((await put(sub, [g, g])).statusCode).toBe(400);
  });

  it("users can't see or overwrite each other's goals", async () => {
    const a = newSub();
    const b = newSub();
    const g = goal();
    await put(a, [g]);
    expect(v1.GoalsResponse.parse(bodyOf(await get(b))).goals).toEqual([]);
    await put(b, [{ ...g, dailyLimit: 5 }]); // same goalId, different user = separate item
    expect(v1.GoalsResponse.parse(bodyOf(await get(a))).goals[0]!.dailyLimit).toBe(45);
  });
});
