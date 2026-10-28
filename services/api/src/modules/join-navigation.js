/* global document, navigator, window */
/** Embedded in the invite page with its CSP nonce. URLs come from escaped data attributes. */
export function installInviteNavigation() {
  const action = document.getElementById('battle-action');
  const status = document.getElementById('download-status');
  if (!action) return;

  const android = /Android/i.test(navigator.userAgent);
  const ios =
    /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const store = android ? action.dataset.playUrl : ios ? action.dataset.appleUrl : '';
  if (android) action.href = action.dataset.androidUrl;
  else if (ios) action.href = action.dataset.appUrl;

  if (!android && !ios) return;
  let fallback;
  const cancelFallback = () => {
    window.clearTimeout(fallback);
    fallback = undefined;
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') cancelFallback();
  });
  window.addEventListener('pagehide', cancelFallback);
  action.addEventListener('click', () => {
    cancelFallback();
    status.hidden = true;
    // Try the app from the user's tap. Never send an opened app on to the store
    // when its browser tab resumes; hiding/leaving the page cancels this fallback.
    fallback = window.setTimeout(() => {
      fallback = undefined;
      if (document.visibilityState !== 'visible') return;
      if (store) window.location.assign(store);
      else {
        status.textContent = ios
          ? 'ScrollSnooze for iPhone is coming soon.'
          : 'The Android download is not available yet.';
        status.hidden = false;
      }
    }, 1800);
  });
}
