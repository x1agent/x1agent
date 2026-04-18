import { AppShell } from "../../shell/AppShell";
import { Button } from "../../components/ui/button";

export function NoAccessRoot() {
  return (
    <AppShell chrome={false}>
      <div className="flex min-h-screen items-center justify-center px-6">
        <div className="w-full max-w-sm space-y-4 text-center">
          <h1 className="text-xl font-semibold">No workspace access</h1>
          <p className="text-sm text-zinc-400">
            Your Google account is not a member of any workspace. Contact an
            administrator to get access.
          </p>
          <Button variant="link" asChild>
            <a href="/">Back to sign in</a>
          </Button>
        </div>
      </div>
    </AppShell>
  );
}
