import { afterEach, describe, expect, it, vi } from 'vitest';
import { ddb } from '../src/lib/ddb.js';
import { route } from '../src/router.js';
import { event } from './helpers.js';
afterEach(() => vi.restoreAllMocks());
describe('public readiness', () => {
  it('checks Lambda and database readiness without login or exposing data', async () => {
    const response = await route(event({ path: '/health', sub: null }));
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true });
    expect(response.headers?.['cache-control']).toBe('no-store');
  });
  it('reports an unavailable database without exposing infrastructure errors', async () => {
    vi.spyOn(ddb(), 'send').mockRejectedValueOnce(new Error('private table name and credentials'));
    const response = await route(event({ path: '/health', sub: null }));
    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toEqual({ ok: false });
  });
  it('keeps application data and unsupported health methods authenticated', async () => {
    for (const options of [{ path: '/v1/me' }, { path: '/health', method: 'POST' }]) {
      expect((await route(event({ ...options, sub: null }))).statusCode).toBe(401);
    }
  });
});
