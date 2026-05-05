import { useEffect } from "react";
import { useAuthStore } from "../../stores/authStore";
import { SignInButton } from "./SignInButton";

/**
 * Root-page gate. On mount fetch /auth/me. If the session is good,
 * jump to the user's first workspace (or /workspaces/new if they have
 * none). If anonymous, show the sign-in CTA.
 *
 * Replaces unconditionally rendering SignInButton — without this, an
 * already-logged-in user landing on `/` saw the sign-in screen even
 * though their cookie was valid.
 */
export function SignedOutGate() {
  const status = useAuthStore((s) => s.status);
  const memberships = useAuthStore((s) => s.memberships);
  const fetchMe = useAuthStore((s) => s.fetchMe);

  useEffect(() => {
    if (status === "idle") void fetchMe();
  }, [status, fetchMe]);

  useEffect(() => {
    if (status !== "authenticated") return;
    // Find the first membership whose slug is a non-empty string.
    // Defensive against a stale JWT (membership row whose workspace
    // got dropped, missing slug, etc.) — a logged-in user must never
    // land on `/workspaces/undefined`. Fall through to /workspaces/new
    // so a platform admin (or new user) can create one.
    const first = memberships.find(
      (m) => typeof m.slug === "string" && m.slug.length > 0,
    );
    const target = first ? `/workspaces/${first.slug}/` : "/workspaces/new";
    window.location.replace(target);
  }, [status, memberships]);

  if (status === "anonymous") {
    return <SignInButton />;
  }

  // status: idle | loading | authenticated (about to redirect). Render
  // a quiet placeholder so the sign-in CTA doesn't flash for logged-in
  // users between mount and the redirect taking effect.
  return (
    <div
      role="status"
      aria-live="polite"
      className="text-sm text-fg-faint"
    >
      Loading…
    </div>
  );
}
