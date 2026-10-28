import { afterEach, expect, it, vi } from 'vitest';
import { installInviteNavigation } from '../src/modules/join-navigation.js';

afterEach(() => vi.unstubAllGlobals());
function browser(userAgent, overrides = {}) {
  const clicks = {},
    events = {},
    timers = new Map();
  let id = 0;
  const action = {
    href: 'https://play.google.com/store/apps/details?id=app',
    dataset: {
      appUrl: 'scrollsnooze://battle-invite?code=invite',
      androidUrl:
        'intent://battle-invite?code=invite#Intent;scheme=scrollsnooze;package=com.siddiqkolimi.scrollsnooze;S.browser_fallback_url=store;end',
      playUrl: 'https://play.google.com/store/apps/details?id=app&referrer=battle_invite%3Dinvite',
      appleUrl: 'https://apps.apple.com/app/id123456789',
      ...overrides,
    },
    addEventListener: (event, callback) => {
      clicks[event] = callback;
    },
  };
  const status = { hidden: true, textContent: '' };
  const document = {
    visibilityState: 'visible',
    getElementById: (id) => (id === 'battle-action' ? action : status),
    addEventListener: (event, callback) => {
      events[event] = callback;
    },
  };
  const window = {
    location: { assign: vi.fn() },
    setTimeout: (callback) => {
      timers.set(++id, callback);
      return id;
    },
    clearTimeout: (timer) => timers.delete(timer),
    addEventListener: (event, callback) => {
      events[event] = callback;
    },
  };
  vi.stubGlobal('navigator', {
    userAgent,
    platform: userAgent.includes('Macintosh') ? 'MacIntel' : '',
    maxTouchPoints: userAgent.includes('iPadDesktop') ? 5 : 0,
  });
  vi.stubGlobal('document', document);
  vi.stubGlobal('window', window);
  installInviteNavigation();
  return {
    action,
    status,
    document,
    window,
    events,
    timers,
    click: () => clicks.click(),
    expire: () => {
      const callbacks = [...timers.values()];
      timers.clear();
      callbacks.forEach((callback) => callback());
    },
  };
}
it('Android uses the package-specific app intent and its own Play fallback with referrer', () => {
  const b = browser('Mozilla/5.0 (Linux; Android 15)');
  expect(b.action.href).toBe(b.action.dataset.androidUrl);
  b.click();
  b.expire();
  expect(b.window.location.assign).toHaveBeenCalledWith(b.action.dataset.playUrl);
});
it('iPhone tries the app and falls back to the App Store, never Google Play', () => {
  const b = browser('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)');
  expect(b.action.href).toBe(b.action.dataset.appUrl);
  b.click();
  b.expire();
  expect(b.window.location.assign).toHaveBeenCalledWith(b.action.dataset.appleUrl);
});
it('opening an installed app cancels the store redirect even after returning to the browser', () => {
  const b = browser('iPhone');
  b.click();
  b.document.visibilityState = 'hidden';
  b.events.visibilitychange();
  b.document.visibilityState = 'visible';
  b.events.visibilitychange();
  b.expire();
  expect(b.window.location.assign).not.toHaveBeenCalled();
});
it('leaving the page cancels fallback when pagehide arrives before visibilitychange', () => {
  const b = browser('Android');
  b.click();
  b.events.pagehide();
  b.expire();
  expect(b.window.location.assign).not.toHaveBeenCalled();
});
it('iPad desktop user agent uses the iPhone store', () => {
  const b = browser('Mozilla/5.0 (Macintosh) iPadDesktop');
  b.click();
  b.expire();
  expect(b.window.location.assign).toHaveBeenCalledWith(b.action.dataset.appleUrl);
});
it('desktop Mac retains the ordinary download link', () => {
  const b = browser('Mozilla/5.0 (Macintosh)');
  expect(b.action.href).toContain('https://play.google.com/');
  expect(b.timers.size).toBe(0);
});
it('missing App Store listing gives an honest message instead of redirecting iPhone users to Play', () => {
  const b = browser('iPhone', { appleUrl: '' });
  b.click();
  b.expire();
  expect(b.window.location.assign).not.toHaveBeenCalled();
  expect(b.status.hidden).toBe(false);
  expect(b.status.textContent).toContain('iPhone is coming soon');
});
it('repeated taps retain only one pending store fallback', () => {
  const b = browser('Android');
  b.click();
  b.click();
  expect(b.timers.size).toBe(1);
  b.expire();
  expect(b.window.location.assign).toHaveBeenCalledTimes(1);
});
