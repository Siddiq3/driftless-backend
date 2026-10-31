import { expect, it } from 'vitest';
import { route } from '../src/router.js';
import { bodyOf, event, newAccount } from './helpers.js';

const SITE = 'https://scrollsnooze.vercel.app';
const check = (path, origin, method) =>
  route(
    event({
      method: 'OPTIONS',
      path,
      sub: null,
      headers: { origin, 'access-control-request-method': method },
    }),
  );
const allow = (res) => res.headers?.['access-control-allow-origin'];

it('lets the website check permission for the two deletion page calls', async () => {
  const lookup = await check('/v1/account', SITE, 'GET');
  expect(lookup.statusCode).toBe(204);
  expect(allow(lookup)).toBe(SITE);
  expect(lookup.headers['access-control-allow-headers']).toContain('x-account-incarnation');
  expect(lookup.headers['access-control-allow-credentials']).toBeUndefined();
  expect(allow(await check('/v1/account/delete', SITE, 'POST'))).toBe(SITE);
});

it('refuses other websites and other methods, and a check returns no data', async () => {
  const other = await check('/v1/account/delete', 'https://evil.example', 'POST');
  expect(allow(other)).toBeUndefined();
  expect(other.body).toBeUndefined();
  expect(allow(await check('/v1/account/delete', SITE, 'GET'))).toBeUndefined();
  expect(allow(await check('/v1/account', SITE, 'POST'))).toBeUndefined();
});

it('real responses carry permission only for the website on deletion routes', async () => {
  const sub = await newAccount();
  const get = (path, origin) => route(event({ method: 'GET', path, sub, headers: { origin } }));
  const account = await get('/v1/account', SITE);
  expect(allow(account)).toBe(SITE);
  expect(bodyOf(account).state).toBe('active');
  expect(allow(await get('/v1/account', 'https://evil.example'))).toBeUndefined();
  expect(allow(await get('/v1/me', SITE))).toBeUndefined();
  expect(allow(await get('/v1/goals', SITE))).toBeUndefined();
});

it('server errors on a deletion route stay readable by the website', async () => {
  const sub = await newAccount();
  const refused = await route(
    event({
      method: 'POST',
      path: '/v1/account/delete',
      sub,
      headers: { origin: SITE, 'x-account-incarnation': '00000000-0000-4000-8000-000000000000' },
    }),
  );
  expect(refused.statusCode).toBe(409);
  expect(allow(refused)).toBe(SITE);
});
