import { randomBytes } from 'node:crypto';
import { URL } from 'node:url';
import { battleInvite } from './battle-links.js';
import { HttpError, json } from '../lib/http.js';
const esc = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const https = (value) => {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
};
export function associationFile(path) {
  if (path.endsWith('assetlinks.json')) {
    const fingerprints = (process.env.ANDROID_SIGNING_SHA256 ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^([A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2}$/.test(s));
    return json(
      200,
      fingerprints.length
        ? [
            {
              relation: ['delegate_permission/common.handle_all_urls'],
              target: {
                namespace: 'android_app',
                package_name: 'com.siddiqkolimi.scrollsnooze',
                sha256_cert_fingerprints: fingerprints,
              },
            },
          ]
        : [],
    );
  }
  const team = process.env.APPLE_TEAM_ID;
  return json(200, {
    applinks: {
      details: /^[A-Z0-9]{10}$/.test(team ?? '')
        ? [{ appIDs: [`${team}.com.siddiqkolimi.scrollsnooze`], components: [{ '/': '/join/*' }] }]
        : [],
    },
  });
}
export async function joinPage(code) {
  let name = 'Your friend',
    valid = true;
  try {
    const { profile } = await battleInvite(code);
    name = profile.displayName || profile.handle;
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    valid = false;
  }
  const nonce = randomBytes(18).toString('base64');
  const app = `scrollsnooze://battle-invite?code=${encodeURIComponent(code)}`;
  const play = https(process.env.PLAY_STORE_URL);
  const apple = https(process.env.APP_STORE_URL);
  if (play && play.hostname === 'play.google.com')
    play.searchParams.set('referrer', `battle_invite=${code}`);
  const download = (url, label) =>
    url && valid
      ? `<a class="store" href="${esc(url.href)}">${label}</a>`
      : `<span class="store disabled">${label} · coming soon</span>`;
  return {
    statusCode: valid ? 200 : 404,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'content-security-policy': `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    },
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="theme-color" content="#0b0b08"><title>Join a ScrollSnooze battle</title><meta name="description" content="A little friendly competition. Join your friend on ScrollSnooze and see who scrolls less."><style nonce="${nonce}">
*{box-sizing:border-box}body{margin:0;background:#0b0b08;color:#fff9ed;font-family:system-ui,-apple-system,sans-serif}main{max-width:560px;min-height:100svh;margin:auto;padding:32px 24px 40px;display:flex;flex-direction:column;justify-content:center;text-align:center;gap:24px;background:radial-gradient(ellipse at 50% 35%,#67401788,transparent 60%)}.brand{font-size:15px;font-weight:800;letter-spacing:.13em;color:#ffd09d;margin-bottom:28px}h1{font-size:clamp(30px,7vw,44px);line-height:1.13;letter-spacing:-1.2px;margin:0;font-weight:900}.bubble{background:#fffdf4;color:#231705;border-radius:40px;padding:18px;font-weight:700;font-size:18px;margin:8px 0}.duel{display:flex;align-items:center;justify-content:center;gap:32px;padding:12px}.avatar{width:100px;height:100px;border-radius:50%;display:grid;place-items:center;background:#008e80;color:white;font-size:48px}.avatar.you{background:#009eac}.versus{color:#ffd09d;font-size:32px}p{color:#bdb2a0;line-height:1.65;margin:0}.primary,.store,button{min-height:54px;padding:16px 22px;border-radius:32px;text-decoration:none;display:block;font:700 16px system-ui}.primary{background:linear-gradient(#ffe6ac,#ffb66a);color:#593300;box-shadow:0 10px 30px #0005}.stores{display:grid;gap:12px}.store{border:1px solid #51402b;color:#fff9ed}.disabled{opacity:.5}button{border:0;background:#282015;color:#ffd09d;width:100%;cursor:pointer}code{display:block;font-size:24px;letter-spacing:.18em;color:#ffe4ab;margin:12px}small{color:#9e9484;line-height:1.5}.steps{text-align:left;border-top:1px solid #3b2c1b;padding-top:22px}.steps p{margin-bottom:12px}</style></head><body><main>
<div class="brand">SCROLLSNOOZE</div><h1>${valid ? `${esc(name)} invited you to a Scroll Battle` : 'This invitation is no longer available'}</h1>
${valid ? `<div class="bubble">Let’s see who scrolls less! 🤜</div><div class="duel"><div class="avatar">${esc([...name][0]?.toUpperCase() || '?')}</div><span class="versus">⚔</span><div class="avatar you">You</div></div><p>A little friendly competition.<br>Less scrolling, more room for life.</p><a class="primary" href="${esc(app)}">Open ScrollSnooze</a><div class="stores">${download(play, 'Get it on Google Play')}${download(apple, 'Download on the App Store')}</div><div class="steps"><p><b>New here?</b> Download ScrollSnooze when it’s available, finish setup and sign in. Your invitation opens in the app so you can choose whether to accept.</p><p>Already installed? Tap Open ScrollSnooze. On Android, install from Google Play using the button above, then finish setup and sign in. On iPhone, reopen this invitation after installing. Your battle starts only after you tap Accept Battle in the app.</p></div><small>Accepting adds your friend and shares daily video totals from the day you join. Either person can stop sharing by removing the friend. Missing activity is never counted as zero. iPhone video counts are unavailable.</small>` : '<p>It may have expired or been removed. Ask your friend to share a new link.</p>'}
</main></body></html>`,
  };
}
