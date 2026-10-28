# Battle invite page design QA

final result: passed

Scope: `/join/:code`, rendered by `services/api/src/modules/join-page.js`. Reference: the first mobile screenshot supplied in the request. Comparison and review performed inline; no independent reviewer was used.

## Visual comparison

- Warm brown backdrop, soft central gold glow and grid: matched the reference direction.
- Centered two-line invitation using the real inviter name: matched the reference hierarchy and spacing.
- Left-aligned white speech bubble with a tail, teal inviter avatar, muted guest avatar, labels below and central crossed swords: matched composition.
- Full-width pill download action near the viewport bottom: matched position, palette, typography and proportions.
- Intentional adaptations: ScrollSnooze branding replaces BrainPal; the guest silhouette and swords use licensed Material Design Icons; the reference's decorative square highlights are simplified to a grid and glow.
- Per the follow-up request, the setup/downloads accordion and sharing copy have been removed. The page ends after the primary action, always labeled “Download to battle.” Android uses an app intent with Google Play fallback; iPhone tries the app and uses its configured App Store fallback. Since the iPhone app is unpublished, an absent App Store URL produces a coming-soon message.

## Browser checks

The visual redesign was captured in Chrome on the Android emulator at the sizes below before the subsequent footer removal and navigation changes. Those later changes passed code checks and navigation unit tests; they have not received another full browser pass:

| State | CSS viewport | Result |
| --- | --- | --- |
| Reference composition | 390 × 724, captured at 862 × 1600 | Pass |
| Mobile | 390 × 844 | Pass |
| Long inviter name | 320 × 640 | Pass, wraps without horizontal overflow |
| Desktop | 1280 × 900 | Pass, centered composition |
| Expired invitation | 390 × 844 | Pass, recovery copy without a download action |

Captures: `/tmp/driftless-invite-reference.png`, `/tmp/driftless-invite-mobile.png`, `/tmp/driftless-invite-long.png`, `/tmp/driftless-invite-desktop.png`, `/tmp/driftless-invite-expired.png`.

Fonts loaded in the browser; no horizontal overflow at the checked sizes. No JavaScript exceptions or blocked fonts/images. The intentional expired-page 404 is the only resource error in the capture log.

## Behavior and code checks

- Preserved Google Play install referrer and app deep link.
- Eight isolated navigation unit tests passed: Android/iPhone/iPad routing, installed-app fallback cancellation, pagehide, desktop behavior, unpublished iPhone messaging, and repeated taps.
- Verified inviter name escaping, expired status, nonce-based CSP and missing-store fallback.
- Built API Lambda bundles successfully.
- API ESLint, changed-file Prettier checks and `git diff --check` passed.
- Existing DynamoDB integration suite was not run: DynamoDB Local is not available in this session. Behavior checks use a stub inviter profile and the real page renderer; no production invite was created or accepted.

## Deployment

These are source changes and a local preview only. Public invitation URLs remain on the deployed version until the backend is deployed.
