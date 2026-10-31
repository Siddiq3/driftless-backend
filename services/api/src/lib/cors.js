import { header } from './http.js';

export const WEBSITE_ORIGIN = 'https://scrollsnooze.vercel.app';
// The public deletion page is the only browser client, and it needs only these two calls.
const BROWSER_ROUTES = { '/v1/account': 'GET', '/v1/account/delete': 'POST' };

export const isPreflight = (event, method) =>
  method === 'OPTIONS' && Boolean(BROWSER_ROUTES[event.rawPath]);

const allowed = (event, method) =>
  header(event, 'origin') === WEBSITE_ORIGIN && BROWSER_ROUTES[event.rawPath] === method;

/** A refused preflight simply carries no permission, so the browser blocks the call. */
export function preflight(event) {
  const method = header(event, 'access-control-request-method');
  return {
    statusCode: 204,
    headers: {
      vary: 'origin',
      ...(allowed(event, method)
        ? {
            'access-control-allow-origin': WEBSITE_ORIGIN,
            'access-control-allow-methods': method,
            'access-control-allow-headers': 'authorization, x-account-incarnation',
            'access-control-max-age': '300',
          }
        : {}),
    },
  };
}

export function withBrowserAccess(event, method, response) {
  if (!BROWSER_ROUTES[event.rawPath]) return response;
  return {
    ...response,
    headers: {
      ...response.headers,
      vary: 'origin',
      ...(allowed(event, method) ? { 'access-control-allow-origin': WEBSITE_ORIGIN } : {}),
    },
  };
}
