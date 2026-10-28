import { randomBytes } from 'node:crypto';
import { URL } from 'node:url';
import { battleInvite } from './battle-links.js';
import { HttpError, json } from '../lib/http.js';
import { installInviteNavigation } from './join-navigation.js';
import {
  bodyFont,
  bodyMediumFont,
  componentStyles,
  displayFont,
  guestIcon,
  versusIcon,
} from './join-page-assets.js';
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
  const destination = play?.href ?? apple?.href ?? app;
  const androidIntent = `intent://battle-invite?code=${encodeURIComponent(code)}#Intent;scheme=scrollsnooze;package=com.siddiqkolimi.scrollsnooze;${play ? `S.browser_fallback_url=${encodeURIComponent(play.href)};` : ''}end`;
  return {
    statusCode: valid ? 200 : 404,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'content-security-policy': `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; font-src data:; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    },
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="theme-color" content="#743900"><title>Join a ScrollSnooze battle</title><meta name="description" content="A little friendly competition. Join your friend on ScrollSnooze and see who scrolls less."><style nonce="${nonce}">
${componentStyles}
@font-face{font-family:Lilita;src:url("${displayFont}") format("truetype");font-weight:400;font-display:swap}
@font-face{font-family:Cabinet;src:url("${bodyFont}") format("woff2");font-weight:800;font-display:swap}
@font-face{font-family:Cabinet;src:url("${bodyMediumFont}") format("woff2");font-weight:500;font-display:swap}
:root{color-scheme:dark;--color-base-100:#743900;--color-base-content:#fffdf4;--color-primary:#ffce8c;--color-primary-content:#743900;--color-base-200:#674923;--radius-field:2rem;--border:0px;--depth:0;--noise:0}
*{box-sizing:border-box}body{margin:0;background:var(--color-base-100);color:var(--color-base-content);font-family:Cabinet,system-ui,sans-serif;font-weight:500}::selection{background:#ffce8c;color:#743900}a{color:inherit;text-underline-offset:4px}a:focus-visible{outline:3px solid #fffdf4;outline-offset:5px}
main{position:relative;isolation:isolate;max-width:640px;min-height:100svh;margin:auto;padding:22px 14px 32px;display:flex;flex-direction:column;text-align:center;overflow:hidden}
main:before{content:"";position:absolute;z-index:-1;inset:20% -100px 20%;pointer-events:none;background:radial-gradient(ellipse at 50% 45%,#e7c58c55,transparent 65%),linear-gradient(#f9d3940a 1px,transparent 1px),linear-gradient(90deg,#f9d3940a 1px,transparent 1px);background-size:auto,58px 58px,58px 58px;mask-image:linear-gradient(transparent,#000 20%,#000 72%,transparent)}
.brand{color:#ffda9f;font:400 clamp(24px,6.2vw,34px)/1.15 Lilita,system-ui,sans-serif;text-decoration:none;text-transform:uppercase;align-self:center}
h1{font-size:clamp(22px,5.6vw,34px);line-height:1.38;letter-spacing:-.015em;font-weight:800;text-wrap:balance;margin:clamp(40px,calc(8.7svh - 8px),76px) auto 0;max-width:95%;overflow-wrap:anywhere}
.stage{margin:clamp(54px,calc(10.7svh - 8px),96px) 8px 0}.bubble{position:relative;isolation:isolate;width:fit-content;max-width:100%;background:#fffff8;color:#13130f;border-radius:40px;padding:11px 22px;font-size:clamp(12px,3.2vw,18px);line-height:1.35;font-weight:500;text-align:left}.bubble:after{content:"";position:absolute;z-index:-1;bottom:-8px;left:24%;width:23px;height:18px;background:#fffff8;border-radius:0 0 100% 0;transform:skewX(-27deg)}
.duel{display:grid;grid-template-columns:minmax(0,1fr) 28px minmax(0,1fr);align-items:start;gap:30px;margin:24px 0 0}.person{min-width:0;margin:0;display:flex;align-items:center;flex-direction:column;gap:10px}.avatar>div{display:grid;place-items:center;width:clamp(72px,18.5vw,110px);height:clamp(72px,18.5vw,110px);border-radius:50%;background:#009aaa;color:white;border:2px solid #75613c;box-shadow:0 3px 5px #38200055;font:500 clamp(38px,10vw,58px)/1 Cabinet,system-ui,sans-serif}.avatar.you>div{background:#70522e;border-color:#81623566;box-shadow:none}.avatar.you img{width:90%;height:90%;object-fit:contain;transform:translateY(10%)}figcaption{font-size:clamp(13px,3.3vw,19px);font-weight:500;line-height:1.25;max-width:100%;overflow-wrap:anywhere}.versus{align-self:start;margin-top:clamp(41px,10.4vw,62px);width:18px;height:18px;justify-self:center}
.cta{margin-top:auto;padding-top:56px}.primary.btn{display:flex;align-items:center;justify-content:center;width:100%;height:auto;min-height:55px;padding:18px 20px;border:0;border-radius:999px;background:linear-gradient(#ffe8ae,#ffb96f);color:#743900;box-shadow:0 3px 5px #40210035;font:800 clamp(13px,3.3vw,18px)/1.2 Cabinet,system-ui,sans-serif;text-decoration:none;text-transform:uppercase;transition:filter .15s ease}.primary.btn:hover{filter:brightness(1.06)}.primary.btn:active{filter:brightness(.97)}
.download-status{font-size:14px;line-height:1.5;margin:14px auto 0;color:#ffdaae}.download-status[hidden]{display:none}.unavailable h1{margin-top:18svh}.recovery{max-width:34ch;align-self:center;line-height:1.6;color:#ffdaae}.unavailable .cta{padding-bottom:8px}
@media(min-width:700px){main{padding:30px 24px 40px}.stage{margin-left:12px;margin-right:12px}.bubble{padding:15px 28px}.duel{margin-top:32px}.primary.btn{min-height:70px}main:before{background-size:auto,80px 80px,80px 80px}}
@media(max-height:600px){h1{margin-top:30px}.stage{margin-top:35px}.cta{padding-top:40px}main{padding-bottom:22px}}
@media(prefers-reduced-motion:reduce){.primary.btn{transition:none}}
</style></head><body><main${valid ? '' : ' class="unavailable"'}>
<a class="brand" href="https://scrollsnooze.vercel.app" aria-label="ScrollSnooze home">ScrollSnooze</a><h1>${valid ? `${esc(name)} invited you to a<br>Scroll Battle` : 'This invitation is no longer available'}</h1>
${valid ? `<section class="stage" aria-label="Your Scroll Battle"><div class="bubble">Let’s see who scrolls less!&nbsp; 👊</div><div class="duel"><figure class="person"><div class="avatar avatar-placeholder"><div><span aria-hidden="true">${esc([...name][0]?.toUpperCase() || '?')}</span></div></div><figcaption>${esc(name)}</figcaption></figure><img class="versus" src="${versusIcon}" alt="versus"><figure class="person"><div class="avatar you"><div><img src="${guestIcon}" alt=""></div></div><figcaption>You</figcaption></figure></div></section><div class="cta"><a id="battle-action" class="btn primary" href="${esc(destination)}" data-app-url="${esc(app)}" data-android-url="${esc(androidIntent)}" data-play-url="${esc(play?.href ?? '')}" data-apple-url="${esc(apple?.href ?? '')}">Download to battle</a><p id="download-status" class="download-status" role="status" hidden></p></div>` : '<p class="recovery">It may have expired or been removed. Ask your friend to share a new link.</p>'}
</main>${valid ? `<script nonce="${nonce}">(${installInviteNavigation.toString()})();</script>` : ''}</body></html>`,
  };
}
