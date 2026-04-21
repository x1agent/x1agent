import { useState, type FormEvent } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { API_BASE } from "../../lib/api";

/**
 * Email + password sign-in. Shown on the landing page when the api
 * advertises `password_auth: true` on /auth/config. Coexists with the
 * Google SSO button — a user can land and pick whichever method
 * matches their credentials.
 *
 * No "forgot password" link: this deployment doesn't have SMTP, so a
 * forgotten password has to be reset by an admin via the quickstart
 * CLI. That's called out in the docs and in the landing page copy.
 */
export function PasswordSignInForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/auth/password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email: email.trim(), password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          body.error === "invalid_credentials"
            ? "Email or password is wrong."
            : body.error === "missing_fields"
              ? "Email and password are required."
              : "Sign-in failed. Please try again.",
        );
      }
      const body = (await res.json()) as { workspace_slug?: string };
      const slug = body.workspace_slug ?? "";
      window.location.href = slug ? `/workspaces/${slug}` : "/";
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-3 text-left"
      aria-label="Sign in with email and password"
    >
      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      {error && (
        <div className="text-sm text-red-400" role="alert">
          {error}
        </div>
      )}
      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
