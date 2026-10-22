import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { json, HttpError } from '../src/lib/http.js';
import { IN_PROGRESS_LEASE_SEC, withIdempotency } from '../src/lib/idempotency.js';
import { event, newSub } from './helpers.js';
const post = (key, body) =>
  event({
    method: 'POST',
    path: '/v1/usage/sync',
    body,
    headers: key === null ? {} : { 'idempotency-key': key },
  });
describe('withIdempotency', () => {
  it('runs once and replays the stored response for an identical retry', async () => {
    const sub = newSub();
    const key = randomUUID();
    let calls = 0;
    const fn = async () => json(200, { n: ++calls });
    const body = JSON.stringify({ a: 1 });
    const first = await withIdempotency(post(key, { a: 1 }), sub, body, fn);
    const second = await withIdempotency(post(key, { a: 1 }), sub, body, fn);
    expect(calls).toBe(1);
    expect(second.body).toBe(first.body);
    expect(second.headers?.['idempotent-replayed']).toBe('true');
  });
  it('rejects reuse of a key for a different request (422)', async () => {
    const sub = newSub();
    const key = randomUUID();
    const fn = async () => json(200, {});
    await withIdempotency(post(key, { a: 1 }), sub, '{"a":1}', fn);
    await expect(withIdempotency(post(key, { a: 2 }), sub, '{"a":2}', fn)).rejects.toMatchObject({
      status: 422,
      code: 'idempotency_key_reuse',
    });
  });
  it('keys are scoped per user: the same key from another user is independent', async () => {
    const key = randomUUID();
    let calls = 0;
    const fn = async () => json(200, { n: ++calls });
    await withIdempotency(post(key, {}), newSub(), '{}', fn);
    await withIdempotency(post(key, {}), newSub(), '{}', fn);
    expect(calls).toBe(2);
  });
  it('a concurrent duplicate while the first is in flight gets 409', async () => {
    const sub = newSub();
    const key = randomUUID();
    let release;
    const gate = new Promise((r) => (release = r));
    const slow = withIdempotency(post(key, {}), sub, '{}', async () => {
      await gate;
      return json(200, {});
    });
    await new Promise((r) => setTimeout(r, 200));
    await expect(
      withIdempotency(post(key, {}), sub, '{}', async () => json(200, {})),
    ).rejects.toMatchObject({
      status: 409,
      code: 'request_in_progress',
    });
    release();
    expect((await slow).statusCode).toBe(200);
  });
  it('a failed attempt releases the key so the client can retry', async () => {
    const sub = newSub();
    const key = randomUUID();
    await expect(
      withIdempotency(post(key, {}), sub, '{}', async () => {
        throw new HttpError(503, 'unavailable', 'try later');
      }),
    ).rejects.toBeInstanceOf(HttpError);
    const ok = await withIdempotency(post(key, {}), sub, '{}', async () => json(200, { ok: true }));
    expect(ok.statusCode).toBe(200);
  });
  it('non-2xx results are not stored', async () => {
    const sub = newSub();
    const key = randomUUID();
    let calls = 0;
    const fn = async () => json(++calls === 1 ? 400 : 200, {});
    expect((await withIdempotency(post(key, {}), sub, '{}', fn)).statusCode).toBe(400);
    expect((await withIdempotency(post(key, {}), sub, '{}', fn)).statusCode).toBe(200);
  });
  it('an abandoned in-progress lock can be taken over after the lease', async () => {
    const sub = newSub();
    const key = randomUUID();
    const t0 = 2_000_000_000;
    // Simulate a crash: start, never finish (fn never resolves within this test).
    void withIdempotency(
      post(key, {}),
      sub,
      '{}',
      () => new Promise(() => undefined),
      () => t0,
    );
    await new Promise((r) => setTimeout(r, 200));
    const later = () => t0 + IN_PROGRESS_LEASE_SEC + 1;
    const r = await withIdempotency(
      post(key, {}),
      sub,
      '{}',
      async () => json(200, { took: 'over' }),
      later,
    );
    expect(r.statusCode).toBe(200);
  });
  it('requires a UUID Idempotency-Key', async () => {
    const fn = async () => json(200, {});
    await expect(withIdempotency(post(null, {}), newSub(), '{}', fn)).rejects.toMatchObject({
      status: 428,
    });
    await expect(withIdempotency(post('abc', {}), newSub(), '{}', fn)).rejects.toMatchObject({
      status: 400,
    });
  });
});
