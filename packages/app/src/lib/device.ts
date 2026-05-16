/**
 * Lightweight device-class detection. Lives in a tiny helper so every
 * caller agrees on the rule — copying `navigator.platform` checks
 * around is how this drifts.
 */

/**
 * True for iPad and Android tablets. The user-visible heuristic the
 * UI uses to decide "skip GPU-heavy continuous animations and draw
 * once" — battery and thermals on these devices punish a 60 FPS
 * shader, and operators told us the page felt slow.
 *
 * Modern iPads (iPadOS 13+) misreport themselves as macOS in
 * `userAgent`, so the canonical detection is "MacIntel + touch
 * points" — a desktop Mac never reports `maxTouchPoints > 1`.
 *
 * Returns false during SSR (no `navigator`) so the initial render
 * matches what the server emits.
 */
export function isTouchTablet(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  if (/iPad/i.test(ua)) return true;
  // iPadOS pretending to be macOS.
  if (
    navigator.platform === "MacIntel" &&
    typeof navigator.maxTouchPoints === "number" &&
    navigator.maxTouchPoints > 1
  ) {
    return true;
  }
  // Android tablets — Android + no "Mobile" token, plus a touch
  // surface. The "Mobile" exclusion is what distinguishes a tablet
  // from a phone in Android's UA convention.
  if (/Android/i.test(ua) && !/Mobile/i.test(ua)) return true;
  return false;
}
