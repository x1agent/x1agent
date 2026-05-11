import { useEffect, useState } from "react";
import { Button } from "../../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { useGitIdentityStore } from "../../stores/gitIdentityStore";

/**
 * Per-user account-page section for the git identity stamped onto
 * worker commits (X1A-42).
 *
 * Manual-entry path only in this slice — two text fields plus a help
 * note that the email must be verified on the user's GitHub account.
 * GitHub-OAuth-driven discovery (which would let us pre-fill from
 * the user's verified email list) is a follow-up.
 *
 * When the user has nothing set, worker commits keep falling back to
 * `x1agent[bot]` — there's no regression, just a missing feature.
 */
export function GitIdentitySection() {
  const { identity, status, fieldError, error, saving, load, save, clear } =
    useGitIdentityStore();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [savedNotice, setSavedNotice] = useState(false);

  useEffect(() => {
    if (status === "idle") void load();
  }, [status, load]);

  // Sync local form state from the loaded identity. When the API says
  // "null", leave the inputs blank rather than wiping a partial value
  // the user may be in the middle of typing.
  useEffect(() => {
    if (identity) {
      setName(identity.name);
      setEmail(identity.email);
    }
  }, [identity]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavedNotice(false);
    const ok = await save({ name, email });
    if (ok) setSavedNotice(true);
  };

  const onClear = async () => {
    await clear();
    setName("");
    setEmail("");
    setSavedNotice(false);
  };

  const isSet = identity !== null && identity !== undefined;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Git identity</CardTitle>
        <CardDescription>
          Used as the author and committer on worker commits. When unset,
          commits attribute to <code className="text-fg">x1agent[bot]</code>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="git-name">Name</Label>
            <Input
              id="git-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Jane Doe"
              autoComplete="off"
              disabled={saving || status === "loading"}
            />
            {fieldError?.field === "git_name" && (
              <p className="text-xs text-red-400">{fieldError.message}</p>
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor="git-email">Email</Label>
            <Input
              id="git-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="jane@example.com"
              autoComplete="off"
              disabled={saving || status === "loading"}
            />
            <p className="text-xs text-fg-faint">
              Must be a verified email on the GitHub account you want commits
              attributed to. Unverified addresses still produce commits, but
              GitHub renders them as anonymous and won&apos;t link the
              avatar.
            </p>
            {fieldError?.field === "git_email" && (
              <p className="text-xs text-red-400">{fieldError.message}</p>
            )}
          </div>

          {error && (
            <p className="text-xs text-red-400">{error}</p>
          )}
          {savedNotice && !error && !fieldError && (
            <p className="text-xs text-green-400">
              Saved. New worker sessions will use this identity.
            </p>
          )}

          <div className="flex items-center gap-2">
            <Button
              type="submit"
              disabled={saving || !name.trim() || !email.trim()}
            >
              {saving ? "Saving…" : isSet ? "Update" : "Save"}
            </Button>
            {isSet && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onClear}
                disabled={saving}
              >
                Clear
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
