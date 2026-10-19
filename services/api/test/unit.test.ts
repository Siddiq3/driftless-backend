import { describe, expect, it, vi } from 'vitest';
import { ROUTES } from '@siddiq3/driftless-contracts';
import { requireRecentAuth } from '../src/lib/auth.js';
import { log } from '../src/lib/log.js';
import { computeCapabilities } from '../src/modules/capabilities.js';
import { IMPLEMENTED } from '../src/router.js';

const pro = {
  tier: 'pro',
  source: 'play',
  state: 'active',
  expiresAt: null,
  verifiedAt: null,
} as const;
const free = {
  tier: 'free',
  source: 'none',
  state: 'none',
  expiresAt: null,
  verifiedAt: null,
} as const;
const allOn = {
  androidVideoCounting: true,
  androidMinutes: true,
  androidBlocking: true,
  iosScreenTime: true,
  advancedAnalytics: true,
};

describe('capabilities', () => {
  it('blocking and analytics require Pro even when shipped', () => {
    const c = computeCapabilities('android', free, allOn);
    expect(c).toMatchObject({
      videoCounting: true,
      blocking: false,
      schedules: false,
      advancedAnalytics: false,
    });
    expect(computeCapabilities('android', pro, allOn).blocking).toBe(true);
  });
  it('iOS never gets video counting or usage sharing, whatever the flags', () => {
    const c = computeCapabilities('ios', pro, allOn);
    expect(c.videoCounting).toBe(false);
    expect(c.socialSharingOfUsage).toBe(false);
    expect(c.minutesTracking).toBe(true);
  });
  it('a lapsed Pro state does not unlock Pro capabilities', () => {
    expect(computeCapabilities('android', { ...pro, state: 'on_hold' }, allOn).blocking).toBe(
      false,
    );
    expect(computeCapabilities('android', { ...pro, state: 'grace' }, allOn).blocking).toBe(true);
  });
});

describe('recent auth', () => {
  it('requires a fresh Google credential within the window', () => {
    expect(() => requireRecentAuth({ sub: 's', authTime: null }, 1000)).toThrow();
    expect(() => requireRecentAuth({ sub: 's', authTime: 100 }, 1000)).toThrow();
    expect(() => requireRecentAuth({ sub: 's', authTime: 900 }, 1000)).not.toThrow();
  });
});

describe('router vs contract', () => {
  it('every implemented route is declared in the shared contract', () => {
    const declared = new Set(ROUTES.map((r) => `${r.method.toUpperCase()} ${r.path}`));
    for (const k of Object.keys(IMPLEMENTED)) expect(declared.has(k)).toBe(true);
  });
});

describe('logger redaction', () => {
  it('drops sensitive keys', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    log.info('x', {
      route: 'r',
      authorization: 'Bearer abc',
      pushToken: 't',
      email: 'e@x',
      status: 200,
    });
    const line = String(spy.mock.calls[0]?.[0]);
    spy.mockRestore();
    expect(line).toContain('"route":"r"');
    expect(line).not.toMatch(/Bearer|pushToken|e@x/);
  });
});
