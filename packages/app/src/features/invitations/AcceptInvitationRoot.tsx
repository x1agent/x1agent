import { useEffect, useState } from "react";
import type { PublicInvitationView } from "@x1agent/shared";
import { AppShell } from "../../shell/AppShell";
import { Button } from "../../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { apiFetch, API_BASE } from "../../lib/api";
import { useAuthStore } from "../../stores/authStore";

interface Props {
  token: string;
}

export function AcceptInvitationRoot({ token }: Props) {
  const { user, status, fetchMe } = useAuthStore();
  const [view, setView] = useState<PublicInvitationView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);

  useEffect(() => {
    if (status === "idle") fetchMe();
  }, [status, fetchMe]);

  useEffect(() => {
    apiFetch<PublicInvitationView>(`/api/invitations/${token}`)
      .then(setView)
      .catch((err) => setLoadError((err as Error).message));
  }, [token]);

  return (
    <AppShell chrome={false}>
      <div className="flex min-h-screen items-center justify-center px-6">
        <div className="w-full max-w-md">
          {loadError ? (
            <Card>
              <CardContent className="py-6 text-sm text-red-400">
                This invitation link is not valid: {loadError}
              </CardContent>
            </Card>
          ) : !view ? (
            <Card>
              <CardContent className="py-6 text-sm text-fg-muted">
                Loading…
              </CardContent>
            </Card>
          ) : (
            renderInvitation()
          )}
        </div>
      </div>
    </AppShell>
  );

  function renderInvitation() {
    const v = view!;
    const state = v.accepted_at
      ? "accepted"
      : v.revoked_at
        ? "revoked"
        : new Date(v.expires_at).getTime() < Date.now()
          ? "expired"
          : "pending";

    if (state !== "pending") {
      return (
        <Card>
          <CardHeader>
            <CardTitle>This invitation is {state}.</CardTitle>
            <CardDescription>
              Ask the workspace admin for a fresh invite if you still need
              access.
            </CardDescription>
          </CardHeader>
        </Card>
      );
    }

    if (status === "anonymous") {
      return (
        <Card>
          <CardHeader>
            <CardTitle>Join {v.workspace.name}</CardTitle>
            <CardDescription>
              You've been invited as {v.role}. Sign in with Google as{" "}
              <span className="text-fg">{v.email}</span> to accept.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild className="w-full">
              <a href={`${API_BASE}/auth/google`}>Sign in with Google</a>
            </Button>
          </CardContent>
        </Card>
      );
    }

    const emailMatches =
      user?.email.toLowerCase() === v.email.toLowerCase();

    const onAccept = async () => {
      setSubmitError(null);
      setSubmitting(true);
      try {
        const res = await apiFetch<{ workspace_slug: string }>(
          `/api/invitations/${token}/accept`,
          { method: "POST" },
        );
        setAccepted(true);
        setTimeout(() => {
          window.location.href = `/workspaces/${res.workspace_slug}`;
        }, 600);
      } catch (err) {
        setSubmitError((err as Error).message);
      } finally {
        setSubmitting(false);
      }
    };

    if (accepted) {
      return (
        <Card>
          <CardContent className="py-6 text-sm text-fg-muted">
            Joined. Redirecting…
          </CardContent>
        </Card>
      );
    }

    return (
      <Card>
        <CardHeader>
          <CardTitle>Join {v.workspace.name}</CardTitle>
          <CardDescription>You were invited as {v.role}.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!emailMatches ? (
            <div className="text-sm text-red-400">
              This invite is for{" "}
              <span className="text-fg">{v.email}</span> but you're
              signed in as{" "}
              <span className="text-fg">{user?.email}</span>. Sign out
              and sign in with the invited account.
            </div>
          ) : (
            <Button
              disabled={submitting}
              onClick={onAccept}
              className="w-full"
            >
              {submitting ? "Accepting…" : "Accept invitation"}
            </Button>
          )}
          {submitError && (
            <div className="text-sm text-red-400">{submitError}</div>
          )}
        </CardContent>
      </Card>
    );
  }
}
